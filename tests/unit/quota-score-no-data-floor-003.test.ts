// 003-arkscore: scoreResetAwareQuota's no-quota-data fallback must floor at
// 0.05 (not the upstream 0.5). Providers without a quota fetcher (Ark) sit on
// this path; a 0.5 default outranks every real GLM session score (~0.45 cap)
// and pins traffic to an account whose true capacity is unknown. With 0.05 the
// no-data account only wins when every scored account is exhausted (-Infinity
// or below 0.05). Mirrors hotpatch 003 already deployed in the production
// container (deploy docs/060, 2026-08-20 entry).
import test from "node:test";
import assert from "node:assert/strict";

const { resolveResetAwareConfig, scoreResetAwareQuota } = await import(
  "../../open-sse/services/combo/quotaScoring.ts"
);

const config = resolveResetAwareConfig(null);

test("no quota data floors at 0.05, not 0.5 (003-arkscore)", () => {
  for (const quota of [null, undefined, 42, "quota"]) {
    const { score } = scoreResetAwareQuota(quota, config);
    assert.equal(score, 0.05, `expected 0.05 floor for ${JSON.stringify(quota)}`);
  }
});

test("limitReached still short-circuits to -Infinity (upstream behavior unchanged)", () => {
  const { score } = scoreResetAwareQuota({ limitReached: true }, config);
  assert.equal(score, -Infinity);
});

test("real quota data still scores above the no-data floor", () => {
  const now = Date.now();
  const quota = {
    percentUsed: 0.05,
    window5h: { percentUsed: 0.05, resetAt: new Date(now + 4 * 3600_000).toISOString() },
  };
  const { score } = scoreResetAwareQuota(quota, config);
  assert.ok(score > 0.05, `scored account (${score}) must outrank the 0.05 no-data floor`);
});
