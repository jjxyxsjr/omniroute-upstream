/**
 * lastResortDispatch.ts — nnd.44 ③ (#213, plan note 20622).
 *
 * WHY: a combo whose every target sits behind a red light (429 cooldown /
 * transient model lock) used to terminate with the blocked-pool 429/503 even
 * when one target's lock was a synthetic/backoff lock that a single real
 * attempt would likely clear or simply succeed past (the 2026-11-11 11:44
 * 陶刚 case: one GLM seat + 1302-rate cooldown + sticky occupancy = all
 * targets unavailable while the pool itself carried no real load). GLM 全员
 * 烧穿时无兜底 (iid 213) — this module is that兜底, narrowly.
 *
 * WHAT IT DOES: at the two terminal exits of comboAttemptLoop (exit A =
 * blocked-pool 429 after the model-lock park timed out; exit B =
 * all-targets-skipped honest 429), fire ONE extra dispatch against the
 * least-bad target. Cost is strictly bounded:
 *
 *   COST CEILING (note 7): at most ONE upstream attempt per REQUEST (note 9,
 *   the latch on AttemptLoopState), with maxRetries forced to 0 for it. A
 *   failure serves the already-built terminal error unchanged — the
 *   last-resort failure response NEVER reaches the client (note 2).
 *
 * Selector ranking (least-bad first), per target:
 *   - ISO-encoded (planned blackout / operator manual) rate_limited_until or
 *     an upstreamReset-stamped lock that has not expired → NEVER a candidate
 *     (note 1: ISO = the no-try floor — those locks declare calendar policy
 *     or an upstream wall instant, and #188 already keeps wall locks alive
 *     across successes, so retrying them is provably wasted quota).
 *   - already dispatched this request → excluded (note 6, exclusion list).
 *   - no lock / expired lock → best.
 *   - backoff/synthetic lock → ranked by least remaining time.
 *   - provider not request-exhausted preferred over exhausted ones.
 *
 * Guards (note 3): the last-resort attempt runs through the SAME pre-dispatch
 * gates (evaluateExecuteTargetGates) and attempt path (executeTargetAttempt).
 * Exactly two sanctioned releases, both encoding-aware:
 *   - the nnd.42d model-lock pre-dispatch guard (executeTargetAttempt) is
 *     skipped for the last-resort attempt — re-checking it would re-skip the
 *     very lock this dispatch exists to retry past;
 *   - the persisted-connection-cooldown gate exempts FUTURE EPOCH-encoded
 *     cooldowns (real 429s) — ISO values still skip (note 1).
 *   Circuit breakers, crash-storm, terminal statuses, request exhaustion and
 *   quota caps all still apply unchanged.
 *
 * Saturation (note 5): if the chosen target's account semaphore is full, wait
 * up to the INDEPENDENT deadline (OMNIROUTE_LAST_RESORT_DEADLINE_MS, default
 * 0 = the whole feature is off); past the deadline demote to plain queueing —
 * the normal dispatch path queues with its own timeout. The deadline is
 * deliberately NOT the combo queueTimeout: the last resort must not inherit
 * a budget the saturated pool already burned.
 *
 * Flag (note 4): a NEW narrow flag `lastResortDispatch` — deliberately NOT
 * the transient allowRateLimitedConnection flag — threads target →
 * handleSingleModel runtimeOptions → auth credential selection, where it
 * grants the same encoding-aware exemption as ①b narrowed: epoch cooldowns
 * pass, ISO planned blackouts stay filtered.
 *
 * Log family (note 8): everything logs under LAST_RESORT_*.
 */
import { cooldownUntilMs, isPlannedBlackoutRateLimitedUntil } from "../accountFallback.ts";
import { isAccountSemaphoreFull } from "../accountSemaphore.ts";
import { getCachedProviderConnectionById } from "../../../src/lib/db/readCache.ts";
import { parseModel } from "../model.ts";
import { lookupPositiveCap } from "./concurrencyCaps.ts";
import type { ResolvedComboTarget } from "./types.ts";
import type {
  AttemptLoopDeps,
  AttemptLoopState,
} from "./attemptLoopTypes.ts";

const LOG_TAG = "LAST_RESORT";
/** Saturation poll cadence while waiting out the independent deadline. */
const SATURATION_POLL_MS = 250;

/**
 * Resolve the last-resort deadline (ms). OMNIROUTE_LAST_RESORT_DEADLINE_MS:
 * 0/unset = feature OFF (default); >0 = saturation wait cap per request.
 */
export function resolveLastResortDeadlineMs(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}
): number {
  const raw = Number(env.OMNIROUTE_LAST_RESORT_DEADLINE_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.floor(raw), 10 * 60_000);
}

interface CandidateInfo {
  target: ResolvedComboTarget;
  index: number;
  /** 0 = no live obstruction; otherwise least-remaining lock time (ms). */
  lockRemainingMs: number;
  providerExhausted: boolean;
}

/**
 * Rank every ordered target for the last-resort pick. Pure apart from the
 * cached connection read. Never throws — an unreadable row just drops the
 * target (conservative).
 */
export async function selectLastResortTarget(
  state: AttemptLoopState,
  deps: AttemptLoopDeps,
  nowMs: number = Date.now()
): Promise<CandidateInfo | null> {
  const { getModelLockoutInfo, scanTransientModelLock } = await import("../accountFallback.ts");
  let best: CandidateInfo | null = null;
  for (let index = 0; index < state.orderedTargets.length; index++) {
    const target = state.orderedTargets[index];
    const provider = target.provider;
    if (!provider || provider === "unknown") continue;
    // Note 6 — exclusion list: never re-dispatch a target this request tried.
    if (target.executionKey && state.dispatchedTargets.has(target.executionKey)) continue;

    const rawModel = parseModel(target.modelStr).model || target.modelStr;
    const connectionId = target.connectionId || "";
    const lock = connectionId
      ? getModelLockoutInfo(provider, connectionId, rawModel)
      : scanTransientModelLock(provider, rawModel);

    // Note 1 — ISO / upstreamReset walls are the no-try floor.
    if (lock && lock.remainingMs > 0 && lock.upstreamReset === true) continue;

    if (target.connectionId) {
      let connection: Record<string, unknown> | null | undefined;
      try {
        connection = (await getCachedProviderConnectionById(target.connectionId)) as
          | Record<string, unknown>
          | null
          | undefined;
      } catch {
        connection = null;
      }
      const rawUntil = connection?.rateLimitedUntil;
      if (isPlannedBlackoutRateLimitedUntil(rawUntil)) {
        const untilMs = cooldownUntilMs(rawUntil as string);
        if (Number.isFinite(untilMs) && untilMs > nowMs) continue; // planned blackout
      }
    }

    const lockRemainingMs = lock && lock.remainingMs > 0 ? lock.remainingMs : 0;
    const providerExhausted = state.exhaustedProviders.has(provider);
    const candidate: CandidateInfo = { target, index, lockRemainingMs, providerExhausted };
    if (
      !best ||
      (Number(best.providerExhausted) - Number(candidate.providerExhausted)) > 0 ||
      (best.providerExhausted === candidate.providerExhausted &&
        candidate.lockRemainingMs < best.lockRemainingMs)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Wait for the chosen target's account semaphore up to the independent
 * deadline, then demote to queueing (note 5). Returns once a slot is visible
 * or the deadline lapses — queueing itself is the normal path's job.
 */
async function waitForSaturationOrDemote(
  target: ResolvedComboTarget,
  deadlineMs: number,
  log: AttemptLoopDeps["log"]
): Promise<"slot" | "deadline-demote-queue"> {
  const provider = target.provider || "";
  const connectionId = target.connectionId;
  if (!provider || !connectionId) return "slot";
  const cap = await lookupPositiveCap(connectionId); // fail-open on read error
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!isAccountSemaphoreFull(provider, connectionId, cap)) return "slot";
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, SATURATION_POLL_MS);
      (timer as { unref?: () => void } | undefined)?.unref?.();
    });
  }
  if (isAccountSemaphoreFull(provider, connectionId, cap)) {
    log.info(
      LOG_TAG,
      `saturation deadline (${deadlineMs}ms) lapsed for ${target.modelStr} — demoting to queue`
    );
    return "deadline-demote-queue";
  }
  return "slot";
}

/**
 * Fire the single last-resort attempt at a terminal exit. Returns the served
 * Response ONLY on success; null means "no attempt was possible or it
 * failed" — the caller serves its already-built terminal response, and the
 * last-resort failure body is discarded (note 2).
 *
 * Note 9: one latch per request (state.lastResortFired) — both exits share
 * it, so a request can never pay for two last resorts.
 */
export async function tryLastResortDispatch(opts: {
  state: AttemptLoopState;
  deps: AttemptLoopDeps;
  exit: "A" | "B";
  evaluateGates: (input: { index: number; state: AttemptLoopState; deps: AttemptLoopDeps }) => Promise<
    | { kind: "skip"; result: { ok: boolean; response?: Response } | null }
    | {
        kind: "proceed";
        targetForAttempt: ResolvedComboTarget;
        profile: unknown;
        protectedPriorityTarget: boolean;
      }
  >;
  executeAttempt: (input: {
    index: number;
    state: AttemptLoopState;
    deps: AttemptLoopDeps;
    targetForAttempt: ResolvedComboTarget;
    profile: unknown;
    protectedPriorityTarget: boolean;
    lastResort?: boolean;
  }) => Promise<{ ok: boolean; response?: Response } | null>;
  nowMs?: number;
}): Promise<Response | null> {
  const { state, deps, exit } = opts;
  const deadlineMs = resolveLastResortDeadlineMs();
  if (deadlineMs <= 0) return null; // feature off
  if (state.lastResortFired) return null; // note 9: one latch per request
  state.lastResortFired = true;

  const candidate = await selectLastResortTarget(state, deps, opts.nowMs);
  if (!candidate) {
    deps.log.info(LOG_TAG, `exit ${exit}: no retry-worthy target (ISO walls / all dispatched)`);
    return null;
  }
  const { target, index, lockRemainingMs } = candidate;
  deps.log.info(
    LOG_TAG,
    `exit ${exit}: all targets blocked — dispatching last resort ${target.modelStr}` +
      (lockRemainingMs > 0 ? ` (synthetic lock, ${Math.ceil(lockRemainingMs / 1000)}s nominal)` : "") +
      ` (cost ≤ 1 upstream attempt)`
  );

  // Saturation wait happens before the gates; queue demotion simply proceeds.
  await waitForSaturationOrDemote(target, deadlineMs, deps.log);

  // Encoding-aware exemption window: gates see state.lastResortPass while the
  // last-resort dispatch runs; the persisted-cooldown gate exempts future
  // EPOCH cooldowns only (ISO still skips — note 1).
  const priorPass = state.lastResortPass === true;
  state.lastResortPass = true;
  try {
    const gate = await opts.evaluateGates({ index, state, deps });
    if (gate.kind === "skip") {
      deps.log.info(
        LOG_TAG,
        `exit ${exit}: gates still refused ${target.modelStr} (guards not bypassed, note 3)`
      );
      return null;
    }
    const result = await opts.executeAttempt({
      index,
      state,
      deps,
      targetForAttempt: { ...gate.targetForAttempt, lastResortDispatch: true },
      profile: gate.profile,
      protectedPriorityTarget: gate.protectedPriorityTarget,
      lastResort: true,
    });
    if (result && result.ok) {
      deps.log.info(LOG_TAG, `exit ${exit}: last resort ${target.modelStr} SUCCEEDED — serving`);
      return result.response ?? null;
    }
    // Failure: the terminal response already built by the exit is served.
    // The last-resort failure body is deliberately discarded (note 2).
    deps.log.info(LOG_TAG, `exit ${exit}: last resort ${target.modelStr} failed — serving terminal error`);
    return null;
  } finally {
    state.lastResortPass = priorPass;
  }
}
