/**
 * 2a — the legacy 120s execution deadline must scale for large non-streaming
 * generations. 2026-09-01: a vision request with max_tokens=32768 (non-stream)
 * was killed at exactly 120s while the upstream was legitimately generating;
 * the client saw 504 ten times in a row. Streaming keeps the base deadline
 * (token output should keep the stream alive); non-streaming scales with the
 * requested output budget at a conservative ~50 tok/s decode floor, capped at
 * 15 minutes. OMNIROUTE_EXECUTION_EXPIRATION_MS is an ops override (0 = no
 * deadline at all).
 */
import test from "node:test";
import assert from "node:assert/strict";

const { computeNonStreamExecutionExpirationMs, computeStreamingExecutionExpirationMs } = await import(
  "../../open-sse/services/rateLimitManager.ts"
);

test("2a large max_tokens scales the deadline past the 120s base", () => {
  const ms = computeNonStreamExecutionExpirationMs(120_000, 32_768, {});
  assert.equal(ms, 32_768 * 20, "32768 tok at 20ms/tok floor");
});

test("2a small max_tokens keeps the base deadline", () => {
  assert.equal(computeNonStreamExecutionExpirationMs(120_000, 1024, {}), 120_000);
});

test("2a deadline is capped at 15 minutes", () => {
  const ms = computeNonStreamExecutionExpirationMs(120_000, 1_000_000, {});
  assert.equal(ms, 900_000);
});

test("2a env override wins over computation", () => {
  assert.equal(computeNonStreamExecutionExpirationMs(120_000, 32_768, { OMNIROUTE_EXECUTION_EXPIRATION_MS: "600000" }), 600_000);
  assert.equal(computeNonStreamExecutionExpirationMs(120_000, 32_768, { OMNIROUTE_EXECUTION_EXPIRATION_MS: "0" }), 0);
});

test("2a junk env falls back to computation", () => {
  assert.equal(
    computeNonStreamExecutionExpirationMs(120_000, 32_768, { OMNIROUTE_EXECUTION_EXPIRATION_MS: "junk" }),
    32_768 * 20
  );
});

test("nnd.24① streaming deadline keeps the full headers-phase budget", () => {
  // Prod shape: pooled 45s probe + fresh 120s + 5s slack = 170s. The legacy
  // `?? maxWaitMs` fallback (120s) sat below the 165s two-door tail and
  // killed fresh-socket waits >75s.
  assert.equal(computeStreamingExecutionExpirationMs(170_000, {}), 170_000);
  assert.equal(computeStreamingExecutionExpirationMs(165_000, {}), 165_000);
});

test("nnd.24① streaming env override wins (incl. 0 = off)", () => {
  assert.equal(
    computeStreamingExecutionExpirationMs(170_000, { OMNIROUTE_EXECUTION_EXPIRATION_MS: "600000" }),
    600_000
  );
  assert.equal(
    computeStreamingExecutionExpirationMs(170_000, { OMNIROUTE_EXECUTION_EXPIRATION_MS: "0" }),
    0
  );
});
