/**
 * transient5xxInternalizer.ts — #113-C: transient upstream 5xx internalization.
 *
 * Production evidence (2026-11-04 13:59-14:33): 8 user-visible 500s from GLM
 * [1234] "网络错误" (network errors). These are transient upstream issues that
 * the gateway should retry on the next target instead of surfacing as terminal.
 *
 * The principle mirrors #113-B: single-account transient failures should be
 * absorbed by the pool. Only persistent (identical error across ALL targets)
 * or request-scoped errors (context overflow, malformed request) should
 * surface to the client.
 *
 * #113-C (nnd.40). Evidence: issue #215 note 16737.
 */

export interface Transient5xxClassification {
  shouldRetry: boolean;
  reason: string;
  /** How long to wait before retrying (ms). 0 = immediate. */
  backoffMs: number;
}

const TRANSIENT_5XX_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\[1234\].*网络错误/s, label: "glm_network_error" },
  { re: /internal server error/is, label: "generic_500" },
  { re: /bad gateway/is, label: "bad_gateway_502" },
  { re: /service unavailable/is, label: "service_unavailable_503" },
  { re: /gateway timeout/is, label: "gateway_timeout_504" },
  { re: /connection reset by peer/is, label: "connection_reset" },
  { re: /ETIMEDOUT|ECONNREFUSED|ECONNRESET/is, label: "socket_error" },
];

const NON_TRANSIENT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /context.*too.*large|上下文.*超限/is, label: "context_overflow" },
  { re: /model.*not.*found/is, label: "model_not_found" },
  { re: /invalid.*api.*key|unauthorized/is, label: "auth_error" },
  { re: /STREAM_READINESS_TIMEOUT/s, label: "readiness_deadline" },
];

export function classifyTransient5xx(
  status: number,
  errorText: string
): Transient5xxClassification {
  const text = errorText || "";

  // Request-scoped errors are never transient — retrying won't help
  for (const { re, label } of NON_TRANSIENT_PATTERNS) {
    if (re.test(text)) {
      return { shouldRetry: false, reason: label, backoffMs: 0 };
    }
  }

  if (status >= 500 && status < 600) {
    for (const { re, label } of TRANSIENT_5XX_PATTERNS) {
      if (re.test(text)) {
        return { shouldRetry: true, reason: label, backoffMs: 1_000 };
      }
    }
    // Unknown 5xx: default to retryable (conservative — better to try another
    // target than surface an error the pool might absorb)
    return { shouldRetry: true, reason: `unknown_${status}`, backoffMs: 2_000 };
  }

  return { shouldRetry: false, reason: `status_${status}_not_5xx`, backoffMs: 0 };
}
