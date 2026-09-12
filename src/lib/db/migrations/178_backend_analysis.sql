-- 178_backend_analysis.sql
-- nnd.25 (backend analysis batch): local-telemetry foundation tables.
-- `routing_events` is the flush target of RoutingSqliteSink (bounded buffer +
-- periodic batch INSERT in open-sse/services/routing/sqliteSink.ts) — the
-- durable per-request outcome record (outcome/ttft/itl/latency/tokens/
-- retries/fallback) the in-memory comboMetrics and the async call_logs row
-- each only partially cover. `runtime_state_snapshots` receives periodic
-- samples of otherwise process-local state (model lockouts, circuit breakers,
-- admission semaphores) from open-sse/services/runtimeStateSnapshots.ts, so
-- post-hoc incident analysis can see what the router believed at the time.
-- `call_logs.error_raw_head` keeps a truncated raw upstream error head for
-- classification audits without paying full-body storage on every log row.

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
ALTER TABLE call_logs ADD COLUMN error_raw_head TEXT;
