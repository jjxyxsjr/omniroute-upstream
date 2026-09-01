/**
 * Sliding-window debounce for provider connection tests (017).
 *
 * A management-dashboard tab left open fires the batch connection-test loop
 * every ~300s around the clock: ~2000 call_logs rows/day of noise, real
 * upstream probes that keep re-anchoring 5h quota windows, and lastError/
 * backoff resets that erase real failure visibility. A per-connection result
 * cache keyed by completion time absorbs that loop.
 *
 * Two deliberate semantics:
 *   - The window does NOT slide on a hit. The observed tab cadence is exactly
 *     300s; a fixed TTL refreshed on access would resonate with it and lapse
 *     every cycle. Re-hits keep the original completion timestamp.
 *   - Failed results age out at half the window so genuine breakage is
 *     re-probed sooner than success is.
 *
 * `forceRefresh: true` (operator "Test" button, credential-health scheduler)
 * bypasses the cache on lookup and therefore always performs a real test.
 */

export interface ConnectionTestDebounceOptions {
  /** Milliseconds a successful result stays reusable. 0 disables the debounce. */
  windowMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface ConnectionTestDebounceHit {
  result: unknown;
  debounced: true;
}

export interface ConnectionTestDebounce {
  /**
   * Returns the cached result when one is still fresh, or undefined when a
   * real test should run. `forceRefresh` always returns undefined.
   */
  lookup(connectionId: string, opts?: { forceRefresh?: boolean }): ConnectionTestDebounceHit | undefined;
  /** Store a completed real-test result. `failed` halves the retention. */
  record(connectionId: string, result: unknown, failed: boolean): void;
}

interface CacheEntry {
  completedAt: number;
  failed: boolean;
  result: unknown;
}

export function createConnectionTestDebounce(
  options: ConnectionTestDebounceOptions
): ConnectionTestDebounce {
  const { windowMs } = options;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();

  return {
    lookup(connectionId, opts) {
      if (windowMs <= 0 || opts?.forceRefresh) return undefined;
      const entry = cache.get(connectionId);
      if (!entry) return undefined;
      const effectiveMs = entry.failed ? windowMs / 2 : windowMs;
      if (now() - entry.completedAt >= effectiveMs) {
        cache.delete(connectionId);
        return undefined;
      }
      return { result: entry.result, debounced: true };
    },
    record(connectionId, result, failed) {
      cache.set(connectionId, { completedAt: now(), failed, result });
    },
  };
}

const CONNECTION_TEST_DEBOUNCE_DEFAULT_MS = 300_000;

/** Resolve the debounce window from OMNIROUTE_TEST_DEBOUNCE_MS (0 = off). */
export function resolveConnectionTestDebounceMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OMNIROUTE_TEST_DEBOUNCE_MS;
  if (raw === undefined || raw === "") return CONNECTION_TEST_DEBOUNCE_DEFAULT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return CONNECTION_TEST_DEBOUNCE_DEFAULT_MS;
  return parsed;
}

/** Process-wide shared instance used by the connection-test HTTP surfaces. */
let sharedInstance: ConnectionTestDebounce | null = null;

export function getSharedConnectionTestDebounce(): ConnectionTestDebounce {
  if (!sharedInstance) {
    sharedInstance = createConnectionTestDebounce({
      windowMs: resolveConnectionTestDebounceMs(process.env),
    });
  }
  return sharedInstance;
}
