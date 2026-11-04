/**
 * ttftPrediction.ts — #116: learned TTFT prediction table.
 *
 * NOT hardcoded — computed from recent production call_logs data grouped by
 * (provider family × cache warmth × context size bucket). Refreshed
 * periodically via the existing retention/cleanup pipeline or on-demand.
 *
 * Usage: at dispatch time, look up the predicted p50/p90 first-byte time for
 * this request's characteristics. Attach to the lifecycle tracker and expose
 * via the in-flight API so operators can answer "how much longer?" in real-time.
 *
 * #116 (nnd.40). Data source: call_logs tokens_in/tokens_cache_read/ttft_ms.
 */

export interface TtftBucket {
  providerFamily: string; // "glm" | "ark-coding" | "ark-agent" | "tencent" | "other"
  cacheWarmth: "warm" | "cold";
  sizeBucket: "<5k" | "5-30k" | "30-100k" | "100k+";
  p50Ms: number;
  p90Ms: number;
  sampleCount: number;
}

export interface TtftPredictionTable {
  generatedAt: number;
  lookbackHours: number;
  buckets: TtftBucket[];
}

// ─── Pure helpers (testable without DB) ──────────────────────────────────────

export function providerFamilyOf(account: string): string {
  const a = (account || "").trim();
  if (a.startsWith("nnd_")) return "glm";
  if (a.includes("ark-agent")) return "ark-agent";
  if (a.startsWith("ark-")) return "ark-coding";
  if (a.includes("tencent")) return "tencent";
  return "other";
}

export function sizeBucketOf(tokensIn: number): TtftBucket["sizeBucket"] {
  if (tokensIn < 5_000) return "<5k";
  if (tokensIn < 30_000) return "5-30k";
  if (tokensIn < 100_000) return "30-100k";
  return "100k+";
}

export function cacheWarmthOf(tokensIn: number, tokensCacheRead: number): "warm" | "cold" {
  if (tokensIn <= 0) return "cold";
  return tokensCacheRead / tokensIn >= 0.3 ? "warm" : "cold";
}

export function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor(sortedMs.length * p));
  return sortedMs[idx];
}

// ─── Prediction lookup ────────────────────────────────────────────────────────

export function predictTtft(
  table: TtftPredictionTable,
  account: string,
  estimatedTokensIn: number,
  cacheWarmth: "warm" | "cold" | "unknown"
): { p50: number; p90: number } | null {
  const family = providerFamilyOf(account);
  const size = sizeBucketOf(estimatedTokensIn);
  const warmth = cacheWarmth === "unknown" ? "cold" : cacheWarmth;

  // Try exact match first
  const exact = table.buckets.find(
    b => b.providerFamily === family && b.cacheWarmth === warmth && b.sizeBucket === size
  );
  if (exact && exact.sampleCount >= 5) return { p50: exact.p50Ms, p90: exact.p90Ms };

  // Fall back: same family + warmth, any size
  const familyWarm = table.buckets
    .filter(b => b.providerFamily === family && b.cacheWarmth === warmth)
    .sort((a, b) => b.sampleCount - a.sampleCount);
  if (familyWarm.length > 0 && familyWarm[0].sampleCount >= 5) {
    return { p50: familyWarm[0].p50Ms, p90: familyWarm[0].p90Ms };
  }

  // Last resort: any bucket with enough samples
  const any = table.buckets.filter(b => b.sampleCount >= 5).sort((a, b) => b.sampleCount - a.sampleCount);
  if (any.length > 0) return { p50: any[0].p50Ms, p90: any[0].p90Ms };

  return null;
}

// ─── Table builder (call with a DB query result) ─────────────────────────────

export interface TtftRawRow {
  account: string;
  tokens_in: number;
  tokens_cache_read: number;
  ttft_ms: number | null;
}

export function buildTtftTable(rows: TtftRawRow[], lookbackHours: number): TtftPredictionTable {
  const grouped = new Map<string, number[]>();

  for (const r of rows) {
    if (!r.ttft_ms || r.ttft_ms <= 0) continue;
    const family = providerFamilyOf(r.account);
    const warmth = cacheWarmthOf(r.tokens_in, r.tokens_cache_read);
    const size = sizeBucketOf(r.tokens_in);
    const key = `${family}|${warmth}|${size}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r.ttft_ms);
  }

  const buckets: TtftBucket[] = [];
  for (const [key, times] of grouped) {
    const [providerFamily, cacheWarmth, sizeBucket] = key.split("|");
    const sorted = times.sort((a, b) => a - b);
    buckets.push({
      providerFamily,
      cacheWarmth: cacheWarmth as "warm" | "cold",
      sizeBucket: sizeBucket as TtftBucket["sizeBucket"],
      p50Ms: percentile(sorted, 0.5),
      p90Ms: percentile(sorted, 0.9),
      sampleCount: sorted.length,
    });
  }

  return { generatedAt: Date.now(), lookbackHours, buckets };
}
