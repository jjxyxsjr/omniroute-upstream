// 012: Ark Coding Plan quota fetcher — control-plane OpenAPI (GetCodingPlanUsage
// primary, GetAFPUsage fallback) with Volcengine Signature V4, shaped for
// reset-aware scoring (top-level window5h/windowWeekly/windowMonthly — the keys
// scoreResetAwareQuota reads) plus the windows map for the dashboard. Response
// fixtures below are the REAL shapes captured live on 2026-08-26 (probe in
// deploy scripts-tmp/volc-ark-probe.mjs; spec in deploy docs/135 §6).
import test from "node:test";
import assert from "node:assert/strict";

const {
  buildVolcSignatureHeaders,
  parseCodingPlanUsage,
  parseAfpUsage,
  resolveArkPlanCredentials,
} = await import("../../open-sse/services/arkQuotaFetcher.ts");

test("signature headers are deterministic and match the golden vector (012)", () => {
  const h = buildVolcSignatureHeaders({
    accessKeyId: "AKTESTFAKE",
    secretAccessKey: "SKTESTFAKE",
    action: "GetCodingPlanUsage",
    region: "cn-beijing",
    now: new Date("2026-08-26T02:00:00Z"),
  });
  assert.equal(h.xDate, "20260826T020000Z");
  assert.equal(h.query, "Action=GetCodingPlanUsage&Region=cn-beijing&Version=2024-01-01");
  assert.equal(
    h.authorization,
    "HMAC-SHA256 Credential=AKTESTFAKE/20260826/cn-beijing/ark/request, " +
      "SignedHeaders=host;x-date;x-content-sha256;content-type, " +
      "Signature=5b58a8a041a51d33c33c5eb22235db9c115b65d0da99ee4e111c3a582e4d380a"
  );
});

test("parses GetCodingPlanUsage into reset-aware window shape (012)", () => {
  // Live shape 2026-08-26: session 89.10% (reset ~40min), weekly 41.49%, monthly 85.23%.
  const parsed = parseCodingPlanUsage({
    Result: {
      Status: "Running",
      QuotaUsage: [
        { Level: "session", Percent: 89.1018005, ResetTimestamp: 1787711313 },
        { Level: "weekly", Percent: 41.4874554, ResetTimestamp: 1788105600 },
        { Level: "monthly", Percent: 85.23392416666667, ResetTimestamp: 1788278399 },
      ],
    },
  });
  assert.ok(parsed, "parsed result expected");
  // worst window = session 89.10% → percentUsed fraction
  assert.ok(Math.abs(parsed.percentUsed - 0.891018005) < 1e-9);
  assert.ok(parsed.window5h && Math.abs(parsed.window5h.percentUsed - 0.891018005) < 1e-9);
  // seconds → ISO reset (1787711313s = 2026-08-26T02:28:33Z)
  assert.equal(parsed.window5h?.resetAt, "2026-08-26T02:28:33.000Z");
  assert.ok(parsed.windowWeekly && Math.abs(parsed.windowWeekly.percentUsed - 0.414874554) < 1e-9);
  assert.ok(parsed.windowMonthly && Math.abs(parsed.windowMonthly.percentUsed - 0.85233924) < 1e-6);
  // scoring reads TOP-LEVEL keys — they must exist alongside the windows map
  assert.ok(parsed.windows && "window_5h" in parsed.windows);
});

test("parses GetAFPUsage absolute quotas into percentages, skipping idle windows (012)", () => {
  const parsed = parseAfpUsage({
    Result: {
      PlanType: "medium",
      AFPFiveHour: { Quota: 10000, Used: 0, ResetTime: -1 },
      AFPWeekly: { Quota: 35000, Used: 267.5462, ResetTime: 1788105600000 },
      AFPMonthly: { Quota: 100000, Used: 359.9732, ResetTime: 1789919999000 },
      AFPDaily: { Quota: 50000, Used: 0, ResetTime: 1787760000000 },
    },
  });
  assert.ok(parsed, "parsed result expected");
  // idle 5h window (Used=0, ResetTime=-1): percentUsed 0, resetAt null
  assert.equal(parsed.window5h?.percentUsed, 0);
  assert.equal(parsed.window5h?.resetAt, null);
  assert.ok(parsed.windowWeekly && Math.abs(parsed.windowWeekly.percentUsed - 267.5462 / 35000) < 1e-9);
  assert.equal(parsed.windowWeekly?.resetAt, "2026-08-30T16:00:00.000Z");
  // worst = weekly 0.764%
  assert.ok(Math.abs(parsed.percentUsed - 267.5462 / 35000) < 1e-9);
});

test("parseCodingPlanUsage returns null when the plan is not running / empty (012)", () => {
  assert.equal(parseCodingPlanUsage({ Result: { Status: "Expired", QuotaUsage: [] } }), null);
  assert.equal(parseCodingPlanUsage({ Result: {} }), null);
  assert.equal(parseCodingPlanUsage({}), null);
});

test("credentials resolve from providerSpecificData with enc:v1 passthrough markers (012)", () => {
  // Plain values pass through; enc:v1 values are surfaced for decryption by the
  // caller that owns the encryption context (keeps this module DB-free).
  const plain = resolveArkPlanCredentials({
    providerSpecificData: { arkAccessKeyId: "AKPLAIN", arkSecretAccessKey: "SKPLAIN" },
  });
  assert.deepEqual(plain, { accessKeyId: "AKPLAIN", secretAccessKey: "SKPLAIN" });
  const enc = resolveArkPlanCredentials({
    providerSpecificData: { arkAccessKeyId: "enc:v1:aa", arkSecretAccessKey: "enc:v1:bb" },
  });
  assert.equal(enc?.accessKeyId?.startsWith("enc:v1:"), true);
  const none = resolveArkPlanCredentials({ providerSpecificData: {} });
  assert.equal(none, null);
});
