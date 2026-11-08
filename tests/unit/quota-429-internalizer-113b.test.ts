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

const { classify429, buildPoolExhaustedResponse, shouldInternalize429, extractResetAtMs } = await import(
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

test("#113B nnd.41 ark MONTHLY wall (2026-11-05 00:53 production text) → single-account, never raw-leak", () => {
  const text =
    "[429]: You have exceeded the monthly usage quota. It will reset at 2026-11-20 23:59:59 +0800 CST. We recommend upgrading your plan for more quota, or waiting for the reset. Request id: 021793840026875b045cd2f7c61da91e37e7e70760c22da25d533";
  const c = classify429(text, "ark-agent-13668996989", 5);
  assert.equal(c.kind, "single-account");
  if (c.kind === "single-account") {
    assert.ok(c.resetAtMs !== null, "reset time extracted for lockout-until-reset");
    // 2026-11-20 23:59:59 +0800 = 2026-11-20T15:59:59Z — old parser said 23:59:59Z (8h off)
    assert.equal(new Date(c.resetAtMs!).toISOString(), "2026-11-20T15:59:59.000Z");
  }
});

test("#113B nnd.41 ark MONTHLY wall with ZERO remaining → pool-exhausted with +0800-aware reset", () => {
  const text = "You have exceeded the monthly usage quota. It will reset at 2026-11-20 23:59:59 +0800 CST.";
  const c = classify429(text, "ark-agent-13668996989", 0);
  assert.equal(c.kind, "pool-exhausted");
  if (c.kind === "pool-exhausted") {
    assert.equal(new Date(c.earliestResetAt!).toISOString(), "2026-11-20T15:59:59.000Z");
  }
});

test("#113B nnd.41 ark WEEKLY wall (2026-11-04 17:27 production text) → single-account", () => {
  const text =
    "[429]: You have exceeded the weekly usage quota. It will reset at 2026-11-09 00:00:00 +0800 CST. We recommend upgrading your plan for more quota, or waiting for the reset.";
  const c = classify429(text, "ark-13668996989", 3);
  assert.equal(c.kind, "single-account");
  if (c.kind === "single-account") {
    assert.equal(new Date(c.resetAtMs!).toISOString(), "2026-11-08T16:00:00.000Z");
  }
});

test("#113B nnd.41 future window phrasing (daily etc.) covered by generic wall pattern", () => {
  assert.equal(classify429("You have exceeded the daily usage quota. It will reset at 2026-11-06 00:00:00 +0800 CST.", "ark-x", 2).kind, "single-account");
});

test("#113B nnd.41 extractResetAtMs: no-offset text stays UTC", () => {
  assert.equal(extractResetAtMs("reset at 2026-11-04T16:01:23Z"), Date.parse("2026-11-04T16:01:23Z"));
  assert.equal(extractResetAtMs("no timestamp here"), null);
});

test("#113B unknown 429 text → not-quota (don't internalize blindly)", () => {
  const c = classify429("Something else went wrong", "some-account", 5);
  assert.equal(c.kind, "not-quota");
});

test("#113B internalize: single-account and rate-limit → true; pool-exhausted and not-quota → false", () => {
  assert.equal(shouldInternalize429({ kind: "single-account", account: "a", resetHint: "x", resetAtMs: null }), true);
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
  // nnd.42 wording: model-level truth (quota-walled candidates + UTC+8 reset)
  // instead of the old misleading "Pool recovers ~…min" (see #216 note).
  assert.ok(r.message.includes("quota-walled"), "says the candidates are quota-walled");
  assert.ok(r.message.includes("UTC+8"), "reset shown in the requester's timezone");
  assert.ok(r.message.includes("Other models may still be available"), "points at other models");
});

test("#113B pool-exhausted response handles null reset gracefully", () => {
  const r = buildPoolExhaustedResponse("pro", null);
  assert.ok(r.message.includes("cooling down"));
});

// ── nnd.42 additions ────────────────────────────────────────────────────────

test("#113B nnd.42: ark burst-protection text → rate-limit (short backoff, never a wall)", () => {
  const c = classify429(
    "[429]: System protection triggered by request burst. Please slow down traffic growth and increase requests gradually before retrying. Request id: x",
    "ark-13668996989",
    5
  );
  assert.equal(c.kind, "rate-limit");
});

test("#113B nnd.42: GLM [1308] bare timestamp is Beijing local (lock PAST reset, never before)", () => {
  // Production shape 2026-10-30: "您的限额将在 2026-10-30 18:50:24 重置" — no zone suffix.
  // Old parser read it as UTC → lock ended 8h early (5h wall released before the wall).
  const got = extractResetAtMs("[1308][已达到 5 小时的使用上限。您的限额将在 2026-10-30 18:50:24 重置。]");
  assert.equal(got, Date.parse("2026-10-30T18:50:24+08:00"));
});

test("#113B nnd.42: Z-suffixed ISO stays UTC (regression guard for the +08:00 default)", () => {
  assert.equal(extractResetAtMs("reset at 2026-11-04T16:01:23Z"), Date.parse("2026-11-04T16:01:23Z"));
});

test("#226 nnd.42c: GLM [1301] content moderation is a body-specific STOP (no account fan-out)", async () => {
  const { comboTargetDecision } = await import("../../open-sse/services/combo/statusDecisionTable.ts");
  const glm1301 = "[400]: [1301][系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语，感谢您的配合。][20261107173925164708c43cf34cea]";
  assert.equal(comboTargetDecision(400, glm1301), "stop");
  // Unrelated 400s still advance (no blanket rule).
  assert.equal(comboTargetDecision(400, "model xyz not supported"), "advance");
});
