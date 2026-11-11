/**
 * chunkTimingStats.ts — nnd.44 ②b (#232 observability gen-2).
 *
 * Pure aggregation of per-forwarded-chunk epoch samples into the three
 * call_logs columns (chunk_itl_p99_ms / chunk_pause_2s_count / first_content_at).
 *
 * Design constraints (see the batch plan):
 *   - AGGREGATES ONLY, never the full chunk list — the DB must not grow with
 *     stream length. The sample itself (bounded, ≤ CHUNK_EPOCH_SAMPLE_CAP
 *     entries) lives in memory during the request and crosses to the artifact
 *     worker for aggregation; only these scalars are persisted.
 *   - Computation is deliberately placed OFF the request-serving thread: the
 *     artifact worker (nnd.42 ① sanitization worker) computes these while it
 *     already walks the payload ("in passing"). The same pure function serves
 *     as the main-thread fallback for rows that never produce an artifact.
 *   - ITL here is inter-FORWARDED-chunk latency (client-perceived pacing), not
 *     token latency — same caveat as streamTiming's avgItlMs.
 */

/** Gaps longer than this count as a visible stall. */
export const CHUNK_PAUSE_THRESHOLD_MS = 2_000;

export interface ChunkTimingSample {
  /** Wall-clock epoch ms of consecutive forwarded chunks (bounded sample). */
  epochs: number[];
  /** True when the stream forwarded more chunks than the sample cap. */
  truncated: boolean;
  /** Epoch of the first chunk carrying user-visible CONTENT (reasoning placeholders skipped). */
  firstContentEpochMs: number | null;
}

export interface ChunkTimingAggregates {
  itlP50Ms: number | null;
  itlP99Ms: number | null;
  pause2sCount: number | null;
  firstContentAt: number | null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  // Nearest-rank percentile (ceil(p·N)) — stable, index-safe, no interpolation.
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return Math.round(sorted[rank - 1]);
}

/**
 * Aggregate a chunk-epoch sample. Nulls (not zeros) when there is nothing to
 * measure, so analytics can tell "no stream" from "instant stream".
 * `firstContentEpochMs` passes through rounded — it is measured on the stream
 * side, independently of the epoch sample.
 */
export function aggregateChunkTiming(sample: ChunkTimingSample | null | undefined): ChunkTimingAggregates {
  if (!sample || !Array.isArray(sample.epochs) || sample.epochs.length < 2) {
    return {
      itlP50Ms: null,
      itlP99Ms: null,
      pause2sCount: null,
      firstContentAt:
        typeof sample?.firstContentEpochMs === "number" && Number.isFinite(sample.firstContentEpochMs)
          ? Math.round(sample.firstContentEpochMs)
          : null,
    };
  }
  const gaps: number[] = [];
  let pause2sCount = 0;
  let previous = sample.epochs[0];
  for (let i = 1; i < sample.epochs.length; i++) {
    const current = sample.epochs[i];
    const gap = current - previous;
    previous = current;
    if (!Number.isFinite(gap)) continue;
    // A negative "gap" means clock skew between samples — skip rather than
    // poison the distribution (monotonic projection makes this rare).
    if (gap < 0) continue;
    if (gap > CHUNK_PAUSE_THRESHOLD_MS) pause2sCount += 1;
    gaps.push(Math.round(gap));
  }
  if (gaps.length === 0) {
    return {
      itlP50Ms: null,
      itlP99Ms: null,
      pause2sCount,
      firstContentAt:
        typeof sample.firstContentEpochMs === "number" && Number.isFinite(sample.firstContentEpochMs)
          ? Math.round(sample.firstContentEpochMs)
          : null,
    };
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    itlP50Ms: percentile(sorted, 0.5),
    itlP99Ms: percentile(sorted, 0.99),
    pause2sCount,
    firstContentAt:
      typeof sample.firstContentEpochMs === "number" && Number.isFinite(sample.firstContentEpochMs)
        ? Math.round(sample.firstContentEpochMs)
        : null,
  };
}
