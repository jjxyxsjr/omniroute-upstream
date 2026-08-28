/**
 * Regression (2026-08-28, docs/201): the periodic connection health check for
 * anthropic-compatible Ark plan nodes fell through to a billed POST /v1/messages
 * (max_tokens=1) every hour — GET {baseUrl}/models 404s on both ark plan
 * endpoints — keeping the plan "active" around the clock and polluting the
 * Volcengine 5h window's first-request anchor.
 *
 * Fix under test: `testArkPlanConnection` short-circuits the health check for
 * volces.com/api/{coding,plan} connections with a NON-BILLED V4 control-plane
 * probe (GetCodingPlanUsage / GetAFPUsage via the existing quota fetcher).
 * Conservative contract: return null (fall through to the legacy path) unless
 * the V4 probe positively succeeds — a V4 hiccup must never mark the
 * connection dead.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { testArkPlanConnection } = await import(
  "../../src/app/api/providers/[id]/test/arkPlanHealth.ts"
);

let calls: unknown[] = [];
const fetchQuota = async (...args: unknown[]) => {
  calls.push(args);
  return { used: 3, total: 100, percentUsed: 0.03 };
};
const fetchQuotaNull = async (...args: unknown[]) => {
  calls.push(args);
  return null;
};
const fetchQuotaThrows = async (...args: unknown[]) => {
  calls.push(args);
  throw new Error("control plane unreachable");
};
const deps = (fn: typeof fetchQuota) => ({ fetchQuota: fn });

function conn(baseUrl: string) {
  return {
    id: "conn-1",
    provider: "anthropic-compatible-d70a9997-f802-49b6-92fc-92a60a018fc2",
    providerSpecificData: { baseUrl, chatPath: "/v1/messages" },
  };
}

test("coding-plan baseUrl + successful V4 probe → valid short-circuit", async () => {
  calls = [];
  const r = await testArkPlanConnection(
    conn("https://ark.cn-beijing.volces.com/api/coding"),
    deps(fetchQuota)
  );
  assert.ok(r, "must short-circuit");
  assert.equal(r.valid, true);
  assert.equal(r.refreshed, false);
  const diag = r.diagnosis as { code?: string };
  assert.equal(diag?.code, "ark_plan_v4_ok");
  assert.equal(calls.length, 1, "quota fetcher called exactly once");
});

test("agent-plan baseUrl + successful V4 probe → valid short-circuit", async () => {
  calls = [];
  const r = await testArkPlanConnection(
    conn("https://ark.cn-beijing.volces.com/api/plan"),
    deps(fetchQuota)
  );
  assert.ok(r, "must short-circuit");
  assert.equal(r.valid, true);
  assert.equal((r.diagnosis as { code?: string }).code, "ark_plan_v4_ok");
});

test("non-ark baseUrl → null (fall through), fetcher never called", async () => {
  calls = [];
  for (const baseUrl of [
    "https://api.anthropic.com",
    "https://open.bigmodel.cn/api/paas/v4",
    "https://ark.cn-beijing.volces.com/api/other",
  ]) {
    const r = await testArkPlanConnection(conn(baseUrl), deps(fetchQuota));
    assert.equal(r, null, `${baseUrl} must fall through`);
  }
  assert.equal(calls.length, 0, "V4 probe must not fire for non-plan baseUrls");
});

test("V4 probe returns null → fall through (never mark dead on V4 hiccup)", async () => {
  calls = [];
  const r = await testArkPlanConnection(
    conn("https://ark.cn-beijing.volces.com/api/coding"),
    deps(fetchQuotaNull)
  );
  assert.equal(r, null);
  assert.equal(calls.length, 1);
});

test("V4 probe throws → fall through", async () => {
  calls = [];
  const r = await testArkPlanConnection(
    conn("https://ark.cn-beijing.volces.com/api/plan"),
    deps(fetchQuotaThrows)
  );
  assert.equal(r, null);
  assert.equal(calls.length, 1);
});
