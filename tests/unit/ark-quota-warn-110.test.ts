/**
 * #110 — ark quota fetch failure must leave a trace.
 *
 * The night of 2026-11-02/03 a ~10h control-plane outage made
 * fetchArkPlanQuota return null silently on every call; both ark lanes fell
 * to the no-quota floor and vanished from lead rotation with zero log lines.
 * These tests pin the warn budget semantics via the boolean return (the warn
 * text itself surfaced as TAP comment lines in the first RED run):
 * first failure per scope logs, repeats inside the 5-minute window are
 * suppressed, the window releases afterwards, scopes stay independent, and
 * a never-seen scope warns immediately (no epoch-0 priming bug).
 */
import test from "node:test";
import assert from "node:assert/strict";

const { warnArkQuotaFetchFailure } = await import(
  "../../open-sse/services/arkQuotaFetcher.ts"
);

test("#110 first failure for a fresh scope warns (returns true)", () => {
  assert.equal(warnArkQuotaFetchFailure("GetCodingPlanUsage:3e7a4f9d", "no usable response", 1_000), true);
});

test("#110 a never-seen scope is not silenced by epoch-0 priming", () => {
  // Regression shape of the first implementation: last ?? 0 suppressed the
  // very first warn for small `now` values.
  assert.equal(warnArkQuotaFetchFailure("GetAFPUsage:aa24b56f", "x", 2_000), true);
});

test("#110 repeats inside the 5-minute suppression window are silent", () => {
  assert.equal(warnArkQuotaFetchFailure("GetAFPUsage:aa24b56f", "x", 10_000), false);
  assert.equal(warnArkQuotaFetchFailure("GetAFPUsage:aa24b56f", "x", 20_000), false);
  assert.equal(warnArkQuotaFetchFailure("GetAFPUsage:aa24b56f", "x", 300_000), false);
});

test("#110 the window releases after 5 minutes", () => {
  assert.equal(warnArkQuotaFetchFailure("GetAFPUsage:aa24b56f", "again", 400_000), true);
});

test("#110 scopes are independent — one failing lane cannot silence the other", () => {
  // 800_000 is past every prior scope's window (GetAFPUsage last warned at 400_000).
  assert.equal(warnArkQuotaFetchFailure("GetCodingPlanUsage:3e7a4f9d", "a", 800_000), true);
  assert.equal(warnArkQuotaFetchFailure("GetAFPUsage:aa24b56f", "b", 800_000), true);
});
