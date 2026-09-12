/**
 * Backend Analysis persistence (nnd.25).
 *
 * DAO for the two tables created by migration 178_backend_analysis:
 *  - `routing_events`: durable per-request routing outcomes, written in batches
 *    by RoutingSqliteSink (open-sse/services/routing/sqliteSink.ts). The
 *    in-memory comboMetrics and the async call_logs row each cover part of
 *    this; neither gives post-hoc SQL over outcome/ttft/itl/latency/retries.
 *  - `runtime_state_snapshots`: periodic samples of process-local state
 *    (model lockouts, circuit breakers, admission semaphores) from
 *    open-sse/services/runtimeStateSnapshots.ts.
 *
 * Follows the compressionRunTelemetry discipline: inserts are best-effort at
 * the call-site contract level (callers wrap in try/catch), the tables
 * self-heal via CREATE TABLE IF NOT EXISTS, and no raw SQL escapes this module.
 *
 * @module lib/db/backendAnalysis
 */

import { getDbInstance } from "./core";

/** Row shape for a routing_events INSERT (snake_case columns, ts ISO string). */
export interface RoutingEventRow {
  ts: string;
  requestId: string | null;
  provider: string;
  model: string;
  strategy: string;
  outcome: string;
  status: number | null;
  latencyMs: number;
  ttftMs: number | null;
  itlMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  retries: number;
  fallbackUsed: boolean;
  finishReason: string | null;
  connectionId: string | null;
}

/** Row shape for a runtime_state_snapshots INSERT (state is a JSON string). */
export interface RuntimeStateSnapshotRow {
  ts: string;
  kind: string;
  entity: string | null;
  state: string;
}

/**
 * Self-heal both tables. CREATE TABLE IF NOT EXISTS is idempotent and cheap —
 * the owning migration is 178, but a DB opened mid-upgrade or a reset test dir
 * must not turn a telemetry flush into a crash.
 */
export function ensureBackendAnalysisTables(): void {
  const db = getDbInstance();
  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      request_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      strategy TEXT NOT NULL,
      outcome TEXT NOT NULL,
      status INTEGER,
      latency_ms INTEGER, ttft_ms INTEGER, itl_ms INTEGER,
      input_tokens INTEGER, output_tokens INTEGER,
      retries INTEGER, fallback_used INTEGER NOT NULL DEFAULT 0,
      finish_reason TEXT, connection_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_routing_events_ts ON routing_events(ts);
    CREATE INDEX IF NOT EXISTS idx_routing_events_outcome ON routing_events(outcome, ts);
    CREATE TABLE IF NOT EXISTS runtime_state_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      entity TEXT,
      state TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_state_ts ON runtime_state_snapshots(ts);
  `);
}

/**
 * Batch-insert routing events in one transaction. Returns the number of rows
 * written. Throws on SQLite failure so the caller can account the loss — never
 * call this from the request hot path (the sink flushes on a timer).
 */
export function insertRoutingEventRows(rows: RoutingEventRow[]): number {
  if (rows.length === 0) return 0;
  const db = getDbInstance();
  ensureBackendAnalysisTables();
  const stmt = db.prepare(
    `INSERT INTO routing_events (
       ts, request_id, provider, model, strategy, outcome, status,
       latency_ms, ttft_ms, itl_ms, input_tokens, output_tokens,
       retries, fallback_used, finish_reason, connection_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAll = db.transaction(() => {
    for (const row of rows) {
      stmt.run(
        row.ts,
        row.requestId ?? null,
        row.provider,
        row.model,
        row.strategy,
        row.outcome,
        row.status ?? null,
        row.latencyMs,
        row.ttftMs ?? null,
        row.itlMs ?? null,
        row.inputTokens ?? null,
        row.outputTokens ?? null,
        row.retries,
        row.fallbackUsed ? 1 : 0,
        row.finishReason ?? null,
        row.connectionId ?? null
      );
    }
  });
  insertAll();
  return rows.length;
}

/** Insert one runtime-state snapshot row. Throws on failure (caller decides). */
export function insertRuntimeStateSnapshot(row: RuntimeStateSnapshotRow): void {
  const db = getDbInstance();
  ensureBackendAnalysisTables();
  db.prepare(
    "INSERT INTO runtime_state_snapshots (ts, kind, entity, state) VALUES (?, ?, ?, ?)"
  ).run(row.ts, row.kind, row.entity ?? null, row.state);
}
