/**
 * nnd.23 ② gen-1 — 上游首字画像（运行时内存态 + nnd.25 key_value 持久化）。
 *
 * 背景（155 #49 修正注）：首字时间随时段剧烈摆动（ark 60k 冷体 14 时窗 8-9s
 * vs 早窗 45s+，15-30 倍族）——任何单点常数都会在另一半时段错。本模块在
 * proxyFetch 直连成功路径上记录"响应头到达耗时"，按 (host × UTC 小时) 分桶
 * 维护环形样本，供窗口解析按当前时段取 p90。
 *
 * 设计约束：每桶最少 5 个样本才出值（不足=未知=用默认，绝不拿两三个样本调
 * 窗口）；只允许把窗口"收窄到默认之下"（快上游快速失败换席位），永不放大
 * 超过对齐天花板（那是 nnd.21 候A 的领域）。
 *
 * nnd.25 任务E（157§六清单第 5 条，"重启不失忆"）：画像更新时 debounce
 * （5 分钟内最多一次）把全量分桶 JSON 写 key_value(namespace='opsFeatures',
 * key='upstreamFirstByteProfiles'，带 last_persisted_at 元数据)；进程内存为空
 * 且该 key 存在时首次访问预热载入。一切 DB 读写旁路 best-effort——画像持久化
 * 失败绝不抛进 proxyFetch 请求路径（157§六实施原则）。
 */

import { getDbInstance } from "../../src/lib/db/core.ts";

const MAX_SAMPLES_PER_BUCKET = 50;
const MIN_SAMPLES_FOR_PROFILE = 5;

const PERSIST_NAMESPACE = "opsFeatures";
const PERSIST_KEY = "upstreamFirstByteProfiles";
const PERSIST_DEBOUNCE_MS = 5 * 60 * 1000;

interface PersistedProfilePayload {
  version: 1;
  last_persisted_at: string;
  buckets: Record<string, number[]>;
}

type SampleRing = number[];

const buckets = new Map<string, SampleRing>();

/** Hydration/persistence state — one attempt per process, reset only in tests. */
let hydrated = false;
let lastPersistAtMs = 0;
let dirtySincePersist = false;

function bucketKey(host: string, hourUtc: number): string {
  return `${host.toLowerCase()}::h${hourUtc}`;
}

/**
 * One-shot warm load: process restarted, memory empty, key_value holds the
 * previous process's buckets → bring them back so p90 survives restarts.
 * Sets `hydrated` before touching the DB so a failing/corrupt row can never
 * cause a retry storm on the request path.
 */
function ensureHydrated(): void {
  if (hydrated) return;
  hydrated = true;
  if (buckets.size > 0) return; // memory already live → never clobber
  try {
    const row = getDbInstance()
      .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
      .get(PERSIST_NAMESPACE, PERSIST_KEY) as { value: string } | undefined;
    if (!row) return;
    const parsed = JSON.parse(row.value) as PersistedProfilePayload;
    if (!parsed || typeof parsed !== "object" || !parsed.buckets) return;
    for (const [key, ring] of Object.entries(parsed.buckets)) {
      if (!Array.isArray(ring)) continue;
      const clean = ring
        .filter((ms) => Number.isFinite(ms) && ms > 0)
        .slice(-MAX_SAMPLES_PER_BUCKET)
        .map((ms) => Math.round(ms));
      if (clean.length > 0) buckets.set(key, clean);
    }
    // Adopt the persisted clock so we don't immediately rewrite identical data.
    const persistedAt = Date.parse(parsed.last_persisted_at ?? "");
    if (Number.isFinite(persistedAt)) lastPersistAtMs = persistedAt;
  } catch {
    // Best-effort sidecar: corrupt/missing row just means a cold profile.
  }
}

/**
 * Debounced full-bucket flush to key_value (at most once per 5 minutes; the
 * first update after restart/cold start lands immediately). Uses the sample
 * clock so tests stay deterministic.
 */
function maybePersistProfiles(at: Date): void {
  if (!dirtySincePersist) return;
  const nowMs = at.getTime();
  if (Number.isFinite(lastPersistAtMs) && nowMs - lastPersistAtMs < PERSIST_DEBOUNCE_MS) return;
  const payload: PersistedProfilePayload = {
    version: 1,
    last_persisted_at: at.toISOString(),
    buckets: Object.fromEntries(buckets),
  };
  try {
    getDbInstance()
      .prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
      .run(PERSIST_NAMESPACE, PERSIST_KEY, JSON.stringify(payload));
    lastPersistAtMs = nowMs;
    dirtySincePersist = false;
  } catch {
    // Keep dirty → the next window retries; never surface on the request path.
  }
}

export function recordFirstByteMs(host: string, elapsedMs: number, at: Date = new Date()): void {
  if (!host || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
  ensureHydrated();
  const key = bucketKey(host, at.getUTCHours());
  const ring = buckets.get(key) ?? [];
  ring.push(Math.round(elapsedMs));
  if (ring.length > MAX_SAMPLES_PER_BUCKET) ring.splice(0, ring.length - MAX_SAMPLES_PER_BUCKET);
  buckets.set(key, ring);
  dirtySincePersist = true;
  maybePersistProfiles(at);
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

/**
 * 当前小时的 p90 首字耗时；样本不足（<5）或该桶无数据返回 null（=未知，
 * 调用方必须回退默认窗口，绝不猜）。
 */
export function getFirstByteP90Ms(host: string, at: Date = new Date()): number | null {
  ensureHydrated(); // restart must not forget yesterday's buckets (nnd.25 E)
  const ring = buckets.get(bucketKey(host, at.getUTCHours()));
  if (!ring || ring.length < MIN_SAMPLES_FOR_PROFILE) return null;
  const sorted = [...ring].sort((a, b) => a - b);
  return percentile(sorted, 90);
}

/**
 * nnd.23 ②: profile-aware window for the fresh-socket direct segment.
 * Semantics: profiles may only NARROW the window below the aligned default
 * (fail fast on empirically-fast upstreams, freeing the rotation budget for
 * other seats); they can never widen past it (the ceiling is nnd.21 候A's
 * alignment, not a per-request guess). p90 × 2.5 headroom covers load-window
 * variance below the ceiling; clamped to [pooledMs, defaultWindowMs].
 */
export function applyFirstByteProfileToWindow(
  defaultWindowMs: number,
  pooledMs: number,
  profileP90Ms: number | null
): number {
  if (!(defaultWindowMs > 0)) return defaultWindowMs; // bound disabled → stay disabled
  if (profileP90Ms === null || !Number.isFinite(profileP90Ms) || profileP90Ms <= 0) {
    return defaultWindowMs;
  }
  const candidate = Math.round(profileP90Ms * 2.5);
  return Math.min(defaultWindowMs, Math.max(pooledMs, candidate));
}

/** Test-only: clear all buckets + persistence/hydration state. */
export function __test_resetUpstreamProfiles(): void {
  buckets.clear();
  hydrated = false;
  lastPersistAtMs = 0;
  dirtySincePersist = false;
}
