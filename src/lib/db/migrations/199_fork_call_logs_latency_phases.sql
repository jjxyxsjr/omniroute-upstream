-- 199_fork_call_logs_latency_phases.sql (renumbered from our 163 — upstream 51
-- re-uses 163 for radar_feed_cache, and the version-uniqueness guard requires
-- every numeric prefix to be unique. Production already applied the old 163;
-- migrationRunner's isSchemaAlreadyApplied guard skips this file there.)
-- 2g (nnd.11): LiteLLM-style latency phase columns. `duration` has always been
-- end-to-end (queue wait + prefill + generation mixed); these two columns let
-- production data answer "how long until the first token" and "how long did the
-- request wait before dispatch" directly instead of reconstructing them from
-- proxy_logs. Both nullable — non-streaming requests record no ttft (LiteLLM
-- falls back to end time for those; we record null to keep the semantic clean).

ALTER TABLE call_logs ADD COLUMN ttft_ms INTEGER;
ALTER TABLE call_logs ADD COLUMN queue_wait_ms INTEGER;
CREATE INDEX IF NOT EXISTS idx_call_logs_ttft ON call_logs(ttft_ms) WHERE ttft_ms IS NOT NULL;
