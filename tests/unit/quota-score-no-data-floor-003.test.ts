// 003-arkscore (003b): scoreResetAwareQuota's no-quota-data fallback sits at
// 0.35 — inside the 30% tie band below healthy GLM session scores (~0.40-0.45)
// so no-fetcher providers (Ark) get a bounded rotation share instead of the
// upstream 0.5 (which pinned traffic) or the first cut's 0.05 (which starved
// them completely). limitReached still short-circuits to -Infinity so a
// hard-capped account never wins. Mirrors the 003b source patch (deploy
// docs/060, 2026-08-24 late entry).
import test from "node:test";
import assert from "node:assert/strict";

const { resolveResetAwareConfig, scoreResetAwareQuota } = await import(
  "../../open-sse/services/combo/quotaScoring.ts"
);

const config = resolveResetAwareConfig(null);
// Production-tuned weights (sessionWeight=1.0/weeklyWeight=0.0 — every live
// combo runs these, deploy memory omniroute-routing-config-20260817). With the
// upstream DEFAULT weights (0.35/0.65) a 95%-remaining account scores ~0.34,
// i.e. below the 0.35 floor — the floor's tie-band semantics are only sound
// under the tuned weights, which is how every production combo is configured.
const tunedConfig = resolveResetAwareConfig({
  resetAwareSessionWeight: 1,
  resetAwareWeeklyWeight: 0,
});

test("no quota data floors at 0.35, not the upstream 0.5 (003-arkscore 003b)", () => {
  for (const quota of [null, undefined, 42, "quota"]) {
    const { score } = scoreResetAwareQuota(quota, config);
    assert.equal(score, 0.35, `expected 0.35 floor for ${JSON.stringify(quota)}`);
  }
});

test("limitReached still short-circuits to -Infinity (upstream behavior unchanged)", () => {
  const { score } = scoreResetAwareQuota({ limitReached: true }, config);
  assert.equal(score, -Infinity);
});

test("real quota data still scores above the no-data floor (tuned weights)", () => {
  const now = Date.now();
  const quota = {
    percentUsed: 0.05,
    window5h: { percentUsed: 0.05, resetAt: new Date(now + 4 * 3600_000).toISOString() },
  };
  const { score } = scoreResetAwareQuota(quota, tunedConfig);
  assert.ok(score > 0.35, `scored account (${score}) must outrank the 0.35 no-data floor`);
});
