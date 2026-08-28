/**
 * Non-billed health probe for Volcengine Ark plan connections.
 *
 * Both ark plan endpoints (…volces.com/api/coding, …/api/plan) 404 on
 * GET {baseUrl}/models, so the generic anthropic-compatible validator falls
 * through to a real POST /v1/messages (max_tokens=1) — a BILLED inference call.
 * The hourly credential-health sweep therefore kept the plan "active" around
 * the clock and polluted the 5h window's first-request anchor (docs/201).
 *
 * The Ark control plane (open.volcengineapi.com, IAM AK/SK V4 signature) is
 * non-billed and already probed every 60s by the reset-aware quota fetcher.
 * When that fetch positively succeeds, the plan, the AK/SK and the network are
 * all proven healthy — short-circuit the test as valid without touching the
 * inference endpoint. Anything else (no credentials, V4 hiccup, parse failure)
 * returns null so the caller falls through to the legacy path: a probe failure
 * must never mark the connection dead.
 */
import { makeDiagnosis } from "./codexAppServerHealth.ts";

/** baseUrl prefixes that identify a Volcengine Ark plan inference endpoint. */
const ARK_PLAN_BASE_URL_PATTERNS = [
  "volces.com/api/coding",
  "volces.com/api/plan",
] as const;

export type ArkPlanHealthResult = {
  valid: boolean;
  refreshed: boolean;
  diagnosis: unknown;
};

type FetchQuotaFn = (
  connectionId: string,
  connection?: Record<string, unknown>
) => Promise<unknown | null>;

function arkPlanBaseUrl(connection: any): string | null {
  const baseUrl = String(
    (connection?.providerSpecificData as Record<string, unknown> | undefined)?.baseUrl ?? ""
  );
  if (!baseUrl) return null;
  const hit = ARK_PLAN_BASE_URL_PATTERNS.find((pattern) => baseUrl.includes(pattern));
  return hit ? baseUrl : null;
}

export async function testArkPlanConnection(
  connection: any,
  deps: { fetchQuota?: FetchQuotaFn } = {}
): Promise<ArkPlanHealthResult | null> {
  if (!arkPlanBaseUrl(connection)) return null;

  let quota: unknown | null = null;
  try {
    if (deps.fetchQuota) {
      quota = await deps.fetchQuota(connection?.id, connection);
    } else {
      // Dynamic import (not static) so the open-sse module stays behind the
      // no-restricted-imports lint boundary (same pattern as
      // codexAppServerHealth.ts importing its app-server config).
      const { fetchArkPlanQuota } = await import(
        "@omniroute/open-sse/services/arkQuotaFetcher.ts"
      );
      quota = await fetchArkPlanQuota(connection?.id, connection);
    }
  } catch {
    return null;
  }
  if (!quota) return null;

  return {
    valid: true,
    refreshed: false,
    diagnosis: makeDiagnosis(
      "provider_check",
      "ark_control_plane",
      "Ark plan V4 control-plane probe ok (non-billed)",
      "ark_plan_v4_ok"
    ),
  };
}
