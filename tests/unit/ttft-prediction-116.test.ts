/**
 * #116 — TTFT prediction table (learned from production, not hardcoded).
 *
 * Tests pin: provider family classification, size bucketing, cache warmth
 * detection, percentile computation, table building from raw rows, and the
 * prediction lookup with fallback chain (exact → family → any).
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  providerFamilyOf, sizeBucketOf, cacheWarmthOf, percentile,
  predictTtft, buildTtftTable,
} = await import("../../open-sse/handlers/chatCore/ttftPrediction.ts");
import type { TtftRawRow, TtftPredictionTable } from "../../open-sse/handlers/chatCore/ttftPrediction.ts";

test("#116 family: correct classification", () => {
  assert.equal(providerFamilyOf("nnd_13360006821"), "glm");
  assert.equal(providerFamilyOf("ark-agent-13668996989"), "ark-agent");
  assert.equal(providerFamilyOf("ark-13668996989"), "ark-coding");
  assert.equal(providerFamilyOf("tencent-agent-personal"), "tencent");
  assert.equal(providerFamilyOf("random-host"), "other");
});

test("#116 size buckets: correct thresholds", () => {
  assert.equal(sizeBucketOf(1_000), "<5k");
  assert.equal(sizeBucketOf(4_999), "<5k");
  assert.equal(sizeBucketOf(5_000), "5-30k");
  assert.equal(sizeBucketOf(29_999), "5-30k");
  assert.equal(sizeBucketOf(30_000), "30-100k");
  assert.equal(sizeBucketOf(99_999), "30-100k");
  assert.equal(sizeBucketOf(100_000), "100k+");
});

test("#116 cache warmth: 30% threshold", () => {
  assert.equal(cacheWarmthOf(100_000, 50_000), "warm");
  assert.equal(cacheWarmthOf(100_000, 30_000), "warm");
  assert.equal(cacheWarmthOf(100_000, 29_999), "cold");
  assert.equal(cacheWarmthOf(0, 0), "cold");
});

test("#116 percentile: correct for known arrays", () => {
  // p50 of [10,20,30,40,50]: floor(5*0.5)=idx 2 → 30
  assert.equal(percentile([10, 20, 30, 40, 50], 0.5), 30);
  // p90 of [10..100]: floor(10*0.9)=idx 9 → 100 (nearest-rank method)
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9), 100);
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([42], 0.5), 42);
});

test("#116 buildTable: groups correctly and computes stats", () => {
  const rows: TtftRawRow[] = [
    { account: "nnd_001", tokens_in: 50_000, tokens_cache_read: 40_000, ttft_ms: 5_000 },
    { account: "nnd_001", tokens_in: 60_000, tokens_cache_read: 50_000, ttft_ms: 7_000 },
    { account: "nnd_001", tokens_in: 55_000, tokens_cache_read: 10_000, ttft_ms: 20_000 },
    { account: "nnd_001", tokens_in: 200_000, tokens_cache_read: 5_000, ttft_ms: 50_000 },
    { account: "nnd_001", tokens_in: 180_000, tokens_cache_read: 150_000, ttft_ms: 10_000 },
    { account: "ark-001", tokens_in: 80_000, tokens_cache_read: 0, ttft_ms: 30_000 },
    { account: "nnd_001", tokens_in: 100, tokens_cache_read: 0, ttft_ms: null },
  ];
  const table = buildTtftTable(rows, 24);
  assert.equal(table.buckets.length >= 3, true, "at least 3 buckets");
  const warm3050 = table.buckets.find(b => b.providerFamily === "glm" && b.cacheWarmth === "warm" && b.sizeBucket === "30-100k");
  assert.ok(warm3050);
  assert.equal(warm3050.sampleCount, 2);
  assert.equal(warm3050.p50Ms, 7_000); // sorted [5000,7000] → p50=7000 (idx 1)
});

test("#116 predict: exact match when available", () => {
  const table: TtftPredictionTable = {
    generatedAt: Date.now(), lookbackHours: 24,
    buckets: [
      { providerFamily: "glm", cacheWarmth: "cold", sizeBucket: "100k+", p50Ms: 25_000, p90Ms: 60_000, sampleCount: 10 },
      { providerFamily: "glm", cacheWarmth: "warm", sizeBucket: "30-100k", p50Ms: 5_000, p90Ms: 15_000, sampleCount: 50 },
    ],
  };
  const pred = predictTtft(table, "nnd_001", 200_000, "cold");
  assert.deepEqual(pred, { p50: 25_000, p90: 60_000 });
});

test("#116 predict: falls back to family+warmth when exact size missing", () => {
  const table: TtftPredictionTable = {
    generatedAt: Date.now(), lookbackHours: 24,
    buckets: [
      { providerFamily: "glm", cacheWarmth: "cold", sizeBucket: "30-100k", p50Ms: 15_000, p90Ms: 35_000, sampleCount: 20 },
    ],
  };
  const pred = predictTtft(table, "nnd_001", 200_000, "cold"); // 100k+ bucket missing
  assert.deepEqual(pred, { p50: 15_000, p90: 35_000 }, "fell back to family+warmth");
});

test("#116 predict: unknown warmth treated as cold", () => {
  const table: TtftPredictionTable = {
    generatedAt: Date.now(), lookbackHours: 24,
    buckets: [
      { providerFamily: "glm", cacheWarmth: "cold", sizeBucket: "30-100k", p50Ms: 12_000, p90Ms: 30_000, sampleCount: 15 },
    ],
  };
  const pred = predictTtft(table, "nnd_001", 50_000, "unknown");
  assert.ok(pred, "returns prediction");
  assert.equal(pred.p50, 12_000);
});

test("#116 predict: returns null for empty table", () => {
  const table: TtftPredictionTable = { generatedAt: Date.now(), lookbackHours: 1, buckets: [] };
  assert.equal(predictTtft(table, "nnd_001", 50_000, "warm"), null);
});
