// 007-a1: a reset-aware winner can be a dead connection (model-locked or in
// connection cooldown) when its quota cache is stale — auth then finds no
// credentials for the forced connection and the combo 503s with
// ALL_ACCOUNTS_INACTIVE (2026-08-21 incident, deploy docs/190 §3.A1).
// These guards pin the fix: buildAutoCandidates must NOT emit candidates for
// (provider, connectionId, model) triples that are currently model-locked, nor
// candidates whose connection is inside an active rateLimitedUntil cooldown.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-dead-winner-007-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { recordModelLockoutFailure, clearAllModelLockouts } =
  await import("../../open-sse/services/accountFallback.ts");
const { resetAllComboMetrics } = await import("../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { resetAll: resetAllSemaphores } =
  await import("../../open-sse/services/rateLimitSemaphore.ts");

async function seedConnection(overrides: Record<string, unknown> = {}) {
  return providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: `conn-${Math.random().toString(36).slice(2, 8)}`,
    isActive: 1,
    ...overrides,
  });
}

function targetFor(connectionId: string) {
  return {
    stepId: "s1",
    executionKey: "s1",
    kind: "model",
    model: "m-a",
    providerId: "openai",
    modelStr: "openai/m-a",
    connectionId,
  } as const;
}

test.after(() => {
  clearAllModelLockouts();
  resetAllComboMetrics();
  resetAllCircuitBreakers();
  resetAllSemaphores();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
});

test("model-locked connection is not emitted as a candidate (007-a1)", async () => {
  const healthyRow = await seedConnection();
  const healthy = String((healthyRow as { id?: unknown }).id ?? healthyRow);
  const lockedRow = await seedConnection();
  const locked = String((lockedRow as { id?: unknown }).id ?? lockedRow);
  recordModelLockoutFailure(
    "openai",
    String(locked),
    "m-a",
    "quota_exhausted",
    429,
    60_000,
    null,
    { exactCooldownMs: 3_600_000, exactCooldownIsUpstreamReset: true }
  );

  const candidates = await buildAutoCandidates(
    [targetFor(String(locked)), targetFor(String(healthy))],
    "dead-winner-lock-007"
  );

  const connIds = candidates.map((c) => c.connectionId);
  assert.ok(
    connIds.includes(String(healthy)),
    `healthy connection must remain a candidate, got: ${JSON.stringify(connIds)}`
  );
  assert.ok(
    !connIds.includes(String(locked)),
    `model-locked connection must NOT be a candidate, got: ${JSON.stringify(connIds)}`
  );
});

test("connection in active cooldown is not emitted as a candidate (007-a1)", async () => {
  const healthyRow = await seedConnection();
  const healthy = String((healthyRow as { id?: unknown }).id ?? healthyRow);
  const coolingRow = await seedConnection({
    rateLimitedUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
  });

  const cooling = String((coolingRow as { id?: unknown }).id ?? coolingRow);
  const candidates = await buildAutoCandidates(
    [targetFor(cooling), targetFor(healthy)],
    "dead-winner-cooldown-007"
  );

  const connIds = candidates.map((c) => c.connectionId);
  assert.ok(
    connIds.includes(String(healthy)),
    `healthy connection must remain a candidate, got: ${JSON.stringify(connIds)}`
  );
  assert.ok(
    !connIds.includes(String(cooling)),
    `cooling connection must NOT be a candidate, got: ${JSON.stringify(connIds)}`
  );
});
