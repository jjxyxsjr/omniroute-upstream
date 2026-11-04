import test from "node:test";
import assert from "node:assert/strict";
const { reorderForCacheWarmth } = await import("../../open-sse/services/combo/cacheAwareRetry.ts");

test("previous account gets boosted to the top", () => {
  const cands = [
    { connectionId: "a", account: "nnd_001", strategyScore: 0.9 },
    { connectionId: "b", account: "nnd_002", strategyScore: 0.85 },
    { connectionId: "c", account: "nnd_003", strategyScore: 0.8 },
  ];
  const r = reorderForCacheWarmth(cands, "nnd_003");
  assert.equal(r.ordered[0].account, "nnd_003", "warm account boosted to top");
  assert.equal(r.preferredConnectionId, "c");
});

test("no previous account → unchanged ordering", () => {
  const cands = [
    { connectionId: "a", account: "nnd_001", strategyScore: 0.9 },
    { connectionId: "b", account: "nnd_002", strategyScore: 0.85 },
  ];
  const r = reorderForCacheWarmth(cands, null);
  assert.deepEqual(r.ordered, cands);
  assert.equal(r.preferredConnectionId, null);
});

test("walled account (not in candidates) doesn't crash", () => {
  const cands = [
    { connectionId: "a", account: "nnd_001", strategyScore: 0.9 },
  ];
  const r = reorderForCacheWarmth(cands, "walled_account");
  assert.equal(r.ordered.length, 1);
  assert.equal(r.preferredConnectionId, null);
});

test("single candidate → returned as-is", () => {
  const cands = [{ connectionId: "x", account: "only", strategyScore: 0.5 }];
  const r = reorderForCacheWarmth(cands, "only");
  assert.equal(r.ordered.length, 1);
});
