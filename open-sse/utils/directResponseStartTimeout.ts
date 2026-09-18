type DirectFetchOptions = RequestInit & { dispatcher?: unknown };
type DirectFetch = (
  input: RequestInfo | URL,
  options: DirectFetchOptions
) => Promise<Response>;

const DEFAULT_DIRECT_HEADERS_TIMEOUT_MS = 30_000;
const DIRECT_RESPONSE_START_TIMEOUT_CODE = "DIRECT_RESPONSE_START_TIMEOUT";
// Transition slack between the pooled probe and the fresh-socket attempt
// (first-attempt teardown + re-issue) so the executor budget never expires
// exactly at the seam between the two windows.
const NON_STREAM_BUDGET_SLACK_MS = 5_000;

export function resolveDirectHeadersTimeoutMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_DIRECT_HEADERS_TIMEOUT_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  // nnd.18: invalid values fall back to the default, NOT 0 (which silently disabled
  // the bound — a typo like "30000s" would restore the pre-nnd.14 unbounded hang).
  console.warn(
    `[directResponseStartTimeout] OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS="${raw}" is invalid — falling back to ${DEFAULT_DIRECT_HEADERS_TIMEOUT_MS}ms (set a positive integer or unset to use default)`
  );
  return DEFAULT_DIRECT_HEADERS_TIMEOUT_MS;
}

/**
 * nnd.21 候A: response-start window for the SECOND direct attempt (fresh
 * no-keep-alive socket). The pooled attempt keeps the operator's
 * OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS as a poisoning probe (a half-open pooled
 * socket fails instantly on a fresh one), while ark-class anthropic-compatible
 * upstreams send nothing — not even HTTP headers — until they are ready.
 * ⚠️ 2026-09-10 更正（155 #49，直连对账证伪）：初版注释把"66k 冷体需 ~45-50s"
 * 写成尺寸固有行为——实测同量级冷体直连 14 时窗 8-9s 即吐头；45s+ 沉默实为上游
 * 负载窗摆动（15-30 倍族），时长是分布不是常数。窗口不收紧的结论不变（9-09
 * 误杀有同账号同刻 20×200 实锤），但预算值应来自分时段画像（nnd.23 主题②）
 * 而非任何单点常数。
 */
export function resolveFreshSocketResponseStartTimeoutMs(
  pooledMs: number,
  streamReadinessMaxTimeoutMs: number
): number {
  if (!(pooledMs > 0)) return pooledMs;
  if (!Number.isFinite(streamReadinessMaxTimeoutMs)) return pooledMs;
  const floor = Math.floor(streamReadinessMaxTimeoutMs);
  if (!(floor > 0)) return pooledMs;
  return Math.max(pooledMs, floor);
}

/**
 * nnd.22 补丁①: TOTAL outer budget for a NON-STREAMING executor call whose
 * underlying fetch is the patched global (proxyFetch) — its direct path runs
 * the two-segment logic (pooled probe + fresh-socket window) internally, so
 * the executor-level safety bound must cover the full inner worst case
 * (pooled + fresh + slack), never a flat copy of the pooled window. The flat
 * 45s outer bound (nnd.14 era) short-circuited the inner logic: non-stream
 * requests got a single 45s wall with no fresh-socket retry — observed live
 * 2026-09-10 11:25-12:05 BJ as a 30+-request 504 storm on glm-5.3-flash
 * (124KB context-handoff bodies needing >45s to first byte; all 7 rotated
 * accounts "silent" because every attempt died at exactly 45s).
 */
export function resolveNonStreamTotalBudgetMs(
  pooledMs: number,
  streamReadinessMaxTimeoutMs: number
): number {
  if (!(pooledMs > 0)) return pooledMs;
  const freshMs = resolveFreshSocketResponseStartTimeoutMs(pooledMs, streamReadinessMaxTimeoutMs);
  return pooledMs + freshMs + NON_STREAM_BUDGET_SLACK_MS;
}

/**
 * nnd.29 #88: volume-aware first-byte probe window. A flat 45s probe cannot
 * distinguish "dead pooled socket" from "live upstream still prefilling a huge
 * context": 600k-token Claude Code sessions measured 40-75s to first byte on
 * glm (bare-fetch path, no probe → survived), while the same sessions on the
 * proxyFetch direct path (ark-class anthropic-compatible) died at exactly 45s
 * (2026-09-18 向海涛 2×504, 1821-message transcript). Tiers mirror the
 * #53/#23 precedent of scaling deadlines by request parameters:
 *   ≤512KB  → base (small bodies overrunning the probe ≈ dead connection)
 *   >512KB  → ×2
 *   >2MB    → ×3, capped at 180s.
 * Fresh-socket and profile narrowing chain automatically (their floors are
 * keyed to the pooled window). Kill switch: OMNIROUTE_DIRECT_HEADERS_VOLUME_ADAPTIVE=0.
 */
const LARGE_BODY_TIER_BYTES = 512 * 1024;
const HUGE_BODY_TIER_BYTES = 2 * 1024 * 1024;
const VOLUME_AWARE_WINDOW_CAP_MS = 180_000;

export function isVolumeAdaptiveDirectHeadersEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env.OMNIROUTE_DIRECT_HEADERS_VOLUME_ADAPTIVE;
  if (raw == null || raw.trim() === "") return true;
  return !(raw.trim().toLowerCase() === "0" || raw.trim().toLowerCase() === "false" || raw.trim().toLowerCase() === "off");
}

export function resolveVolumeAwareDirectHeadersTimeoutMs(
  baseMs: number,
  bodyBytes: number,
  env: Record<string, string | undefined> = process.env
): number {
  if (!(baseMs > 0) || !(bodyBytes > 0)) return baseMs;
  if (!isVolumeAdaptiveDirectHeadersEnabled(env)) return baseMs;
  let factor = 1;
  if (bodyBytes > HUGE_BODY_TIER_BYTES) factor = 3;
  else if (bodyBytes > LARGE_BODY_TIER_BYTES) factor = 2;
  if (factor === 1) return baseMs;
  return Math.min(baseMs * factor, VOLUME_AWARE_WINDOW_CAP_MS);
}

/**
 * Best-effort body size for the probe-window tier: Request → Content-Length
 * (or cloned body length), string → length, ArrayBuffer/TypedArray →
 * byteLength. Unknown shapes (streams, form data) return 0 = conservative
 * base window (never widens on guesses).
 */
export function measureDirectRequestBodyBytes(
  input: RequestInfo | URL,
  options?: DirectFetchOptions
): number {
  try {
    if (typeof Request !== "undefined" && input instanceof Request) {
      const len = Number(input.headers.get("content-length"));
      if (Number.isFinite(len) && len > 0) return len;
      return 0;
    }
    const body = options?.body;
    if (typeof body === "string") return Buffer.byteLength(body);
    if (body instanceof ArrayBuffer) return body.byteLength;
    if (ArrayBuffer.isView(body)) return (body as Uint8Array).byteLength;
    return 0;
  } catch {
    return 0;
  }
}

function createDirectResponseStartTimeout(timeoutMs: number): Error & { code: string } {
  const err = new Error(
    `Direct response did not start within ${timeoutMs}ms — retrying on a fresh socket`
  ) as Error & { code: string };
  err.name = "TimeoutError";
  err.code = DIRECT_RESPONSE_START_TIMEOUT_CODE;
  return err;
}

export function isDirectResponseStartTimeout(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    err.code === DIRECT_RESPONSE_START_TIMEOUT_CODE
  );
}

function mergeAbortSignals(
  primary: AbortSignal | null | undefined,
  secondary: AbortSignal
): AbortSignal {
  if (!primary) return secondary;
  if (primary.aborted) return primary;
  const controller = new AbortController();
  const onPrimaryAbort = () => controller.abort(primary.reason);
  const onSecondaryAbort = () => controller.abort(secondary.reason);
  const cleanup = () => {
    primary.removeEventListener("abort", onPrimaryAbort);
    secondary.removeEventListener("abort", onSecondaryAbort);
  };
  primary.addEventListener("abort", onPrimaryAbort, { once: true });
  secondary.addEventListener("abort", onSecondaryAbort, { once: true });
  controller.signal.addEventListener("abort", cleanup, { once: true });
  return controller.signal;
}

export async function directFetchWithBoundedResponseStart(
  input: RequestInfo | URL,
  options: DirectFetchOptions,
  fetchImpl: DirectFetch,
  timeoutMs: number
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) return fetchImpl(input, options);
  const attemptController = new AbortController();
  const timer = setTimeout(
    () => attemptController.abort(createDirectResponseStartTimeout(timeoutMs)),
    timeoutMs
  );
  timer.unref?.();
  try {
    return await fetchImpl(input, {
      ...options,
      signal: mergeAbortSignals(options.signal, attemptController.signal),
    });
  } finally {
    clearTimeout(timer);
  }
}
