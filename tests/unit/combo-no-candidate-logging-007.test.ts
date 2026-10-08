// 007-a2: the ALL_ACCOUNTS_INACTIVE 503 was historically invisible server-side
// (no log line at either throw point — see deploy docs/190-model-lockout-plan.md).
// These guards pin the new behavior: when every combo target is unavailable and
// the 503 is returned, a structured warn line with the combo name is emitted on
// BOTH code paths (strategy path → "COMBO_NO_CANDIDATE", round-robin path →
// "COMBO_NO_CANDIDATE_RR").
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-nc-log-007-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const { resetAllComboMetrics } = await import("../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { resetAll: resetAllSemaphores } =
  await import("../../open-sse/services/rateLimitSemaphore.ts");

function createCapturingLog() {
  const warnings: Array<{ tag: string; message: string; extra: unknown }> = [];
  return {
    warnings,
    log: {
      info: () => {},
      warn: (tag: string, message: string, extra?: unknown) => {
        warnings.push({ tag, message, extra });
      },
      error: () => {},
      debug: () => {},
    },
  };
}

function unavailableEverything() {
  return {
    handleSingleModel: async () =>
      new Response(JSON.stringify({ error: { message: "should not be called" } }), {
        status: 500,
      }),
    isModelAvailable: async () => false,
  };
}

test.after(() => {
  resetAllComboMetrics();
  resetAllCircuitBreakers();
  resetAllSemaphores();
  settingsDb.clearAllLKGP();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
});

test("round-robin 503 emits COMBO_NO_CANDIDATE_RR warn with combo name (007-a2)", async () => {
  const { log, warnings } = createCapturingLog();
  const { handleSingleModel, isModelAvailable } = unavailableEverything();

  const result = await handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    combo: {
      name: "nc-log-rr-007",
      strategy: "round-robin",
      models: ["openai/nc-a", "openai/nc-b"],
      config: { maxRetries: 0, concurrencyPerModel: 1, queueTimeoutMs: 1000 },
    },
    handleSingleModel,
    isModelAvailable,
    log,
  } as Parameters<typeof handleComboChat>[0]);

  assert.equal(result.status, 503);
  const hit = warnings.find((w) => w.tag === "COMBO_NO_CANDIDATE_RR");
  assert.ok(hit, `expected COMBO_NO_CANDIDATE_RR warn, got: ${JSON.stringify(warnings)}`);
  const extra = hit.extra as { combo?: string } | undefined;
  assert.equal(extra?.combo, "nc-log-rr-007");
});

test("strategy path blocked-pool exit emits COMBO_NO_CANDIDATE warn with combo name (007-a2)", async () => {
  const { log, warnings } = createCapturingLog();
  const { handleSingleModel, isModelAvailable } = unavailableEverything();

  const result = await handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    combo: {
      name: "nc-log-strategy-007",
      strategy: "priority",
      models: ["openai/nc-a", "openai/nc-b"],
      config: { maxRetries: 0, concurrencyPerModel: 1, queueTimeoutMs: 1000 },
    },
    handleSingleModel,
    isModelAvailable,
    log,
  } as Parameters<typeof handleComboChat>[0]);

  // nnd.30 (161): the strategy path's all-skipped exit is blocked-pool
  // semantics — default 429 (OMNIROUTE_BLOCKED_POOL_STATUS=503 restores the
  // hot anchor). The round-robin path above still asserts its legacy 503.
  assert.equal(result.status, 429);
  const hit = warnings.find((w) => w.tag === "COMBO_NO_CANDIDATE");
  assert.ok(hit, `expected COMBO_NO_CANDIDATE warn, got: ${JSON.stringify(warnings)}`);
  const extra = hit.extra as { combo?: string } | undefined;
  assert.equal(extra?.combo, "nc-log-strategy-007");
});
