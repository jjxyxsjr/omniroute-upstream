/**
 * #116 — request lifecycle phase tracking.
 *
 * Every slow request should be attributable to a specific phase (queue /
 * dispatch / upstream connect / prefill / generation) instead of guessing
 * "upstream is slow." These tests pin: phase transitions, timestamp capture,
 * in-flight registry add/remove, phase breakdown arithmetic, cache warmth
 * prediction fields, and the safety guarantee that instrumentation never
 * throws.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  createLifecycle, markPhase, markFailed, setDispatchInfo,
  getInflightSnapshot, computePhaseBreakdown,
} = await import("../../open-sse/handlers/chatCore/requestLifecycle.ts");

const T0 = 1_700_000_000_000; // arbitrary epoch ms

function fakeNow(offset: number) { return T0 + offset; }

test("#116 lifecycle: created in queued phase with correct metadata", () => {
  const lc = createLifecycle("req-1", { user: "tester", model: "glm-5.3", combo: "max", account: "nnd_001" });
  assert.equal(lc.phase, "queued");
  assert.equal(lc.user, "tester");
  assert.equal(lc.model, "glm-5.3");
  assert.equal(lc.combo, "max");
  assert.equal(lc.cacheWarmth, "unknown");
  assert.equal(lc.predictedTtftMs, null);
});

test("#116 lifecycle: phase transitions update timestamps and registry", () => {
  const lc = createLifecycle("req-2", { user: "u", model: "m" });
  assert.ok(getInflightSnapshot().some(x => x.id === "req-2"), "in in-flight registry");

  markPhase(lc, "admitted");
  assert.equal(lc.phase, "admitted");
  assert.ok(typeof lc.timestamps.admitted === "number");

  markPhase(lc, "dispatched");
  assert.ok(typeof lc.timestamps.dispatched === "number");

  markPhase(lc, "completed");
  assert.equal(lc.phase, "completed");
  assert.ok(typeof lc.timestamps.completed === "number");
  // completed requests are removed from in-flight
  assert.ok(!getInflightSnapshot().some(x => x.id === "req-2"), "removed from registry");
});

test("#116 lifecycle: markFailed sets error and removes from registry", () => {
  const lc = createLifecycle("req-3", { user: "u", model: "m" });
  markFailed(lc, "upstream timeout after 180s");
  assert.equal(lc.phase, "failed");
  assert.ok(lc.errorSummary?.includes("timeout"));
  assert.ok(!getInflightSnapshot().some(x => x.id === "req-3"));
});

test("#116 lifecycle: setDispatchInfo populates prediction fields", () => {
  const lc = createLifecycle("req-4", { user: "u", model: "m" });
  setDispatchInfo(lc, {
    account: "nnd_123",
    combo: "max",
    estimatedTokensIn: 280_000,
    cacheWarmth: "cold",
    predictedTtftMs: { p50: 25_000, p90: 60_000 },
  });
  assert.equal(lc.account, "nnd_123");
  assert.equal(lc.estimatedTokensIn, 280_000);
  assert.equal(lc.cacheWarmth, "cold");
  assert.deepEqual(lc.predictedTtftMs, { p50: 25_000, p90: 60_000 });
});

test("#116 lifecycle: computePhaseBreakdown produces correct arithmetic", () => {
  const lc = createLifecycle("req-5", { user: "u", model: "m" });
  // Manually set timestamps for deterministic test
  lc.timestamps.admitted = T0;
  lc.timestamps.dispatched = T0 + 100;       // queued 100ms
  lc.timestamps.connected = T0 + 100 + 2000; // connect 2s
  lc.timestamps.firstEvent = T0 + 100 + 2000 + 45_000; // prefill 45s (cold cache)
  lc.timestamps.firstContent = T0 + 100 + 2000 + 45_000 + 500; // 0.5s gap
  lc.timestamps.completed = T0 + 100 + 2000 + 45_000 + 500 + 12_000; // gen 12s

  const bd = computePhaseBreakdown(lc);
  assert.ok(bd);
  assert.equal(bd.queueMs, 100);
  assert.equal(bd.connectMs, 2000);
  assert.equal(bd.prefillMs, 45_000);
  assert.equal(bd.firstByteGapMs, 500);
  assert.equal(bd.generationMs, 12_000);
  assert.equal(bd.totalMs, 100 + 2000 + 45_000 + 500 + 12_000);
});

test("#116 lifecycle: computePhaseBreakdown returns null for incomplete lifecycle", () => {
  const lc = createLifecycle("req-6", { user: "u", model: "m" });
  assert.equal(computePhaseBreakdown(lc), null);
});

test("#116 lifecycle: snapshot includes phase age and prediction info", () => {
  const lc = createLifecycle("req-7", { user: "alice", model: "glm-5.3", combo: "max" });
  setDispatchInfo(lc, { cacheWarmth: "cold", predictedTtftMs: { p50: 20_000, p90: 45_000 }, estimatedTokensIn: 150_000 });
  markPhase(lc, "dispatched");

  const snap = getInflightSnapshot().find(x => x.id === "req-7");
  assert.ok(snap);
  assert.equal(snap.phase, "dispatched");
  assert.equal(snap.cacheWarmth, "cold");
  assert.equal(snap.estimatedTokensIn, 150_000);
  assert.ok(snap.phaseAgeMs >= 0, "phase age is non-negative");
  assert.ok(snap.ageMs >= snap.phaseAgeMs, "total age >= phase age");

  markPhase(lc, "completed");
});

test("#116 lifecycle: instrumentation never throws even with bad input", () => {
  // null lifecycle — markPhase should not throw
  try { markPhase(null as any, "completed"); } catch { assert.fail("markPhase threw on null"); }
  try { markFailed(null as any, "x"); } catch { assert.fail("markFailed threw on null"); }
  try { setDispatchInfo(null as any, {}); } catch { assert.fail("setDispatchInfo threw on null"); }
  try { computePhaseBreakdown(null as any); } catch { assert.fail("computePhaseBreakdown threw on null"); }
});
