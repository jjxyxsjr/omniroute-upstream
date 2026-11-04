/**
 * requestLifecycle.ts — #116: per-request lifecycle phase tracking.
 *
 * Records precise timestamps at each phase boundary so any slow request can
 * be attributed to a specific phase (queue / dispatch / upstream connect /
 * prefill / generation) instead of guessing "upstream is slow."
 *
 * The tracker is deliberately cheap: a plain object with Date.now() calls at
 * existing code boundaries. All mutations are try-catch safe — instrumentation
 * must NEVER break a request. The completed lifecycle is attached to
 * call_logs for post-hoc analysis, and a live registry exposes currently
 * in-flight requests for real-time "is it stuck?" queries.
 *
 * Phases:
 *   0. admitted    — gateway admission gate passed
 *   1. dispatched  — combo selected target, about to send upstream
 *   2. connected   — upstream returned HTTP headers
 *   3. firstEvent  — first SSE event received (readiness signal)
 *   4. firstContent— first content byte forwarded to client
 *   5. completed   — stream ended (or error/abort)
 *
 * #116 (nnd.40): approved by operator 2026-11-04 BJ 23:0x.
 */

// ─── Phase types ─────────────────────────────────────────────────────────────

export type LifecyclePhase =
  | "queued"      // waiting for admission
  | "admitted"    // passed admission, about to route
  | "dispatched"  // sent to upstream (or about to)
  | "connected"   // upstream returned headers
  | "firstEvent"  // first SSE event from upstream
  | "firstContent"// first content byte to client
  | "completed"   // done (success/error/abort)
  | "failed";     // terminal error

export interface RequestLifecycle {
  readonly id: string;
  readonly user: string;
  readonly model: string;
  readonly combo: string | null;
  readonly account: string | null;
  readonly startedAt: number;

  phase: LifecyclePhase;
  /** Precise timestamps (ms epoch) at each phase boundary. */
  timestamps: {
    admitted?: number;
    dispatched?: number;
    connected?: number;
    firstEvent?: number;
    firstContent?: number;
    completed?: number;
    failed?: number;
  };
  /** Cache warmth prediction (set at dispatch time). */
  cacheWarmth: "warm" | "cold" | "unknown";
  /** Predicted TTFT range from learned table (ms). */
  predictedTtftMs: { p50: number; p90: number } | null;
  /** Context size at dispatch (estimated tokens). */
  estimatedTokensIn: number;
  /** Error info if failed. */
  errorSummary: string | null;
}

// ─── Live in-flight registry ─────────────────────────────────────────────────

const inflight = new Map<string, RequestLifecycle>();
const MAX_INFLIGHT = 500; // safety cap — shouldn't hit this

export function createLifecycle(
  id: string,
  meta: { user: string; model: string; combo?: string | null; account?: string | null }
): RequestLifecycle {
  const lc: RequestLifecycle = {
    id,
    user: meta.user,
    model: meta.model,
    combo: meta.combo ?? null,
    account: meta.account ?? null,
    startedAt: Date.now(),
    phase: "queued",
    timestamps: {},
    cacheWarmth: "unknown",
    predictedTtftMs: null,
    estimatedTokensIn: 0,
    errorSummary: null,
  };
  try {
    if (inflight.size >= MAX_INFLIGHT) {
      // Evict the oldest completed entry (or oldest overall as fallback)
      const oldest = inflight.values().next().value;
      if (oldest) inflight.delete(oldest.id);
    }
    inflight.set(id, lc);
  } catch { /* never break the request */ }
  return lc;
}

export function markPhase(lc: RequestLifecycle, phase: LifecyclePhase): void {
  try {
    lc.phase = phase;
    const key =
      phase === "completed" ? "completed" :
      phase === "failed" ? "failed" :
      phase; // matches timestamp keys
    (lc.timestamps as Record<string, number | undefined>)[key] = Date.now();
    if (phase === "completed" || phase === "failed") {
      inflight.delete(lc.id);
    }
  } catch { /* never break the request */ }
}

export function setDispatchInfo(
  lc: RequestLifecycle,
  info: { account?: string | null; combo?: string | null; estimatedTokensIn?: number; cacheWarmth?: "warm" | "cold" | "unknown"; predictedTtftMs?: { p50: number; p90: number } | null }
): void {
  try {
    if (info.account !== undefined) lc.account = info.account;
    if (info.combo !== undefined) lc.combo = info.combo;
    if (info.estimatedTokensIn !== undefined) lc.estimatedTokensIn = info.estimatedTokensIn;
    if (info.cacheWarmth !== undefined) lc.cacheWarmth = info.cacheWarmth;
    if (info.predictedTtftMs !== undefined) lc.predictedTtftMs = info.predictedTtftMs;
  } catch { /* never break the request */ }
}

export function markFailed(lc: RequestLifecycle, errorSummary: string): void {
  try {
    lc.errorSummary = errorSummary.slice(0, 200);
    markPhase(lc, "failed");
  } catch { /* never break the request */ }
}

/** Snapshot of currently in-flight requests (for the real-time API). */
export function getInflightSnapshot(): Array<{
  id: string; user: string; model: string; combo: string | null;
  account: string | null; phase: LifecyclePhase;
  ageMs: number; phaseAgeMs: number;
  cacheWarmth: string; predictedTtftMs: { p50: number; p90: number } | null;
  estimatedTokensIn: number;
}> {
  const now = Date.now();
  return Array.from(inflight.values()).map(lc => {
    const ts = lc.timestamps as Record<string, number | undefined>;
    let lastPhaseTime = lc.startedAt;
    for (const key of ["admitted", "dispatched", "connected", "firstEvent", "firstContent"]) {
      if (typeof ts[key] === "number") lastPhaseTime = ts[key]!;
    }
    return {
      id: lc.id,
      user: lc.user,
      model: lc.model,
      combo: lc.combo,
      account: lc.account,
      phase: lc.phase,
      ageMs: now - lc.startedAt,
      phaseAgeMs: now - lastPhaseTime,
      cacheWarmth: lc.cacheWarmth,
      predictedTtftMs: lc.predictedTtftMs,
      estimatedTokensIn: lc.estimatedTokensIn,
    };
  });
}

// ─── Post-hoc phase breakdown (for call_logs) ────────────────────────────────

export interface PhaseBreakdown {
  queueMs: number;
  connectMs: number;
  prefillMs: number;
  firstByteGapMs: number;
  generationMs: number;
  totalMs: number;
}

export function computePhaseBreakdown(lc: RequestLifecycle): PhaseBreakdown | null {
  try {
    const ts = lc.timestamps;
    if (!ts.admitted || !ts.completed) return null;
    return {
      queueMs: (ts.dispatched ?? ts.completed) - ts.admitted,
      connectMs: ts.connected ? ts.connected - (ts.dispatched ?? ts.admitted) : 0,
      prefillMs: ts.firstEvent ? ts.firstEvent - (ts.connected ?? ts.dispatched ?? ts.admitted) : 0,
      firstByteGapMs: ts.firstContent ? ts.firstContent - (ts.firstEvent ?? ts.connected ?? ts.dispatched ?? ts.admitted) : 0,
      generationMs: ts.firstContent ? ts.completed - ts.firstContent : 0,
      totalMs: ts.completed - ts.admitted,
    };
  } catch { return null; }
}
