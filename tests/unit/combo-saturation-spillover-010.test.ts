// 010: saturation spillover — when a target's account semaphore is at capacity
// (running >= maxConcurrent), the candidate stage must skip it BEFORE winner
// election so selection falls through to the next healthy pool instead of
// queueing behind a long job (deploy 150 §2; 2026-08-24 incident: ark
// double-lane jam, 139 req/h, three users queueing behind a 532s job).
// Saturation is read through the SAME gate the dispatch path acquires
// (chatCore.ts -> acquireAccountSemaphore, key provider:connectionId), via the
// existing read-only isAccountSemaphoreFull. When EVERY candidate is saturated
// the filter must fall back to the unfiltered list — never a hard empty set
// (queue behavior is the floor, not a 503).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-sat-spill-010-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { buildAutoCandidates } = await import("../../open-sse/services/combo.ts");
const { orderTargetsByResetAwareQuota } = await import(
  "../../open-sse/services/combo/quotaStrategies.ts"
);
const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const accountSemaphore = await import("../../open-sse/services/accountSemaphore.ts");
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

function targetFor(connectionId: string, provider = "openai") {
  return {
    stepId: "s1",
    executionKey: `s1-${provider}`,
    kind: "model",
    model: "m-a",
    provider,
    providerId: provider,
    modelStr: `${provider}/m-a`,
    connectionId,
    weight: 0,
    label: null,
    prompt: null,
  };
}

function bareTargetFor(provider: string) {
  return {
    stepId: `s-${provider}`,
    executionKey: `s-${provider}`,
    kind: "model",
    model: "m-a",
    provider,
    providerId: provider,
    modelStr: `${provider}/m-a`,
    connectionId: null,
    weight: 0,
    label: null,
    prompt: null,
  };
}

const LOG = { warn: () => {} };

test.after(() => {
  accountSemaphore.resetAll();
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

test("auto candidates: saturated capped connection is skipped, healthy pool takes over (010)", async () => {
  const cappedRow = await seedConnection({ maxConcurrent: 1 });
  const capped = String((cappedRow as { id?: unknown }).id ?? cappedRow);
  const healthyRow = await seedConnection();
  const healthy = String((healthyRow as { id?: unknown }).id ?? healthyRow);

  // Hold the capped connection's only lane — the dispatch gate is full.
  const release = await accountSemaphore.acquire(`openai:${capped}`, { maxConcurrency: 1 });

  try {
    const candidates = await buildAutoCandidates(
      [targetFor(capped), targetFor(healthy)],
      "sat-spill-auto-010"
    );
    const connIds = candidates.map((c) => c.connectionId);
    assert.ok(
      connIds.includes(healthy),
      `healthy connection must remain a candidate, got: ${JSON.stringify(connIds)}`
    );
    assert.ok(
      !connIds.includes(capped),
      `saturated capped connection must NOT be a candidate, got: ${JSON.stringify(connIds)}`
    );
  } finally {
    release();
  }
});

test("auto candidates: same connection becomes a candidate again once the lane frees (010)", async () => {
  const cappedRow = await seedConnection({ maxConcurrent: 1 });
  const capped = String((cappedRow as { id?: unknown }).id ?? cappedRow);

  const release = await accountSemaphore.acquire(`openai:${capped}`, { maxConcurrency: 1 });
  release();

  const candidates = await buildAutoCandidates([targetFor(capped)], "sat-spill-free-010");
  assert.ok(
    candidates.some((c) => c.connectionId === capped),
    "freed connection must be a candidate again"
  );
});

test("auto candidates: uncapped connection is never filtered by saturation (010)", async () => {
  const uncappedRow = await seedConnection({ maxConcurrent: null });
  const uncapped = String((uncappedRow as { id?: unknown }).id ?? uncappedRow);

  // The gate exists and holds a lane, but the connection row declares no cap —
  // the saturation predicate must bypass (no declared ceiling, no skip).
  const r1 = await accountSemaphore.acquire(`openai:${uncapped}`, { maxConcurrency: 1 });

  try {
    const candidates = await buildAutoCandidates([targetFor(uncapped)], "sat-spill-uncapped-010");
    assert.ok(
      candidates.some((c) => c.connectionId === uncapped),
      "uncapped connection must stay a candidate regardless of gate occupancy"
    );
  } finally {
    r1();
  }
});

test("auto candidates: all-saturated falls back to the unfiltered list (010)", async () => {
  const cappedRow = await seedConnection({ maxConcurrent: 1 });
  const capped = String((cappedRow as { id?: unknown }).id ?? cappedRow);

  const release = await accountSemaphore.acquire(`openai:${capped}`, { maxConcurrency: 1 });
  try {
    const candidates = await buildAutoCandidates([targetFor(capped)], "sat-spill-fallback-010");
    assert.ok(
      candidates.some((c) => c.connectionId === capped),
      "single saturated candidate must fall back to queue behavior, not vanish"
    );
  } finally {
    release();
  }
});

test("reset-aware: bare target on a fully saturated provider is skipped, sibling pool wins (010)", async () => {
  // Providers without a quota fetcher expand to a BARE target (no
  // connectionId) — the production shape of the ark connection. The skip must
  // still work: saturate the provider's only capped connection.
  const satRow = await seedConnection({ provider: "satprov010a", maxConcurrent: 1 });
  const satId = String((satRow as { id?: unknown }).id ?? satRow);
  await seedConnection({ provider: "satprov010b" });

  const release = await accountSemaphore.acquire(`satprov010a:${satId}`, { maxConcurrency: 1 });
  try {
    const ordered = await orderTargetsByResetAwareQuota(
      [bareTargetFor("satprov010b"), bareTargetFor("satprov010a")],
      "sat-spill-reset-010",
      null,
      LOG
    );
    const providers = ordered.map((t) => t.providerId);
    assert.ok(
      providers.includes("satprov010b"),
      `healthy sibling target must remain, got: ${JSON.stringify(providers)}`
    );
    assert.ok(
      !providers.includes("satprov010a"),
      `saturated provider target must be skipped, got: ${JSON.stringify(providers)}`
    );
  } finally {
    release();
  }
});

test("reset-aware: saturated provider returns to candidacy once lanes free (010)", async () => {
  const satRow = await seedConnection({ provider: "satprov010c", maxConcurrent: 1 });
  const satId = String((satRow as { id?: unknown }).id ?? satRow);

  const release = await accountSemaphore.acquire(`satprov010c:${satId}`, { maxConcurrency: 1 });
  release();

  const ordered = await orderTargetsByResetAwareQuota(
    [bareTargetFor("satprov010c")],
    "sat-spill-return-010",
    null,
    LOG
  );
  assert.ok(
    ordered.some((t) => t.providerId === "satprov010c"),
    "provider must return to candidacy after the gate frees"
  );
});
