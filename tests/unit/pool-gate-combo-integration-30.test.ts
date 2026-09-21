// nnd.30 集成测试：受阻池闸门接入 handleComboChat 主河道（161 A/B/C 件）。
// 场景族 = 2026-09-21 两场事故的实验室复刻：
//   A 假冷却 1.2s（胡健荣钉扎 3s 锁的缩短版）→ 挂起后 200
//   B 假冷却 60s > 等待帽 → 429 + 标准 Retry-After + 北京时刻文案
//   C 闸门关闭（CAP=0）→ 旧版秒拒 503（热回退锚）
//   D 挂起中客户端断开 → 499
//   E 状态码热锚 OMNIROUTE_BLOCKED_POOL_STATUS=503
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-poolgate-30-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { lockModel, clearAllModelLockouts } = await import(
  "../../open-sse/services/accountFallback.ts"
);
const { saveModelsDevCapabilities, clearModelsDevCapabilities } = await import(
  "../../src/lib/modelsDevSync.ts"
);
const { resetAllComboMetrics } = await import("../../open-sse/services/comboMetrics.ts");
const { resetAll: resetAllSemaphores } = await import(
  "../../open-sse/services/rateLimitSemaphore.ts"
);
const { resetPoolGateStateForTests } = await import(
  "../../open-sse/services/combo/poolBlockageGate.ts"
);

const SAVED_ENV: Record<string, string | undefined> = {};
const GATE_ENV_KEYS = [
  "OMNIROUTE_POOL_WAIT_CAP_MS",
  "OMNIROUTE_POOL_PARK_MAX",
  "OMNIROUTE_BLOCKED_POOL_STATUS",
];
for (const k of GATE_ENV_KEYS) SAVED_ENV[k] = process.env[k];

test.after(() => {
  for (const k of GATE_ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  clearModelsDevCapabilities();
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}
});

function createLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function setEnv(overrides: Record<string, string>) {
  for (const k of GATE_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, overrides);
}

async function freshState() {
  clearAllModelLockouts();
  resetPoolGateStateForTests();
  resetAllComboMetrics();
  resetAllSemaphores();
}

async function runCombo(opts: {
  lockMs: number;
  signal?: AbortSignal;
  dispatchCount?: { n: number };
}) {
  lockModel("openai", "", "gate-model", "rate_limit", opts.lockMs);
  const dispatchCount = opts.dispatchCount ?? { n: 0 };
  const result = await handleComboChat({
    body: { model: "gate", messages: [{ role: "user", content: "hi" }] },
    combo: {
      name: "gate-combo-30",
      strategy: "reset-aware",
      models: ["openai/gate-model"],
      config: { maxRetries: 0, concurrencyPerModel: 1, queueTimeoutMs: 1000 },
    },
    handleSingleModel: async () => {
      dispatchCount.n += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    isModelAvailable: async () => true,
    log: createLog(),
    settings: null,
    relayOptions: null,
    allCombos: null,
    signal: opts.signal ?? null,
  });
  return { result, dispatchCount };
}

test("A: 短冷却(1.2s)在帽内 → 挂起重派 → 200（胡健荣 12:04 缩影）", async () => {
  await freshState();
  setEnv({});
  saveModelsDevCapabilities({
    openai: { "gate-model": { limit_context: 128000 } },
  });
  const t0 = Date.now();
  const { result, dispatchCount } = await runCombo({ lockMs: 1200 });
  const elapsed = Date.now() - t0;
  assert.equal(result.status, 200, `期望挂起后成功，实际 ${result.status}`);
  assert.equal(dispatchCount.n, 1);
  assert.ok(elapsed >= 1100, `应真实等待锁过期，实际 ${elapsed}ms`);
});

test("B: 长冷却(60s)超帽 → 429 + 标准 Retry-After + 恢复提示", async () => {
  await freshState();
  setEnv({ OMNIROUTE_POOL_WAIT_CAP_MS: "200" });
  saveModelsDevCapabilities({ openai: { "gate-model": { limit_context: 128000 } } });
  const t0 = Date.now();
  const { result, dispatchCount } = await runCombo({ lockMs: 60_000 });
  assert.ok(Date.now() - t0 < 1500, "预算外必须快速失败");
  assert.equal(dispatchCount.n, 0, "绝不派发");
  assert.equal(result.status, 429);
  const retryAfter = Number(result.headers.get("Retry-After"));
  assert.ok(
    Number.isFinite(retryAfter) && retryAfter >= 55 && retryAfter <= 66,
    `Retry-After 应≈锁剩余秒数，实际 ${retryAfter}`
  );
  assert.ok(result.headers.get("x-omniroute-retry-after-seconds"), "自家头保留");
  const body = (await result.json()) as {
    error?: { type?: string; code?: string };
    recovery_hint?: { retry_after_seconds?: number };
  };
  assert.equal(body.error?.type, "rate_limit_error");
  assert.equal(body.error?.code, "ALL_TARGETS_SKIPPED");
  assert.ok(
    typeof body.recovery_hint?.retry_after_seconds === "number" &&
      body.recovery_hint.retry_after_seconds > 50,
    "body 恢复提示带秒数"
  );
});

test("C: 闸门关闭(CAP=0) → 不挂起快速失败；契约旋钮独立（默认仍 429）", async () => {
  await freshState();
  setEnv({ OMNIROUTE_POOL_WAIT_CAP_MS: "0" });
  saveModelsDevCapabilities({ openai: { "gate-model": { limit_context: 128000 } } });
  const t0 = Date.now();
  const { result } = await runCombo({ lockMs: 1200 });
  assert.ok(Date.now() - t0 < 600, "关闭态必须秒拒（绝不挂起）");
  assert.equal(result.status, 429, "CAP 只关挂起；状态码契约由独立旋钮控制（默认 429）");
});

test("C2: CAP=0 + STATUS=503 → 状态码回到旧版（单一热回退锚组合）", async () => {
  await freshState();
  setEnv({ OMNIROUTE_POOL_WAIT_CAP_MS: "0", OMNIROUTE_BLOCKED_POOL_STATUS: "503" });
  saveModelsDevCapabilities({ openai: { "gate-model": { limit_context: 128000 } } });
  const { result } = await runCombo({ lockMs: 1200 });
  assert.equal(result.status, 503);
  // Retry-After 头在两种状态码下都保留（503+Retry-After 亦为标准用法，
  // 信息只多不少）；"完整旧版"仅指状态码语义。
});

test("D: 挂起中客户端断开 → 499，槽位归还", async () => {
  await freshState();
  setEnv({});
  saveModelsDevCapabilities({ openai: { "gate-model": { limit_context: 128000 } } });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 120);
  const { result, dispatchCount } = await runCombo({ lockMs: 8000, signal: controller.signal });
  assert.equal(result.status, 499);
  assert.equal(dispatchCount.n, 0);
});

test("E: OMNIROUTE_BLOCKED_POOL_STATUS=503 → 状态码热锚生效", async () => {
  await freshState();
  setEnv({ OMNIROUTE_POOL_WAIT_CAP_MS: "200", OMNIROUTE_BLOCKED_POOL_STATUS: "503" });
  saveModelsDevCapabilities({ openai: { "gate-model": { limit_context: 128000 } } });
  const { result } = await runCombo({ lockMs: 60_000 });
  assert.equal(result.status, 503);
  assert.ok(Number(result.headers.get("Retry-After")) > 50, "503 锚下 Retry-After 头保留");
});
