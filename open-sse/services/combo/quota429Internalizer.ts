/**
 * quota429Internalizer.ts — #113-B: 429 quota-wall internalization.
 *
 * Operator's pool principle: the gateway is a resource pool. A single
 * account's 429 (quota wall) must NEVER surface to the client unless the
 * ENTIRE pool is exhausted. Instead, the gateway should cool that account
 * and rotate to the next one.
 *
 * Production evidence (2026-11-04): 10 user-visible 429s during the
 * 14:17-15:40 wall cluster — ark×4 (English 5h wall) + GLM [1308]×6.
 * Pool still had ≥4 GLM accounts + hy4 + agent lane with quota.
 *
 * This module provides the classification and response-building logic.
 * The combo loop calls `classify429` on every upstream 429 and acts on it:
 *   - "single-account" → cool that connection, try next target
 *   - "pool-exhausted" → return clean pool-exhausted 429 with reset time
 *
 * #113-B (nnd.40). Evidence: issue #215, 060 条目 392c903.
 */

export type Quota429Classification =
  | { kind: "single-account"; account: string; resetHint: string | null; resetAtMs: number | null }
  | { kind: "pool-exhausted"; earliestResetAt: number | null; exhaustedAccounts: string[] }
  | { kind: "rate-limit"; account: string; retryAfterMs: number | null }
  | { kind: "not-quota"; reason: string };

/**
 * Patterns for quota-wall 429s across our upstream providers.
 * These are the only 429 subtypes that should trigger internal rotation;
 * rate-limit 429s (too-fast requests) are also internalized but with a
 * short backoff instead of a long cooldown.
 *
 * nnd.41: ark walls phrase as "exceeded the <window> usage quota" — the
 * window is NOT limited to 5-hour. Production evidence 2026-11-05 00:53:
 * "exceeded the monthly usage quota" (and "weekly" since 11-04 17:27)
 * leaked raw to clients because the old pattern demanded
 * "monthly.*limit.*exceeded" (wrong word order). The generic
 * [\w-]+ window keeps future walls (daily/etc.) covered too.
 */
const QUOTA_WALL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\[1308\].*5 小时.*上限/s, label: "glm_5h_wall" },
  { re: /exceeded the [\w-]+ usage quota/is, label: "upstream_usage_wall" },
  { re: /exceeded your current quota/is, label: "anthropic_quota" },
  { re: /monthly.*limit.*exceeded/is, label: "monthly_wall" },
];

const RATE_LIMIT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\[1302\].*速率限制/s, label: "glm_rate_limit" },
  { re: /rate limit exceeded/is, label: "generic_rate_limit" },
  { re: /too many requests/is, label: "too_many_requests" },
];

/**
 * Extract reset timestamp from upstream error text as epoch ms.
 * nnd.41: ark walls carry a numeric UTC offset ("2026-11-20 23:59:59 +0800
 * CST") — the old parser treated the local wall clock as UTC, mis-timing
 * lockouts and pool-recovery hints by 8h.
 */
export function extractResetAtMs(errorText: string): number | null {
  const m = (errorText || "").match(
    /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(?:\s*([+-])(\d{2}):?(\d{2}))?/
  );
  if (!m) return null;
  const base = new Date(m[1].replace(" ", "T") + (m[1].includes("T") ? "" : "Z")).getTime();
  if (!Number.isFinite(base)) return null;
  if (m[2]) {
    // "+0800" = local is UTC+8 → UTC = local − 8h (and vice versa for "−").
    const offsetMinutes = (parseInt(m[3], 10) * 60 + parseInt(m[4], 10)) * (m[2] === "+" ? -1 : 1);
    return base + offsetMinutes * 60_000;
  }
  return base;
}

export function classify429(
  errorText: string,
  account: string,
  /** How many OTHER targets in the pool still have quota (from combo state). */
  remainingTargetCount: number
): Quota429Classification {
  const text = errorText || "";

  for (const { re, label } of QUOTA_WALL_PATTERNS) {
    if (re.test(text)) {
      if (remainingTargetCount > 0) {
        return { kind: "single-account", account, resetHint: label, resetAtMs: extractResetAtMs(text) };
      }
      return {
        kind: "pool-exhausted",
        earliestResetAt: extractResetAtMs(text),
        exhaustedAccounts: [account],
      };
    }
  }

  for (const { re } of RATE_LIMIT_PATTERNS) {
    if (re.test(text)) {
      const retryMatch = text.match(/retry.*?(\d+)\s*s/i);
      return {
        kind: "rate-limit",
        account,
        retryAfterMs: retryMatch ? parseInt(retryMatch[1], 10) * 1000 : 5_000,
      };
    }
  }

  return { kind: "not-quota", reason: text.slice(0, 100) };
}

/**
 * Build the clean pool-exhausted 429 response (never raw upstream text).
 */
export function buildPoolExhaustedResponse(
  comboName: string,
  earliestResetAt: number | null
): { status: number; code: string; message: string } {
  const resetHint = earliestResetAt
    ? ` Pool recovers ~${new Date(earliestResetAt).toISOString().slice(11, 19)}Z (${Math.ceil((earliestResetAt - Date.now()) / 60_000)} min).`
    : " Pool is cooling down; retry shortly.";
  return {
    status: 429,
    code: "POOL_EXHAUSTED",
    message: `Resource pool "${comboName}" is at capacity.${resetHint} This is a pool-level limit, not a per-account error — the gateway will auto-route to available accounts as they recover.`,
  };
}

/**
 * Determine if a 429 should be retried on another target (internalized)
 * or surfaced to the client. Returns true = internalize (rotate to next).
 */
export function shouldInternalize429(classification: Quota429Classification): boolean {
  return classification.kind === "single-account" || classification.kind === "rate-limit";
}
