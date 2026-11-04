/**
 * #113-B — 429 quota-wall internalization.
 *
 * Operator's pool principle: single-account 429 must never surface to the
 * client. These tests pin the classification of 429 subtypes (quota wall /
 * rate limit / other), the internalization decision, and the clean
 * pool-exhausted response building.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { classify429, buildPoolExhaustedResponse, shouldInternalize429 } = await import(
  "../../open-sse/services/combo/quota429Internalizer.ts"
);

test("#113B GLM [1308] 5h wall with remaining targets → single-account (internalize)", () => {
  const c = classify429("[429]: [1308][已达到 5 小时的使用上限。您的限额将在 2026-11-04 16:01:23 重置。]", "nnd_13378616203", 5);
  assert.equal(c.kind, "single-account");
  if (c.kind === "single-account") assert.equal(c.account, "nnd_13378616203");
});

test("#113B ark 5h wall with remaining targets → single-account (internalize)", () => {
  const c = classify429("You have exceeded the 5-hour usage quota. It will reset at 2026-11-04T16:01:23Z", "ark-13668996989", 3);
  assert.equal(c.kind, "single-account");
});

test("#113B GLM [1308] with ZERO remaining targets → pool-exhausted (surface clean 429)", () => {
  const c = classify429("[429]: [1308][已达到 5 小时的使用上限。您的限额将在 2026-11-04 16:01:23 重置。]", "nnd_18002621535", 0);
  assert.equal(c.kind, "pool-exhausted");
  if (c.kind === "pool-exhausted") {
    assert.ok(c.earliestResetAt !== null, "reset time extracted");
  }
});

test("#113B GLM [1302] rate limit → rate-limit (internalize with short backoff)", () => {
  const c = classify429("[429]: [1302][您的账户已达到速率限制，请您控制请求频率]", "nnd_13360006821", 5);
  assert.equal(c.kind, "rate-limit");
});

test("#113B unknown 429 text → not-quota (don't internalize blindly)", () => {
  const c = classify429("Something else went wrong", "some-account", 5);
  assert.equal(c.kind, "not-quota");
});

test("#113B internalize: single-account and rate-limit → true; pool-exhausted and not-quota → false", () => {
  assert.equal(shouldInternalize429({ kind: "single-account", account: "a", resetHint: "x" }), true);
  assert.equal(shouldInternalize429({ kind: "rate-limit", account: "a", retryAfterMs: 5000 }), true);
  assert.equal(shouldInternalize429({ kind: "pool-exhausted", earliestResetAt: null, exhaustedAccounts: [] }), false);
  assert.equal(shouldInternalize429({ kind: "not-quota", reason: "x" }), false);
});

test("#113B pool-exhausted response includes combo name and reset hint", () => {
  const resetAt = Date.now() + 300_000;
  const r = buildPoolExhaustedResponse("max", resetAt);
  assert.equal(r.status, 429);
  assert.equal(r.code, "POOL_EXHAUSTED");
  assert.ok(r.message.includes("max"));
  assert.ok(r.message.includes("min"));
  assert.ok(r.message.includes("pool-level"), "explains it's pool-level, not per-account");
});

test("#113B pool-exhausted response handles null reset gracefully", () => {
  const r = buildPoolExhaustedResponse("pro", null);
  assert.ok(r.message.includes("cooling down"));
});
