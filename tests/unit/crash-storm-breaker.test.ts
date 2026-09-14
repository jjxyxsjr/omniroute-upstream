/**
 * Crash-storm breaker（nnd.25 —— 9-8 停摆悬案的源码面根治）。
 *
 * 病理实证：2026-09-08 BJ 12-13 时 undefined.bind ×445 笔/35 分钟全道快败，
 * provider 熔断因 #12233（本机执行错误排除）+ pre-#12360（已成形 5xx 不计）
 * 两处刻意留白而全程未动——本件按 provider×归一化签名兜住该类风暴。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  recordCrashFailure,
  isCrashStorming,
  crashStormStatus,
  resetCrashStormBreaker,
  normalizeCrashSignature,
} from "../../open-sse/services/crashStormBreaker.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("normalizeCrashSignature collapses volatile hex/digit runs so id drift keeps one key", () => {
  const a =
    "[502]: [anthropic-compatible-f1f61e6c-6da9-4676-96f6-1d025476a37c/tc-code-latest] upstream failed after 12345ms";
  const b =
    "[502]: [anthropic-compatible-9c2b7d31aa-1111-2222-3333-444455556666/tc-code-latest] upstream failed after 999ms";
  assert.equal(normalizeCrashSignature(a), normalizeCrashSignature(b));
  // 9-8 主伤形态：无 id 纯文本，原样成键
  const bomb = "Cannot read properties of undefined (reading 'bind')";
  assert.equal(normalizeCrashSignature(bomb), bomb);
  assert.equal(normalizeCrashSignature(null), "");
  assert.equal(normalizeCrashSignature("   "), "");
});

test("threshold trip: 10 same-signature 5xx in window storms, 9 does not", () => {
  resetCrashStormBreaker();
  for (let i = 0; i < 9; i++)
    recordCrashFailure("glm", "Cannot read properties of undefined (reading 'bind')", 502);
  assert.equal(isCrashStorming("glm"), false);
  recordCrashFailure("glm", "Cannot read properties of undefined (reading 'bind')", 502);
  assert.equal(isCrashStorming("glm"), true);
});

test("per-provider isolation: storming glm does not trip ark", () => {
  resetCrashStormBreaker();
  for (let i = 0; i < 12; i++) recordCrashFailure("glm", "boom", 502);
  assert.equal(isCrashStorming("glm"), true);
  assert.equal(isCrashStorming("ark"), false);
});

test("only 5xx count — 429/403/400 never feed the breaker", () => {
  resetCrashStormBreaker();
  for (let i = 0; i < 50; i++) recordCrashFailure("glm", "rate limited", 429);
  for (let i = 0; i < 50; i++) recordCrashFailure("glm", "forbidden", 403);
  assert.equal(isCrashStorming("glm"), false);
});

test("window decay: storm clears after the window drains", async () => {
  resetCrashStormBreaker();
  process.env.OMNIROUTE_CRASH_STORM_WINDOW_MS = "120";
  try {
    for (let i = 0; i < 10; i++) recordCrashFailure("glm", "boom", 502);
    assert.equal(isCrashStorming("glm"), true);
    await new Promise((r) => setTimeout(r, 180));
    assert.equal(isCrashStorming("glm"), false, "窗口衰减后应自愈");
  } finally {
    delete process.env.OMNIROUTE_CRASH_STORM_WINDOW_MS;
  }
});

test("env threshold 0 disables recording entirely", () => {
  resetCrashStormBreaker();
  process.env.OMNIROUTE_CRASH_STORM_THRESHOLD = "0";
  try {
    for (let i = 0; i < 100; i++) recordCrashFailure("glm", "boom", 502);
    assert.equal(isCrashStorming("glm"), false);
  } finally {
    delete process.env.OMNIROUTE_CRASH_STORM_THRESHOLD;
  }
});

test("crashStormStatus surfaces active entries for diagnostics", () => {
  resetCrashStormBreaker();
  for (let i = 0; i < 10; i++)
    recordCrashFailure("glm", "Cannot read properties of undefined (reading 'bind')", 502);
  const status = crashStormStatus();
  const entry = status.find((s) => s.provider === "glm");
  assert.ok(entry, JSON.stringify(status));
  assert.equal(entry!.count, 10);
  assert.match(entry!.signature, /reading 'bind'/);
});

test("gate wiring: executeTargetGates skips a storming provider with reason crash_storm", async () => {
  resetCrashStormBreaker();
  const { evaluateExecuteTargetGates } =
    await import("../../open-sse/services/combo/executeTargetGates.ts");
  const provider = "crash-storm-test-prov";
  for (let i = 0; i < 10; i++) recordCrashFailure(provider, "undefined.bind storm", 502);
  assert.equal(isCrashStorming(provider), true);

  const state = {
    orderedTargets: [
      {
        modelStr: `${provider}/some-model`,
        provider,
        executionKey: `${provider}/some-model`,
        connectionId: "conn-1",
        fallbackOnlyOnQuotaExhaustion: true,
      },
    ],
    fallbackCount: 0,
    recordedAttempts: 0,
    comboErrors: [],
    lastError: null,
    lastStatus: null,
    earliestRetryAfter: null,
    comboExpired: false,
    exhaustedProviders: new Set(),
    exhaustedConnections: new Set(),
    transientRateLimitedProviders: new Set(),
    abortControllers: new Map([[0, new AbortController()]]),
    dispatchedTargets: new Set(),
    targetFailureTrust: new Map(),
    comboAttemptOrder: [],
    skippedForCircuitOpen: false,
    earliestCircuitOpenRetryMs: 0,
    globalAttempts: 0,
    observedFailure: false,
    allObservedFailuresQuota: true,
    observeFailure() {},
  } as unknown as Parameters<typeof evaluateExecuteTargetGates>[0]["state"];
  const deps = {
    strategy: "priority",
    combo: { name: "t", models: [] },
    config: {},
    log: { info() {}, warn() {}, debug() {}, error() {} },
    resilienceSettings: { providerCooldown: { enabled: false } },
    preScreenMap: new Map(),
    traceInvocationId: "inv-crash-storm",
    quotaCutoffResetWindowConfig: {},
    clearStaleLKGP() {},
  } as unknown as Parameters<typeof evaluateExecuteTargetGates>[0]["deps"];

  const gate = await evaluateExecuteTargetGates({ index: 0, state, deps });
  assert.equal(gate.kind, "skip");
  assert.ok(gate.result, "protected-priority 目标应带响应跳过");
  const resp = (gate.result as { response: Response }).response;
  const body = await resp.clone().text();
  assert.match(body, /crash-storm breaker is open/);
  assert.equal(resp.status, 503);
  // 同窗内非风暴 provider 不受影响
  resetCrashStormBreaker();
  const gateHealthy = await evaluateExecuteTargetGates({ index: 0, state, deps });
  assert.notEqual(gateHealthy.kind, "skip");
});

test("source guard: chatCore providerFailure records into the breaker (hook stays wired)", () => {
  const src = readFileSync(join(root, "open-sse", "handlers", "chatCore.ts"), "utf8");
  const pfStart = src.indexOf("providerFailure: if (!providerResponse.ok)");
  assert.ok(pfStart >= 0, "providerFailure block not found");
  const pfEnd = src.indexOf("break providerFailure", pfStart);
  assert.ok(pfEnd > pfStart);
  const block = src.slice(pfStart, pfEnd);
  assert.match(block, /recordCrashFailure\(/);
  const gates = readFileSync(
    join(root, "open-sse", "services", "combo", "executeTargetGates.ts"),
    "utf8"
  );
  assert.match(gates, /isCrashStorming\(/);
  assert.match(gates, /"crash_storm"/);
});

test("source guard: attempt-loop main-channel feed at comboErrors.push (nnd.25 喂点移植)", () => {
  // nnd.25 教训（50 线实证）：chatCore 侧钩是另一入口的河——/v1/messages 全量
  // 经 src handleChat → executeTargetAttempt 尝试环，失败在 comboErrors.push
  // 处收口。喂点必须挂在主河道收口位；质量 502 与 body-400 姊妹分支故意不喂
  // （全文件仅允许一处喂点调用）。
  const src = readFileSync(
    join(root, "open-sse", "services", "combo", "executeTargetAttempt.ts"),
    "utf8"
  );
  const feedCount = src.split("recordCrashFailure(provider,").length - 1;
  assert.equal(feedCount, 1, "feed hook must appear exactly once (sister branches stay unfed)");
  const feedCall = src.indexOf("recordCrashFailure(provider,");
  const feedRegion = src.slice(Math.max(0, feedCall - 800), feedCall + 200);
  assert.match(feedRegion, /comboErrors\.push/);
});
