// 003-arkscore (003b): scoreResetAwareQuota's no-quota-data fallback defaults to
// 0.35 (conservative: joins the 30% tie band only once the best GLM account is
// ~half drained) and is dialable via OMNIROUTE_RESET_AWARE_NO_QUOTA_FLOOR —
// 0.65 puts a no-fetcher provider inside the band against HEALTHY accounts
// (sessionWeight=1 scores ~0.9+), giving it a standing rotation share without a
// rebuild. limitReached still short-circuits to -Infinity. Mirrors the 003b
// source patch (deploy docs/060, 2026-08-24 late entry).
import test from "node:test";
import assert from "node:assert/strict";

const { resolveResetAwareConfig, scoreResetAwareQuota } = await import(
  "../../open-sse/services/combo/quotaScoring.ts"
);

const config = resolveResetAwareConfig(null);
// Production-tuned weights (resetAwareSessionWeight=1.0/resetAwareWeeklyWeight=0.0
// — every live combo runs these, deploy memory omniroute-routing-config-20260817).
const tunedConfig = resolveResetAwareConfig({
  resetAwareSessionWeight: 1,
  resetAwareWeeklyWeight: 0,
});

test("no quota data defaults to the 0.35 floor (003-arkscore 003b)", () => {
  for (const quota of [null, undefined, 42, "quota"]) {
    const { score } = scoreResetAwareQuota(quota, config);
    assert.equal(score, 0.35, `expected 0.35 floor for ${JSON.stringify(quota)}`);
  }
});

test("OMNIROUTE_RESET_AWARE_NO_QUOTA_FLOOR overrides the floor (003b dial)", () => {
  process.env.OMNIROUTE_RESET_AWARE_NO_QUOTA_FLOOR = "0.65";
  try {
    const { score } = scoreResetAwareQuota(null, config);
    assert.equal(score, 0.65, "env dial must set the no-data floor");
  } finally {
    delete process.env.OMNIROUTE_RESET_AWARE_NO_QUOTA_FLOOR;
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
