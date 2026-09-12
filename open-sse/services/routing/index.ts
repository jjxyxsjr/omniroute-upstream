/**
 * Routing feedback foundation — default wiring.
 *
 * Bootstraps the default routing-event sinks:
 *   1. `MemoryRoutingEventStore` — bounded ring buffer for explainability.
 *   2. `QualityTracker` consumer — feeds the auto-combo `quality` scoring factor.
 *   3. `RoutingSqliteSink` (nnd.25) — default-on local persistence into the
 *      `routing_events` table for backend data analysis.
 *   4. Optional OTel/HTTP exporter — enabled only when an OTLP endpoint is set.
 *
 * The hot path only calls `emitRoutingEvent()`, which fans out synchronously to
 * these cheap in-memory sinks. No synchronous I/O, no external dependencies.
 *
 * This is the adapter seam Future AGI (or any evaluation backend) can plug into
 * later without becoming a dependency: an evaluator would be another
 * `RoutingEventSink` (or a consumer of the ring buffer / quality snapshot).
 */

import {
  clearRoutingEventSinks,
  dispatchRoutingEvent,
  listRoutingEventSinks,
  MemoryRoutingEventStore,
  registerRoutingEventSink,
  type RoutingEvent,
  type RoutingEventSink,
} from "./events.ts";
import {
  getProviderQuality,
  getQualityScore,
  getQualitySnapshot,
  recordQualityEvent,
  resetQualityTracker,
  setSemanticQuality,
  type ProviderQuality,
} from "./quality.ts";
import { isRoutingOtelEnabled, OtlpHttpsEventSink } from "./otel.ts";
import { RoutingSqliteSink } from "./sqliteSink.ts";

const memoryStore = new MemoryRoutingEventStore(500);

// The quality tracker is registered as a sink so it updates inline with the
// event (O(1) math) and the OTel exporter only ever enqueues.
const qualitySink: RoutingEventSink = {
  name: "quality",
  record(event: RoutingEvent): void {
    recordQualityEvent(event);
  },
};

let otelSink: OtlpHttpsEventSink | null = null;

// nnd.25 (backend analysis): local-SQLite sink — registered by DEFAULT. The
// local DB is the flush target (no endpoint to configure), so unlike the OTel
// exporter there is no env gate; it only ever enqueues on the hot path and
// drains on its own unref'd timer.
let sqliteSink: RoutingSqliteSink | null = null;

let initialized = false;

/** Register the default sinks. Idempotent; safe to call multiple times. */
export function initRoutingObservability(env: NodeJS.ProcessEnv = process.env): {
  sinks: string[];
  otelEnabled: boolean;
} {
  if (initialized) {
    return { sinks: listRoutingSinkNames(), otelEnabled: isRoutingOtelEnabled(env) };
  }
  initialized = true;

  registerRoutingEventSink(memoryStore);
  registerRoutingEventSink(qualitySink);

  // nnd.25: default-on local persistence for backend data analysis.
  sqliteSink = new RoutingSqliteSink();
  registerRoutingEventSink(sqliteSink);

  if (isRoutingOtelEnabled(env)) {
    const endpoint = (env.OMNIROUTE_OTEL_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim();
    otelSink = new OtlpHttpsEventSink({
      endpoint,
      serviceName: env.OTEL_SERVICE_NAME ?? "omniroute",
      maxBatchSize: 64,
      flushIntervalMs: 10_000,
    });
    registerRoutingEventSink(otelSink);
  }

  return { sinks: listRoutingSinkNames(), otelEnabled: otelSink != null };
}

/** Emit a routing event to all registered sinks (fire-and-forget, cheap). */
export function emitRoutingEvent(event: RoutingEvent): void {
  if (!initialized) initRoutingObservability();
  dispatchRoutingEvent(event);
}

/** Neutral default quality used when a model has no observed events. */
export function qualityScoreFor(provider: string, model: string): number {
  return getQualityScore(provider, model);
}

/** Full per-provider/model quality view (operational + semantic + confidence). */
export function providerQualityFor(provider: string, model: string): ProviderQuality {
  return getProviderQuality(provider, model);
}

/**
 * Evaluator seam: record a semantic quality score. NEVER call this from the
 * request hot path with HTTP-derived signals — semantic quality is reserved for
 * actual evaluation (task success, tool-use correctness, groundedness).
 */
export { setSemanticQuality } from "./quality.ts";

export function routingQualitySnapshot(limit = 200): ReturnType<typeof getQualitySnapshot> {
  return getQualitySnapshot(limit);
}

export { classifyQuality, type QualityClassification } from "./quality.ts";

export function recentRoutingEvents(limit = 50): RoutingEvent[] {
  return memoryStore.recent(limit);
}

export function routingOtelStats(): { buffered: number; dropped: number } | null {
  return otelSink ? otelSink.getStats() : null;
}

/** nnd.25: local-SQLite sink stats for ops dashboards (buffered/dropped/written). */
export function routingSqliteStats(): { buffered: number; dropped: number; written: number } | null {
  return sqliteSink ? sqliteSink.getStats() : null;
}

function listRoutingSinkNames(): string[] {
  return listRoutingEventSinks();
}

/** Test/ops hook: full reset of the routing observability layer. */
export function resetRoutingObservability(): void {
  clearRoutingEventSinks();
  memoryStore.clear();
  resetQualityTracker();
  if (otelSink) {
    otelSink.stop();
    otelSink = null;
  }
  if (sqliteSink) {
    sqliteSink.stop();
    sqliteSink = null;
  }
  initialized = false;
}

export type { RoutingEvent, RoutingOutcome, RoutingEventSink } from "./events.ts";
export { createRoutingEvent, outcomeFromStatus } from "./events.ts";
