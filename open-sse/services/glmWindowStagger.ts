/**
 * glmWindowStagger.ts — nnd.30 GLM 5h 窗去同步（161 设计件 D）。
 *
 * 背景：智谱 1308（5h 上限）按账号开窗，七个账号的窗会自然同步（一起开
 * →一起烧满→同分钟集体见底），2026-09-21 15:46 全池同时撞墙是群体 503
 * 的导火索。智谱计费口径下缓存读也烧配额，重度 agent 流量几小时烧满一
 * 窗是常态——治本不可能，治"同步"可以。
 *
 * 机制：观察到某 glm-cn 连接的 1308 上游重置时刻 T 后，把该连接的模型
 * 锁到期时刻延长 index×stagger 分钟（index=该连接在本进程内首次观察到
 * 1308 的次序，0 起）。下一轮窗口开启时刻因此摊开：7 账号 × 8min = 最
 * 大 48 分钟离散，"同分钟集体见底"在一个周期内消失。
 *
 * 上游无错公理：纯我方路由行为，上游不感知。首周期仍同步（延长只影响
 * 锁到期，不改窗口本身）——上线当天不解决当天问题，只防复发。
 */

type StaggerEnv = Record<string, string | undefined>;

export const GLM_STAGGER_PROVIDER = "glm-cn";
export const DEFAULT_GLM_WINDOW_STAGGER_MIN = 8;

export function resolveGlmWindowStaggerMinutes(env: StaggerEnv = process.env): number {
  const raw = env.OMNIROUTE_GLM_WINDOW_STAGGER_MIN;
  if (raw == null || raw.trim() === "") return DEFAULT_GLM_WINDOW_STAGGER_MIN;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  console.warn(
    `[glmWindowStagger] OMNIROUTE_GLM_WINDOW_STAGGER_MIN="${raw}" is invalid — falling back to ${DEFAULT_GLM_WINDOW_STAGGER_MIN}`
  );
  return DEFAULT_GLM_WINDOW_STAGGER_MIN;
}

/** connectionId → first-seen order (stable per process; re-learned after restart). */
const observedOrder = new Map<string, number>();

export function resetGlmWindowStaggerForTests(): void {
  observedOrder.clear();
}

/**
 * Record a verified upstream 1308-style reset for a connection and return the
 * stagger hold (ms) to ADD to that connection's model-lockout cooldown.
 * Returns 0 when stagger is disabled, provider is not glm-cn, or the hint is
 * not a verified upstream reset (upstreamResetVerified=false guards synthetic
 * estimates from ever stretching a lockout).
 */
export function glmWindowStaggerExtraMs(args: {
  provider: string | null | undefined;
  connectionId: string | null | undefined;
  upstreamResetVerified: boolean;
  env?: StaggerEnv;
}): number {
  const staggerMin = resolveGlmWindowStaggerMinutes(args.env);
  if (staggerMin <= 0) return 0;
  if (args.provider !== GLM_STAGGER_PROVIDER) return 0;
  if (!args.upstreamResetVerified) return 0;
  const connectionId = args.connectionId?.trim();
  if (!connectionId) return 0;
  let index = observedOrder.get(connectionId);
  if (index === undefined) {
    index = observedOrder.size;
    observedOrder.set(connectionId, index);
  }
  return index * staggerMin * 60_000;
}
