/**
 * cacheAwareRetry.ts — #111-④: cache-aware failure retry ordering.
 *
 * Production evidence (2026-11-03 BJ 17:00-18:00): 197 zero-byte aborts when
 * the client retried across 8 different lanes — each retry hit a cold cache
 * and re-paid the full prefill (98-300s for 200k+ tokens). The combo loop's
 * default retry walks to the NEXT candidate (cold) instead of returning to
 * the warm lane that already prefetched this session's prefix.
 *
 * Measured cost (2026-11-04): switching accounts at 100k+ context = 2.2-3×
 * slower first byte (13.3s vs 6.1s at 100-300k, 25.2s vs 8.5s at 300k+).
 * Same-account continuation = 97% hit rate (production baseline).
 *
 * Fix: when a failure triggers a retry, boost the previous account's score
 * so the combo prefers returning to the warm lane. Only cross to a cold
 * lane when the warm lane is genuinely unavailable (walled/cooling/saturated).
 *
 * #111-④ (nnd.40). Evidence: issue #213, 总纲 #216 横轴.
 */

export interface RetryCandidate {
  connectionId: string;
  account: string;
  /** Score from the reset-aware strategy (higher = preferred). */
  strategyScore: number;
}

export interface CacheAwareRetryResult {
  ordered: RetryCandidate[];
  /** The connection that served the previous attempt, if any. */
  preferredConnectionId: string | null;
}

/**
 * Boost multiplier applied to the previous attempt's connection score.
 * Must be large enough to overcome typical score differences between accounts
 * (observed ~0.1-0.3 in the tie band) but not so large that a truly walled
 * connection gets picked (the wall/cooldown pre-filter runs BEFORE scoring,
 * so walled connections never reach this stage).
 */
const WARM_CACHE_BOOST = 0.5;

export function reorderForCacheWarmth(
  candidates: RetryCandidate[],
  previousAccount: string | null
): CacheAwareRetryResult {
  if (!previousAccount || candidates.length <= 1) {
    return { ordered: candidates, preferredConnectionId: null };
  }

  const boosted = candidates.map(c => ({
    ...c,
    strategyScore: c.account === previousAccount
      ? c.strategyScore + WARM_CACHE_BOOST
      : c.strategyScore,
  }));

  boosted.sort((a, b) => b.strategyScore - a.strategyScore);

  const preferred = boosted.find(c => c.account === previousAccount) ?? null;
  return { ordered: boosted, preferredConnectionId: preferred?.connectionId ?? null };
}
