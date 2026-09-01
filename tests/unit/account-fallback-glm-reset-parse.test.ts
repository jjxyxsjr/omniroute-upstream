/**
 * 016 — GLM (Zhipu) quota-exhaustion 429s carry an exact reset timestamp in
 * Chinese: "您的限额将在 2026-09-01 16:02:52 重置。". Production cross-check
 * (2026-09-01): that wall-clock is Beijing-local (UTC+8) with no zone marker —
 * quota_snapshots.next_reset_at read 08:02:52Z for the same window. A bare
 * Date.parse treats it as UTC and would over-cool the account by 8h; no parse
 * at all (the pre-fix behavior) leaves the dead account on a seconds-level
 * cooldown where the rotation pool re-hits it ~10×/hour until the window
 * resets (2026-08-26: 119 re-hits in 70 minutes on one account).
 */
import test from "node:test";
import assert from "node:assert/strict";

const { parseRetryFromErrorText } = await import("../../open-sse/services/accountFallback.ts");

const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Format a future instant as the GLM Chinese-text wall clock (Beijing, HH:MM:SS). */
function bjWallClock(msFromNow: number): string {
  const d = new Date(Date.now() + msFromNow + BJ_OFFSET_MS);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

test("016 parses the GLM Chinese reset text into a wall-clock cooldown", () => {
  const text = `已达到 5 小时的使用上限。您的限额将在 ${bjWallClock(2 * 3600 * 1000)} 重置。`;
  const ms = parseRetryFromErrorText(text);
  assert.ok(ms !== null, "expected non-null wait");
  const twoHours = 2 * 3600 * 1000;
  assert.ok(Math.abs(ms! - twoHours) < 5000, `expected ~2h cooldown, got ${ms}ms`);
});

test("016 treats the GLM timestamp as Beijing time, not UTC (8h trap)", () => {
  // A reset 1h from now, expressed in BJ wall clock. If parsed as UTC the
  // wait would come out as 1h + 8h = 9h.
  const text = `您的限额将在 ${bjWallClock(3600 * 1000)} 重置`;
  const ms = parseRetryFromErrorText(text);
  assert.ok(ms !== null && ms! > 0 && ms! < 2 * 3600 * 1000, `expected ~1h, got ${ms}ms`);
});

test("016 accepts HH:MM precision (seconds omitted)", () => {
  const d = new Date(Date.now() + 90 * 60 * 1000 + BJ_OFFSET_MS);
  const hhmm = d.toISOString().slice(11, 16);
  const date = d.toISOString().slice(0, 10);
  const ms = parseRetryFromErrorText(`您的限额将在 ${date} ${hhmm} 重置。`);
  assert.ok(ms !== null && ms! > 80 * 60 * 1000 && ms! < 100 * 60 * 1000, `expected ~90m, got ${ms}ms`);
});

test("016 ignores already-past GLM reset timestamps (no negative cooldown)", () => {
  const ms = parseRetryFromErrorText("您的限额将在 2020-01-01 08:00:00 重置。");
  assert.equal(ms, null);
});

test("016 regression: English reset formats keep working", () => {
  assert.equal(parseRetryFromErrorText("Your quota will reset after 1h30m"), 90 * 60 * 1000);
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const iso = parseRetryFromErrorText(`Try again at ${future}`);
  assert.ok(iso !== null && iso! > 30 * 60 * 1000);
});
