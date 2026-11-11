/**
 * nnd.44 ③ (#213): last-resort dispatch — deadline resolution, selector
 * ranking, latch semantics, and the failure-never-surfaces contract.
 * Pure in-memory locks; no DB, no scheduler.
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  clearAllModelLockouts,
  getModelLockoutInfo,
  lockModel,
} = await import("../../open-sse/services/accountFallback.ts");
const {
  resolveLastResortDeadlineMs,
  selectLastResortTarget,
  tryLastResortDispatch,
} = await import("../../open-sse/services/combo/lastResortDispatch.ts");

test.after(() => {
  clearAllModelLockouts();
});

const PROVIDER = "glm-cn-test";

function target(stepId: string, model: string, connectionId: string | null) {
  return {
    kind: "model" as const,
    stepId,
    executionKey: stepId,
    modelStr: `${PROVIDER}/${model}`,
    provider: PROVIDER,
    authType: null,
    providerId: null,
    connectionId,
    allowedConnectionIds: null,
    weight: 1,
    label: null,
  };
}

function makeState(orderedTargets: ReturnType<typeof target>[]) {
  return {
    orderedTargets,
    dispatchedTargets: new Set<string>(),
    exhaustedProviders: new Set<string>(),
  } as Parameters<typeof selectLastResortTarget>[0];
}

const STUB_DEPS = { log: { info: () => {}, warn: () => {}, debug: () => {} } } as never;

test("deadline resolution: default off, positive honored, absurd capped", () => {
  assert.equal(resolveLastResortDeadlineMs({}), 0);
  assert.equal(resolveLastResortDeadlineMs({ OMNIROUTE_LAST_RESORT_DEADLINE_MS: "0" }), 0);
  assert.equal(resolveLastResortDeadlineMs({ OMNIROUTE_LAST_RESORT_DEADLINE_MS: "-5" }), 0);
  assert.equal(resolveLastResortDeadlineMs({ OMNIROUTE_LAST_RESORT_DEADLINE_MS: "abc" }), 0);
  assert.equal(resolveLastResortDeadlineMs({ OMNIROUTE_LAST_RESORT_DEADLINE_MS: "5000" }), 5000);
  assert.equal(
    resolveLastResortDeadlineMs({ OMNIROUTE_LAST_RESORT_DEADLINE_MS: "999999999" }),
    10 * 60_000
  );
});

test("selector prefers unlocked, excludes upstreamReset walls and dispatched targets", async () => {
  clearAllModelLockouts();
  const locked = target("a", "locked", "conn-a");
  const walled = target("b", "walled", "conn-b");
  const free = target("c", "free", "conn-c");
  lockModel(PROVIDER, "conn-a", "locked", "rate_limit", 60_000);
  lockModel(PROVIDER, "conn-b", "walled", "quota_exhausted", 3_600_000, {
    upstreamReset: true,
  });
  const state = makeState([locked, walled, free]);
  const pick = await selectLastResortTarget(state, STUB_DEPS);
  assert.equal(pick?.target.stepId, "c", "unlocked target wins over any lock");

  const dispatchedState = makeState([locked, walled, free]);
  dispatchedState.dispatchedTargets.add("c");
  const pick2 = await selectLastResortTarget(dispatchedState, STUB_DEPS);
  assert.equal(pick2?.target.stepId, "a", "dispatched target excluded; synthetic lock retried");
});

test("selector ranks synthetic locks by least remaining time", async () => {
  clearAllModelLockouts();
  const slow = target("a", "slow", "conn-a");
  const soon = target("b", "soon", "conn-b");
  lockModel(PROVIDER, "conn-a", "slow", "rate_limit", 120_000);
  lockModel(PROVIDER, "conn-b", "soon", "rate_limit", 30_000);
  const pick = await selectLastResortTarget(makeState([slow, soon]), STUB_DEPS);
  assert.equal(pick?.target.stepId, "b");
  assert.ok(pick && pick.lockRemainingMs > 0 && pick.lockRemainingMs <= 30_000);
});

test("selector prefers a non-exhausted provider over an exhausted one", async () => {
  clearAllModelLockouts();
  const exhaustedPick = target("a", "x", "conn-a");
  const healthy = target("b", "y", "conn-b");
  const state = makeState([exhaustedPick, healthy]);
  state.exhaustedProviders.add(PROVIDER);
  // Same provider here — exhaustion is per-provider, so with a second provider:
  const healthy2 = { ...target("c", "z", "conn-c"), provider: "other-provider" };
  const pick = await selectLastResortTarget(
    { ...state, orderedTargets: [exhaustedPick, healthy2] } as never,
    STUB_DEPS
  );
  assert.equal(pick?.target.stepId, "c");
});

test("tryLastResortDispatch: off by default, latch is one-shot, failure never surfaces", async () => {
  clearAllModelLockouts();
  const t = target("a", "m", "conn-a");
  lockModel(PROVIDER, "conn-a", "m", "rate_limit", 30_000);
  const state = makeState([t]) as Parameters<typeof tryLastResortDispatch>[0]["state"];

  // Feature off (default env) → immediate null, latch NOT consumed.
  const off = await tryLastResortDispatch({
    state,
    deps: STUB_DEPS,
    exit: "B",
    evaluateGates: async () => ({ kind: "proceed" as const, targetForAttempt: t, profile: null, protectedPriorityTarget: false }),
    executeAttempt: async () => ({ ok: true, response: new Response("ok") }),
  });
  assert.equal(off, null);
  assert.equal(state.lastResortFired, undefined);

  // Feature on → success serves the response; second call is latched off.
  process.env.OMNIROUTE_LAST_RESORT_DEADLINE_MS = "50";
  try {
    const served = await tryLastResortDispatch({
      state,
      deps: STUB_DEPS,
      exit: "B",
      evaluateGates: async () => ({ kind: "proceed" as const, targetForAttempt: t, profile: null, protectedPriorityTarget: false }),
      executeAttempt: async () => ({ ok: true, response: new Response("ok") }),
    });
    assert.ok(served);
    assert.equal(served?.status, 200);

    const again = await tryLastResortDispatch({
      state,
      deps: STUB_DEPS,
      exit: "A",
      evaluateGates: async () => ({ kind: "proceed" as const, targetForAttempt: t, profile: null, protectedPriorityTarget: false }),
      executeAttempt: async () => ({ ok: true, response: new Response("ok") }),
    });
    assert.equal(again, null, "one latch per request (note 9)");
  } finally {
    delete process.env.OMNIROUTE_LAST_RESORT_DEADLINE_MS;
  }

  // Failure path: null returned → caller serves its terminal error; the
  // last-resort failure body never surfaces (note 2).
  const fresh = makeState([t]) as Parameters<typeof tryLastResortDispatch>[0]["state"];
  process.env.OMNIROUTE_LAST_RESORT_DEADLINE_MS = "50";
  try {
    const failed = await tryLastResortDispatch({
      state: fresh,
      deps: STUB_DEPS,
      exit: "B",
      evaluateGates: async () => ({ kind: "proceed" as const, targetForAttempt: t, profile: null, protectedPriorityTarget: false }),
      executeAttempt: async () => ({ ok: false, response: new Response("upstream 429", { status: 429 }) }),
    });
    assert.equal(failed, null);
  } finally {
    delete process.env.OMNIROUTE_LAST_RESORT_DEADLINE_MS;
  }
});

test("gates refusal keeps the terminal error (guards not bypassed, note 3)", async () => {
  clearAllModelLockouts();
  const t = target("a", "m", "conn-a");
  lockModel(PROVIDER, "conn-a", "m", "rate_limit", 30_000);
  const state = makeState([t]) as Parameters<typeof tryLastResortDispatch>[0]["state"];
  process.env.OMNIROUTE_LAST_RESORT_DEADLINE_MS = "50";
  try {
    let attemptRuns = 0;
    const result = await tryLastResortDispatch({
      state,
      deps: STUB_DEPS,
      exit: "B",
      evaluateGates: async () => ({ kind: "skip" as const, result: null }),
      executeAttempt: async () => {
        attemptRuns += 1;
        return { ok: true, response: new Response("ok") };
      },
    });
    assert.equal(result, null);
    assert.equal(attemptRuns, 0, "a gate refusal must not dispatch");
  } finally {
    delete process.env.OMNIROUTE_LAST_RESORT_DEADLINE_MS;
  }
});

test("lockout info now exposes until + upstreamReset for ranking", () => {
  clearAllModelLockouts();
  lockModel(PROVIDER, "conn-rank", "m", "rate_limit", 45_000, { upstreamReset: true });
  const info = getModelLockoutInfo(PROVIDER, "conn-rank", "m");
  assert.ok(info);
  assert.equal(info?.upstreamReset, true);
  assert.ok(typeof info?.until === "number" && (info?.until ?? 0) > Date.now());
});
