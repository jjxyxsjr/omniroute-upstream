import { isPrivateHost } from "@/shared/network/privateHost";

type DirectFetchOptions = RequestInit & { dispatcher?: unknown };
type DirectFetch = (input: RequestInfo | URL, options: DirectFetchOptions) => Promise<Response>;

const DEFAULT_DIRECT_HEADERS_TIMEOUT_MS = 30_000;
/** Local/self-hosted backends (Ollama, LM Studio, host.docker.internal) often need >30s TTFB. */
const DEFAULT_LOCAL_DIRECT_HEADERS_TIMEOUT_MS = 300_000;
const DIRECT_RESPONSE_START_TIMEOUT_CODE = "DIRECT_RESPONSE_START_TIMEOUT";
// Transition slack between the pooled probe and the fresh-socket attempt
// (first-attempt teardown + re-issue) so the executor budget never expires
// exactly at the seam between the two windows.
const NON_STREAM_BUDGET_SLACK_MS = 5_000;

// #13703 — the fresh-socket RETRY (2nd direct attempt) reused the pooled
// attempt's short flat watchdog and 504'd healthy slow-TTFB upstreams: unlike
// the pooled attempt (a possibly-dead keep-alive socket, #10214), the retry is
// a brand-new socket with nothing to detect, so it defers to the caller's own
// (larger) deadline signal when one is present — see resolveDirectRetryTimeoutMs.
const DEFAULT_DIRECT_RETRY_CEILING_MS = 600_000;

// Reasoning models (GLM-5.2/5.3 reasoning.effort=high/max, codex-gpt-5.x-high,
// third-party Claude-format replicas) warm up with a ~78s+ TTFB before emitting
// the first byte. The stream-readiness layer (streamReadinessPolicy.ts) already
// budgets 180s for this class (claude_format_heavy_reasoning /
// codex_gpt_5_5_high_reasoning +30s bumps over an 80s base). This fetch-layer
// guard must align to the SAME ceiling so it does not pre-empt a warm reasoning
// response that the readiness layer would have permitted — that mismatch is the
// 504 regression introduced by 142ae9349 (flat 30s cut a 78s+ reasoning TTFB).
const REASONING_READINESS_CEILING_MS = 180_000;
// Bounded, non-overlapping pattern: a quoted "reasoning_effort" or nested
// "effort" field whose value is high or max. No variable-length quantifier
// overlap → no ReDoS surface (project PII rule #1).
const HIGH_REASONING_EFFORT_PATTERN = /"(?:reasoning_effort|effort)"\s*:\s*"(?:high|max)"/i;

function hasHighReasoningEffort(body?: string | null): boolean {
  if (!body || typeof body !== "string") return false;
  return HIGH_REASONING_EFFORT_PATTERN.test(body);
}

function isLocalDirectTarget(targetUrl?: string | null): boolean {
  if (!targetUrl) return false;
  try {
    return isPrivateHost(new URL(targetUrl).hostname);
  } catch {
    return false;
  }
}

function resolveLocalDirectHeadersFloorMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.OMNIROUTE_LOCAL_DIRECT_HEADERS_TIMEOUT_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_LOCAL_DIRECT_HEADERS_TIMEOUT_MS;
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
  return !(
    raw.trim().toLowerCase() === "0" ||
    raw.trim().toLowerCase() === "false" ||
    raw.trim().toLowerCase() === "off"
  );
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

function resolveFlatDirectHeadersFloorMs(
  env: Record<string, string | undefined>,
  body?: string | null,
  targetUrl?: string | null
): number {
  const raw = env.OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS;
  let base =
    raw == null || raw.trim() === ""
      ? DEFAULT_DIRECT_HEADERS_TIMEOUT_MS
      : Number.isFinite(Number(raw)) && Number(raw) > 0
        ? Math.floor(Number(raw))
        : 0;
  // Operator override is a FLOOR: reasoning/local awareness only raises the budget,
  // never lowers it. An override above the ceiling (e.g. 240s) is preserved.
  if (hasHighReasoningEffort(body)) {
    base = Math.max(base, REASONING_READINESS_CEILING_MS);
  }
  if (isLocalDirectTarget(targetUrl)) {
    base = Math.max(base, resolveLocalDirectHeadersFloorMs(env));
  }
  return base;
}

// nnd.36 (#96 52-merge revision): serialize a body ONLY when it plausibly
// reaches the #88 volume tiers. Upstream 52's serialization-parity contract
// keeps exactly ONE JSON.stringify per execution, so the outer deadline
// bindings must not add a second one for ordinary bodies. Bounded structural
// estimate (underestimates ~3-5% vs real JSON — the 400KB gate compensates;
// tier thresholds are 512KB/2MB).
export function serializeBodyForDeadlineTier(body: unknown): string | null {
  const estimate = (v: unknown, depth: number): number => {
    if (v === null || v === undefined) return 4;
    switch (typeof v) {
      case "string":
        return v.length + 2;
      case "number":
      case "boolean":
        return 8;
      case "object": {
        if (depth > 12) return 32;
        if (Array.isArray(v)) {
          let sum = 2;
          for (const item of v) sum += estimate(item, depth + 1) + 1;
          return sum;
        }
        let sum = 2;
        for (const [k, val] of Object.entries(v))
          sum += k.length + 4 + estimate(val, depth + 1) + 1;
        return sum;
      }
      default:
        return 16;
    }
  };
  return estimate(body, 0) >= 400_000 ? JSON.stringify(body) : null;
}

// #13703: `attempt` 0 is the pooled dispatcher (flat floor, #10214's
// zombie-socket rationale); attempt 1+ is the fresh-socket retry, which has
// no zombie to detect and so defers to resolveDirectRetryTimeoutMs instead.
export function resolveDirectHeadersTimeoutMs(
  env: Record<string, string | undefined> = process.env,
  body?: string | null,
  attempt = 0,
  hasCallerDeadline = false,
  targetUrl?: string | null
): number {
  const flatFloorMs = resolveFlatDirectHeadersFloorMs(env, body, targetUrl);
  if (attempt === 0) {
    // nnd.29 #88: apply the volume-aware tier to the pooled probe so a large
    // body gets a longer first-byte window (prefill scales with size). 51
    // defined the helper but never wired it into attempt 0.
    const bodyBytes = body ? Buffer.byteLength(body) : 0;
    return resolveVolumeAwareDirectHeadersTimeoutMs(flatFloorMs, bodyBytes, env);
  }
  return resolveDirectRetryTimeoutMs(flatFloorMs, hasCallerDeadline, env);
}

/**
 * Per-request resolver for the direct no-proxy attempts in proxyFetch: binds the
 * request body (reasoning-effort awareness), caller-deadline presence (retry
 * ceiling) and target URL (local/LAN floor) once, so each attempt
 * (0 = pooled dispatcher, 1+ = fresh-socket retry) resolves its own budget.
 */
export function directHeadersTimeoutResolver(
  options: { body?: unknown; signal?: unknown },
  targetUrl?: string | null
): (attempt: number) => number {
  const body = typeof options.body === "string" ? options.body : null;
  const hasCallerDeadline = !!options.signal;
  return (attempt) =>
    resolveDirectHeadersTimeoutMs(process.env, body, attempt, hasCallerDeadline, targetUrl);
}

/**
 * Resolves the fresh-socket RETRY attempt's response-start ceiling (#13703).
 *
 * `hasCallerDeadline` is true when the caller already attached its own
 * AbortSignal to the request (in production, the resolved connection ->
 * model -> provider -> FETCH_TIMEOUT_MS cascade, merged in by the executor
 * layer before proxyFetch ever sees the request). In that case the caller's
 * own signal is the REAL deadline and always fires first in the intended
 * path, so the retry gets a generous backstop ceiling
 * (OMNIROUTE_DIRECT_RESPONSE_RETRY_TIMEOUT_MS, default 600s) instead of
 * reusing the short flat pooled-attempt floor.
 *
 * When there is no caller-supplied deadline at all, there is no larger budget
 * to defer to, so the retry keeps the SAME flat floor as the pooled attempt
 * (`flatFloorMs`) — preserving #10214's original zombie-socket-detection
 * behavior for callers that never pass their own signal.
 */
export function resolveDirectRetryTimeoutMs(
  flatFloorMs: number,
  hasCallerDeadline: boolean,
  env: Record<string, string | undefined> = process.env
): number {
  if (!hasCallerDeadline) return flatFloorMs;
  const raw = env.OMNIROUTE_DIRECT_RESPONSE_RETRY_TIMEOUT_MS;
  const ceiling =
    raw == null || raw.trim() === ""
      ? DEFAULT_DIRECT_RETRY_CEILING_MS
      : Number.isFinite(Number(raw)) && Number(raw) > 0
        ? Math.floor(Number(raw))
        : DEFAULT_DIRECT_RETRY_CEILING_MS;
  // The env var is a ceiling operators can tune down; it must never be
  // allowed to undercut the flat floor (that would re-introduce the original
  // #10214 zombie-socket-detection gap on the retry attempt).
  return Math.max(flatFloorMs, ceiling);
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
  // #12861: guards a narrow but real race between the timer macrotask and the
  // fetch promise settling. If `fetchImpl` has already resolved/rejected by
  // the time this timer fires, aborting now delivers the abort reason to a
  // promise nobody is awaiting anymore — Node promotes that to an
  // unhandledRejection -> uncaughtException and kills the process. Once the
  // attempt has settled, the timer becomes a no-op instead: the caller
  // already has its answer, and there's nothing left to abort for.
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    attemptController.abort(createDirectResponseStartTimeout(timeoutMs));
  }, timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(input, {
      ...options,
      signal: mergeAbortSignals(options.signal, attemptController.signal),
    });
    settled = true;
    return response;
  } catch (err) {
    settled = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
