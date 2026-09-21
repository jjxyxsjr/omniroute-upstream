/**
 * poolBlockageGate.ts — nnd.30 受阻池自适应闸门（161 设计件 A+B/C）。
 *
 * 背景（两场事故，2026-09-21）：combo 全部目标被"短暂"阻碍（模型冷却 /
 * 连接限流暂停 / 并发帽 / 配额窗尾）时，主河道 0.2s 秒拒 503
 * ALL_TARGETS_SKIPPED——无 Retry-After、无排队、service_unavailable 语义
 * 诱导客户端立刻硬重试 → 幸存席位持续饱和 → 错误自我放大（胡健荣钉扎
 * 25 连发；GLM 七账号同步撞墙后九用户 140 笔）。
 *
 * 契约：席位受阻是网关内部状态，客户端最多感知"慢"，不感知错误风暴。
 * 本模块只回答一个问题：**现在全池最早恢复时刻在等待帽之内吗？**
 *   - 在 → 请求有界挂起，到点唤醒重走派发（"redispatch"）
 *   - 不在 / 帽关闭 / 队列满 / 客户端断开 → 交给调用方走诚实错误出口
 *     （429 + Retry-After，见 combo.ts ALL_TARGETS_SKIPPED 分支）
 *
 * 约束：单请求只消费自己的等待预算（不做循环重挂——重挂由 combo 的
 * setTry 循环重入驱动，每次重入重新评估）；挂起不占任何席位信号量；
 * 每 combo 挂起数有上限（默认 64，防洪峰变停车场）；全程感知客户端
 * abort（→ "abort"，499 账本语义由调用方落）。
 */

type GateLog = {
  info?: (tag: string, msg: string, extra?: unknown) => void;
  warn?: (tag: string, msg: string, extra?: unknown) => void;
} | null;

export const DEFAULT_POOL_WAIT_CAP_MS = 10_000;
export const DEFAULT_POOL_PARK_MAX = 64;
/** Poll slice ceiling: wake at least this often so concurrency-cap releases
 * (no wall-clock readyAt) are picked up without event wiring. */
const PARK_POLL_SLICE_MS = 1_000;

export function resolvePoolWaitCapMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.OMNIROUTE_POOL_WAIT_CAP_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_POOL_WAIT_CAP_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  // nnd.18 惯例：无效值回落默认（不是 0——0 是显式关闭）。
  console.warn(
    `[poolBlockageGate] OMNIROUTE_POOL_WAIT_CAP_MS="${raw}" is invalid — falling back to ${DEFAULT_POOL_WAIT_CAP_MS}ms`
  );
  return DEFAULT_POOL_WAIT_CAP_MS;
}

export function resolvePoolParkMax(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.OMNIROUTE_POOL_PARK_MAX;
  if (raw == null || raw.trim() === "") return DEFAULT_POOL_PARK_MAX;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  return DEFAULT_POOL_PARK_MAX;
}

/** Terminal status for the blocked-pool exit: 429 (default, rate-limit
 * semantics that engage client SDK backoff) or 503 (hot rollback anchor). */
export function resolveBlockedPoolStatus(
  env: Record<string, string | undefined> = process.env
): 429 | 503 {
  const raw = (env.OMNIROUTE_BLOCKED_POOL_STATUS || "").trim().toLowerCase();
  if (raw === "503") return 503;
  return 429;
}

export type PoolGateDecision = "redispatch" | "timeout" | "abort";

/** Per-combo parked-request registry (bounded queue). */
const parkedPerCombo = new Map<string, number>();

export function resetPoolGateStateForTests(): void {
  parkedPerCombo.clear();
}

export function parkedCountForCombo(comboName: string): number {
  return parkedPerCombo.get(comboName) ?? 0;
}

function sleepAbortable(ms: number, signal?: AbortSignal | null): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Per-request gate. `parkFor` may be called multiple times across combo
 * setTry re-entries (each re-entry re-evaluates); the wait budget is shared
 * across those calls so total park time stays under the cap.
 */
export function createPoolBlockageGate(args: {
  comboName: string;
  log?: GateLog;
  signal?: AbortSignal | null;
  env?: Record<string, string | undefined>;
}): {
  parkFor: (earliestReadyAtMs: number | null) => Promise<PoolGateDecision>;
  /** True if at least one park happened (for logging/observability). */
  parkedOnce: () => boolean;
} {
  const capMs = resolvePoolWaitCapMs(args.env);
  const parkMax = resolvePoolParkMax(args.env);
  const comboName = args.comboName;
  const log = args.log ?? null;
  const signal = args.signal ?? null;
  let budgetLeftMs = capMs;
  let parked = false;

  const releaseSlot = () => {
    const cur = parkedPerCombo.get(comboName) ?? 0;
    if (cur <= 1) parkedPerCombo.delete(comboName);
    else parkedPerCombo.set(comboName, cur - 1);
  };

  const parkFor = async (earliestReadyAtMs: number | null): Promise<PoolGateDecision> => {
    if (capMs <= 0) return "timeout";
    if (earliestReadyAtMs == null || !Number.isFinite(earliestReadyAtMs)) return "timeout";
    const remaining = earliestReadyAtMs - Date.now();
    if (remaining > budgetLeftMs) return "timeout";
    const cur = parkedPerCombo.get(comboName) ?? 0;
    if (cur >= parkMax) {
      log?.warn?.(
        "COMBO",
        `Pool gate park queue full for ${comboName} (${cur}/${parkMax}) — falling to error exit`
      );
      return "timeout";
    }
    parkedPerCombo.set(comboName, cur + 1);
    parked = true;
    try {
      log?.info?.(
        "COMBO",
        `Pool gate parking request for ${comboName} — earliest seat ready in ${(
          Math.max(0, remaining) / 1000
        ).toFixed(1)}s (budget ${(budgetLeftMs / 1000).toFixed(1)}s)`
      );
      // Poll slices: wake early for abort + pick up cap-slot releases whose
      // readyAt is unknown (the skip site reports a 1s poll signal).
      while (true) {
        const left = earliestReadyAtMs - Date.now();
        if (left <= 0) break;
        const slice = Math.min(left, PARK_POLL_SLICE_MS, budgetLeftMs);
        if (slice <= 0) break;
        const sliceStart = Date.now();
        const woke = await sleepAbortable(slice, signal);
        budgetLeftMs = Math.max(0, budgetLeftMs - (Date.now() - sliceStart));
        if (!woke) return "abort";
        if (earliestReadyAtMs - Date.now() <= 0) break;
        if (budgetLeftMs <= 0) break;
      }
      const ready = earliestReadyAtMs - Date.now() <= 0;
      if (!ready && budgetLeftMs <= 0) return "timeout";
      log?.info?.("COMBO", `Pool gate woke for ${comboName} — redispatching`);
      return "redispatch";
    } finally {
      releaseSlot();
    }
  };

  return { parkFor, parkedOnce: () => parked };
}
