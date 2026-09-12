/**
 * nnd.25 (backend analysis): local SQLite routing-event sink.
 *
 * A `RoutingEventSink` that persists routing events into the local
 * `routing_events` table (migration 178) so backend data analysis has a
 * durable, SQL-queryable outcome base. Structured after `otel.ts`:
 *  - `record()` only enqueues into a bounded buffer (O(1), never I/O in the
 *    request hot path). When the buffer is full the OLDEST events are dropped
 *    and counted — never backpressure the data plane.
 *  - A single background timer (unref'd, default 5s) drains the buffer in one
 *    transactional batch via the src/lib/db/backendAnalysis DAO.
 *  - Registered by default from initRoutingObservability() — unlike the OTel
 *    exporter there is no endpoint to configure; the local DB is the target.
 *  - No secrets/prompts are ever serialized; only RoutingEvent metadata.
 */

import type { RoutingEvent, RoutingEventSink } from "./events.ts";
import { insertRoutingEventRows, type RoutingEventRow } from "../../../src/lib/db/backendAnalysis";

export interface RoutingSqliteSinkOptions {
  /** Bounded in-memory buffer cap. At/over cap the oldest events are dropped. */
  maxBufferedEvents?: number;
  /** Background flush cadence. The timer is unref'd so it never hangs exit. */
  flushIntervalMs?: number;
}

/** Default bound — matches the explainability ring buffer size in events.ts. */
const DEFAULT_MAX_BUFFERED_EVENTS = 500;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

/** Map a RoutingEvent onto the routing_events row shape (ts epoch-ms → ISO). */
export function toRoutingEventRow(event: RoutingEvent): RoutingEventRow {
  return {
    ts: new Date(event.ts).toISOString(),
    requestId: event.requestId ?? null,
    provider: event.provider || "unknown",
    model: event.model || "unknown",
    strategy: event.strategy || "direct",
    outcome: event.outcome,
    status: event.status ?? null,
    latencyMs: Math.max(0, event.latencyMs || 0),
    ttftMs: event.ttftMs ?? null,
    itlMs: event.itlMs ?? null,
    inputTokens: event.inputTokens ?? null,
    outputTokens: event.outputTokens ?? null,
    retries: event.retries ?? 0,
    fallbackUsed: event.fallbackUsed === true,
    finishReason: event.finishReason ?? null,
    connectionId: event.connectionId ?? null,
  };
}

export class RoutingSqliteSink implements RoutingEventSink {
  readonly name = "sqlite";
  private readonly maxBufferedEvents: number;
  private buffer: RoutingEvent[] = [];
  private dropped = 0;
  private written = 0;
  private consecutiveFlushFailures = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RoutingSqliteSinkOptions = {}) {
    this.maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    const intervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.timer = setInterval(() => this.flush(), intervalMs);
    // Do not keep the process alive just for telemetry.
    this.timer.unref?.();
  }

  /** O(1) enqueue; drops oldest when the buffer is full. Never performs I/O. */
  record(event: RoutingEvent): void {
    if (this.buffer.length >= this.maxBufferedEvents) {
      this.buffer.shift();
      this.dropped += 1;
    }
    this.buffer.push(event);
  }

  getStats(): { buffered: number; dropped: number; written: number } {
    return { buffered: this.buffer.length, dropped: this.dropped, written: this.written };
  }

  /**
   * Drain the buffer into routing_events. Synchronous by design (better-sqlite3
   * is sync; the batch is one transaction). On failure the batch is dropped and
   * counted — a broken local DB must not accumulate an unbounded retry backlog.
   */
  flush(): number {
    if (this.buffer.length === 0) return 0;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      const count = insertRoutingEventRows(batch.map(toRoutingEventRow));
      this.written += count;
      this.consecutiveFlushFailures = 0;
      return count;
    } catch (err: unknown) {
      this.dropped += batch.length;
      this.consecutiveFlushFailures += 1;
      // Throttle: warn on the first failure and then only every 100th, so a
      // persistently unavailable DB cannot spam the log every 5 seconds.
      if (this.consecutiveFlushFailures === 1 || this.consecutiveFlushFailures % 100 === 0) {
        console.warn(
          `[RoutingSqliteSink] flush failed (consecutive=${this.consecutiveFlushFailures}, ` +
            `dropped=${this.dropped}):`,
          err instanceof Error ? err.message : err
        );
      }
      return 0;
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}
