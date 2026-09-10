/**
 * nnd.23 ② gen-1 — 上游首字画像（进程内存态）。
 *
 * 背景（155 #49 修正注）：首字时间随时段剧烈摆动（ark 60k 冷体 14 时窗 8-9s
 * vs 早窗 45s+，15-30 倍族）——任何单点常数都会在另一半时段错。本模块在
 * proxyFetch 直连成功路径上记录"响应头到达耗时"，按 (host × UTC 小时) 分桶
 * 维护环形样本，供窗口解析按当前时段取 p90。
 *
 * 设计约束：内存态（重启清零，无持久化——画像数据源的正源是 probe 体系，
 * 这里只做运行时快反馈）；每桶最少 5 个样本才出值（不足=未知=用默认，绝不
 * 拿两三个样本调窗口）；只允许把窗口"收窄到默认之下"（快上游快速失败换
 * 席位），永不放大超过对齐天花板（那是 nnd.21 候A 的领域）。
 */

const MAX_SAMPLES_PER_BUCKET = 50;
const MIN_SAMPLES_FOR_PROFILE = 5;

type SampleRing = number[];

const buckets = new Map<string, SampleRing>();

function bucketKey(host: string, hourUtc: number): string {
  return `${host.toLowerCase()}::h${hourUtc}`;
}

export function recordFirstByteMs(host: string, elapsedMs: number, at: Date = new Date()): void {
  if (!host || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
  const key = bucketKey(host, at.getUTCHours());
  const ring = buckets.get(key) ?? [];
  ring.push(Math.round(elapsedMs));
  if (ring.length > MAX_SAMPLES_PER_BUCKET) ring.splice(0, ring.length - MAX_SAMPLES_PER_BUCKET);
  buckets.set(key, ring);
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

/** Test-only: clear all buckets. */
export function __test_resetUpstreamProfiles(): void {
  buckets.clear();
}
