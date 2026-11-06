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
  // nnd.42: ark's burst limiter (seen 2026-11-02 ×5) is a rate-limit 429 —
  // short backoff + rotate, never a wall. Without this it fell to not-quota.
  { re: /System protection triggered by request burst/is, label: "ark_burst_protection" },
  { re: /rate limit exceeded/is, label: "generic_rate_limit" },
  { re: /too many requests/is, label: "too_many_requests" },
];

/**
 * Extract reset timestamp from upstream error text as epoch ms.
 * nnd.41: ark walls carry a numeric UTC offset ("2026-11-20 23:59:59 +0800
 * CST") — the old parser treated the local wall clock as UTC, mis-timing
 * lockouts and pool-recovery hints by 8h.
 * nnd.42: a stamp WITHOUT a zone suffix is a Beijing-local wall clock — GLM
 * [1308] prose ("您的限额将在 2026-10-30 18:50:24 重置") ships bare +08:00
 * local times. Treating them as UTC ended locks 8h EARLY (a 5h wall released
 * before the wall itself). All our upstreams are CN vendors; on ambiguity,
 * lock PAST the true reset, never before it (operator ruling 2026-11-06).
 */
export function extractResetAtMs(errorText: string): number | null {
  const m = (errorText || "").match(
    /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(Z?)(?:\s*([+-])(\d{2}):?(\d{2}))?/
  );
  if (!m) return null;
  if (m[2] === "Z") {
    // ISO with trailing Z — already UTC.
    const base = new Date(m[1].replace(" ", "T") + "Z").getTime();
    return Number.isFinite(base) ? base : null;
  }
  if (m[3]) {
    // Explicit zone: treat the wall clock as UTC then shift. "+0800" = local
    // is UTC+8 → UTC = local − 8h (and vice versa for "−"). (nnd.41 logic.)
    const base = new Date(m[1].replace(" ", "T") + "Z").getTime();
    if (!Number.isFinite(base)) return null;
    const offsetMinutes = (parseInt(m[4], 10) * 60 + parseInt(m[5], 10)) * (m[3] === "+" ? -1 : 1);
    return base + offsetMinutes * 60_000;
  }
  // No zone suffix → Beijing-local wall clock (nnd.42, see docblock above).
  const base = new Date(m[1].replace(" ", "T") + "+08:00").getTime();
  return Number.isFinite(base) ? base : null;
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
 * nnd.42 wording fix: the old text said `pool "max" is at capacity … Pool
 * recovers ~<reset-of-the-WALLED-model's account>` — production evidence
 * (2026-11-06 #216) showed both halves mislead: only the REQUESTED model's
 * candidate accounts were walled (glm/hy4 were serving 200s the same
 * second), and the quoted reset was the wall of one account, not the pool.
 * Say what actually happened, in the requester's timezone.
 */
export function buildPoolExhaustedResponse(
  comboName: string,
  earliestResetAt: number | null
): { status: number; code: string; message: string } {
  const resetHint = earliestResetAt
    ? ` Earliest wall reset: ${new Date(earliestResetAt + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} (UTC+8).`
    : " Accounts are cooling down; retry shortly.";
  return {
    status: 429,
    code: "POOL_EXHAUSTED",
    message: `Resource pool "${comboName}" has no available account for this request right now (all candidate accounts for this model are quota-walled).${resetHint} Other models may still be available — the gateway auto-routes as accounts recover.`,
  };
}

/**
 * Determine if a 429 should be retried on another target (internalized)
 * or surfaced to the client. Returns true = internalize (rotate to next).
 */
export function shouldInternalize429(classification: Quota429Classification): boolean {
  return classification.kind === "single-account" || classification.kind === "rate-limit";
}
