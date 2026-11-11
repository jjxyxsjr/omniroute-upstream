/**
 * nnd.44 ① (iid 231): windowAnchorGuard pure classification + the planned
 * blackout encoding discriminator. Pure logic only — no DB, no scheduler.
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  classifyAnchorPlan,
  isInsideAnchorActionWindow,
  resolveWindowAnchorGuardConfig,
} = await import("../../src/sse/services/windowAnchorGuard.ts");
const { isPlannedBlackoutRateLimitedUntil } = await import(
  "../../open-sse/services/accountFallback.ts"
);

// 2026-11-12T02:00:00+08:00 = 2026-11-11T18:00:00Z — 02:00 Beijing.
const NOW_MS = Date.parse("2026-11-11T18:00:00Z");
const CONFIG = resolveWindowAnchorGuardConfig({});

function atBeijing(hhmm: string, dayOffsetDays = 0): number {
  // Base midnight is the BJ day of NOW (2026-11-12T00:00+08:00).
  return Date.parse("2026-11-12T00:00:00+08:00") + dayOffsetDays * 86400_000 + hhToMs(hhmm);
}
function hhToMs(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h * 60 + m) * 60_000;
}

test("config defaults mirror the operator-ratified guard shape", () => {
  const config = resolveWindowAnchorGuardConfig({});
  assert.deepEqual(config.providers, ["glm-cn"]);
  assert.equal(config.timezone, "Asia/Shanghai");
  assert.equal(config.anchorMinute, 360); // 06:00
  assert.equal(config.releaseMinute, 355); // 05:55
  assert.equal(config.leadMinutes, 15);
  assert.equal(config.windowMs, 5 * 3_600_000);
});

test("action window is [00:45, 06:00) Beijing by default", () => {
  assert.equal(isInsideAnchorActionWindow(44, CONFIG), false);
  assert.equal(isInsideAnchorActionWindow(45, CONFIG), true);
  assert.equal(isInsideAnchorActionWindow(300, CONFIG), true);
  assert.equal(isInsideAnchorActionWindow(359, CONFIG), true);
  assert.equal(isInsideAnchorActionWindow(360, CONFIG), false);
});

test("R NULL or stale parks the idle account from night start (00:55)", () => {
  for (const resetAtMs of [null, NOW_MS - 1, NOW_MS + 6 * 3_600_000]) {
    const plan = classifyAnchorPlan({
      nowMs: NOW_MS,
      config: CONFIG,
      nowMinuteOfDay: 120, // 02:00 BJ
      resetAtMs,
    });
    assert.equal(plan.kind, "ban", `reset=${resetAtMs}`);
    if (plan.kind === "ban") {
      // 00:55 the same BJ night
      assert.equal(plan.fromMs, atBeijing("00:55"));
      assert.equal(plan.releaseMs, atBeijing("05:55"));
    }
  }
});

test("R in the danger zone bans from R minus lead minutes", () => {
  // R=02:05 → banFrom=01:50, already past now (02:00) → immediate ban
  const reset = atBeijing("02:05");
  const plan = classifyAnchorPlan({
    nowMs: NOW_MS,
    config: CONFIG,
    nowMinuteOfDay: 120,
    resetAtMs: reset,
  });
  assert.equal(plan.kind, "ban");
  if (plan.kind === "ban") assert.equal(plan.fromMs, reset - 15 * 60_000);
});

test("R still in the future but inside tonight's danger zone reports a future ban", () => {
  const reset = atBeijing("04:30");
  const plan = classifyAnchorPlan({
    nowMs: NOW_MS,
    config: CONFIG,
    nowMinuteOfDay: 120,
    resetAtMs: reset,
  });
  assert.equal(plan.kind, "future");
  if (plan.kind === "future") assert.equal(plan.banFromMs, reset - 15 * 60_000);
});

test("R ending in the (05:55, 06:00] seam is naturally safe", () => {
  for (const hhmm of ["05:56", "06:00"]) {
    const plan = classifyAnchorPlan({
      nowMs: NOW_MS,
      config: CONFIG,
      nowMinuteOfDay: 120,
      resetAtMs: atBeijing(hhmm),
    });
    assert.equal(plan.kind, "safe", hhmm);
  }
});

test("R outliving the anchor marks the night ruined — no action", () => {
  const plan = classifyAnchorPlan({
    nowMs: NOW_MS,
    config: CONFIG,
    nowMinuteOfDay: 120,
    // R=06:30 — inside the 5h staleness bound (now+5h=07:00) but past the
    // 06:00 anchor: the current window will still cover the ball tonight.
    resetAtMs: atBeijing("06:30"),
  });
  assert.equal(plan.kind, "ruined");
});

test("planned blackout discriminator keys off the raw encoding", () => {
  assert.equal(isPlannedBlackoutRateLimitedUntil("2026-11-12T05:55:00.000Z"), true);
  assert.equal(isPlannedBlackoutRateLimitedUntil("1781696905131"), false); // epoch string
  assert.equal(isPlannedBlackoutRateLimitedUntil("1781696905131.0"), false); // decimal tail
  assert.equal(isPlannedBlackoutRateLimitedUntil(1781696905131), false); // number
  assert.equal(isPlannedBlackoutRateLimitedUntil(""), false);
  assert.equal(isPlannedBlackoutRateLimitedUntil(null), false);
  assert.equal(isPlannedBlackoutRateLimitedUntil(undefined), false);
  assert.equal(isPlannedBlackoutRateLimitedUntil("not a date"), false);
});
