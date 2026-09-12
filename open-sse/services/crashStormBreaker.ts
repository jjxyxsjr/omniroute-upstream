/**
 * Crash-storm breaker（nnd.25，2026-09-13 —— 9-8 停摆悬案的源码面根治）.
 *
 * 病理（2026-09-08 BJ 12-13 时实测）：请求路径代码炸弹（undefined.bind ×445 笔/35 分钟）
 * 连环快败时无任何闸——provider 熔断器（src/shared/utils/circuitBreaker）在两处刻意
 * 留白：#12233 把"本机执行错误"排除在 provider 熔断之外（我们的 bug 不拉黑无辜上游，
 * 哲学正确）；#12360 之前"已成形 5xx 响应"也不计数。结果：自伤风暴两边都没人管。
 *
 * 本件补位：按 provider × 归一化错误签名 计数，滑窗内同签名快败 ≥ 阈值 →
 * evaluateExecuteTargetGates 以 reason="crash_storm" 跳过该 provider 的目标
 * （健康道照常；全道炸弹则全道齐熔，9-8 形态收敛为快速 503 而非 445 笔连环锤）。
 * 窗口自然衰减 = 自愈；熔断只跳过 dispatch，绝不写 provider 冷却/锁（不污染上游信誉）。
 *
 * 环境旋钮（懒读，热生效）：
 *   OMNIROUTE_CRASH_STORM_THRESHOLD  同窗同签名触发数（默认 10；0=禁用）
 *   OMNIROUTE_CRASH_STORM_WINDOW_MS  滑窗毫秒（默认 300000=5 分钟）
 */

const MAX_TRACKED_SIGNATURES = 256;
const MAX_SAMPLES_PER_KEY = 64;
const SIGNATURE_MAX_LEN = 120;

/**
 * 归一化错误签名：截断 + 崩塌易变段——十六进制串（UUID 段/请求 id/objectId）与
 * 连续数字各自折叠为 #，让"同族不同 id"落进同一个键（9-8 的 anthropic-compatible-
 * <uuid>/tc-code-latest 形态实测存在 id 漂移）。
 */
export function normalizeCrashSignature(message: string | undefined | null): string {
  if (typeof message !== "string") return "";
  return message
    .trim()
    .replace(/[0-9a-f]{4,}/gi, (m) => (/\d/.test(m) ? "#" : m))
    .replace(/\d+/g, "#")
    .slice(0, SIGNATURE_MAX_LEN);
}

function resolveThreshold(): number {
  const raw = Number(process.env.OMNIROUTE_CRASH_STORM_THRESHOLD);
  return Number.isFinite(raw) ? raw : 10;
}

function resolveWindowMs(): number {
  const raw = Number(process.env.OMNIROUTE_CRASH_STORM_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

/** provider|sig → 窗口内时间戳环（升序 push，越界即弃）。 */
const stormSamples = new Map<string, number[]>();

function prune(key: string, now: number, windowMs: number): number[] {
  const samples = stormSamples.get(key);
  if (!samples) return [];
  const cutoff = now - windowMs;
  while (samples.length > 0 && samples[0] < cutoff) samples.shift();
  return samples;
}

/**
 * 记一笔失败。只记 5xx（429/4xx 有各自的配额与凭据机制，不计风暴）；
 * 空消息无法签名，跳过。per-attempt 调用——多目标 combo 的一次请求最多贡献
 * 每 provider 一笔，阈值按"每 provider 窗口内同签名次数"理解。
 */
export function recordCrashFailure(
  provider: string | undefined | null,
  message: string | undefined | null,
  status: number
): void {
  const threshold = resolveThreshold();
  if (threshold <= 0) return;
  if (typeof status !== "number" || status < 500) return;
  const signature = normalizeCrashSignature(message);
  if (!signature) return;

  const key = `${String(provider || "unknown")}|${signature}`;
  const now = Date.now();
  const samples = prune(key, now, resolveWindowMs());
  samples.push(now);
  if (samples.length > MAX_SAMPLES_PER_KEY) samples.shift();
  stormSamples.set(key, samples);

  // 有界性：签名族上限（防长跑内存增长），超限逐出最旧键。
  if (stormSamples.size > MAX_TRACKED_SIGNATURES) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of stormSamples) {
      const last = v[v.length - 1] ?? 0;
      if (last < oldestTs) {
        oldestTs = last;
        oldestKey = k;
      }
    }
    if (oldestKey) stormSamples.delete(oldestKey);
  }
}

/** 该 provider 当前是否风暴中（任一签名在窗内达阈值）。 */
export function isCrashStorming(provider: string | undefined | null): boolean {
  const threshold = resolveThreshold();
  if (threshold <= 0 || !provider) return false;
  const prefix = `${String(provider)}|`;
  const now = Date.now();
  const windowMs = resolveWindowMs();
  for (const [key] of stormSamples) {
    if (!key.startsWith(prefix)) continue;
    const kept = prune(key, now, windowMs);
    if (kept.length >= threshold) return true;
  }
  return false;
}

/** 诊断面（体检/排障用）：返回仍活跃的签名条目（窗内计数≥2 的）。 */
export function crashStormStatus(): Array<{ provider: string; signature: string; count: number }> {
  const now = Date.now();
  const windowMs = resolveWindowMs();
  const out: Array<{ provider: string; signature: string; count: number }> = [];
  for (const [key] of stormSamples) {
    const kept = prune(key, now, windowMs);
    if (kept.length < 2) continue;
    const [provider, ...rest] = key.split("|");
    out.push({ provider, signature: rest.join("|"), count: kept.length });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** 测试与运维重置。 */
export function resetCrashStormBreaker(): void {
  stormSamples.clear();
}
