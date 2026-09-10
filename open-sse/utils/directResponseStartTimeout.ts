type DirectFetchOptions = RequestInit & { dispatcher?: unknown };
type DirectFetch = (
  input: RequestInfo | URL,
  options: DirectFetchOptions
) => Promise<Response>;

const DEFAULT_DIRECT_HEADERS_TIMEOUT_MS = 30_000;
const DIRECT_RESPONSE_START_TIMEOUT_CODE = "DIRECT_RESPONSE_START_TIMEOUT";

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
 * socket fails instantly on a fresh one), but ark-class anthropic-compatible
 * upstreams withhold even HTTP headers through a cold prefill (~45-50s for a
 * 66k body) — a flat second 45s kills a healthy slow upstream before the
 * stream-readiness budget (60-120s adaptive) ever starts counting. Align the
 * fresh-socket window with that budget's ceiling; worst case stays bounded at
 * first + max. Never narrows below the pooled window, and a disabled bound
 * (<=0) disables both segments.
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
  return pooledMs + freshMs + 5_000;
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
