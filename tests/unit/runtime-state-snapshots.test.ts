/**
 * tests/unit/runtime-state-snapshots.test.ts
 *
 * nnd.25 (backend analysis): runtimeStateSnapshots job
 * (open-sse/services/runtimeStateSnapshots.ts) samples three process-local
 * state sources every 5 minutes into runtime_state_snapshots:
 *   1. model lockouts (accountFallback modelLockout summary)
 *   2. circuit breakers (shared circuitBreaker registry statuses)
 *   3. admission semaphores (accountSemaphore gate stats)
 * Each cycle writes one row per kind; the job is setInterval+unref'd.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getDbInstance } from "../../src/lib/db/core.ts";
import {
  collectRuntimeStateSnapshots,
  startRuntimeStateSnapshotJob,
  stopRuntimeStateSnapshotJobForTests,
  RUNTIME_STATE_SNAPSHOT_KINDS,
} from "../../open-sse/services/runtimeStateSnapshots.ts";
import { clearModelLock, lockModel } from "../../open-sse/services/accountFallback.ts";

interface SnapshotRow {
  ts: string;
  kind: string;
  entity: string | null;
  state: string;
}

function allSnapshotRows(): SnapshotRow[] {
  return getDbInstance()
    .prepare("SELECT ts, kind, entity, state FROM runtime_state_snapshots ORDER BY id")
    .all() as SnapshotRow[];
}

test.beforeEach(() => {
  getDbInstance().prepare("DELETE FROM runtime_state_snapshots").run();
});

test.after(() => {
  stopRuntimeStateSnapshotJobForTests();
});

test("one sampling cycle writes one aggregate snapshot row per kind", () => {
  const written = collectRuntimeStateSnapshots();
  assert.equal(written, RUNTIME_STATE_SNAPSHOT_KINDS.length);

  const rows = allSnapshotRows();
  assert.equal(rows.length, RUNTIME_STATE_SNAPSHOT_KINDS.length);
  const kinds = rows.map((r) => r.kind);
  for (const kind of RUNTIME_STATE_SNAPSHOT_KINDS) {
    assert.ok(kinds.includes(kind), `missing snapshot kind: ${kind}`);
  }
  for (const row of rows) {
    assert.ok(!Number.isNaN(Date.parse(row.ts)), `ts must be ISO: ${row.ts}`);
    const parsed = JSON.parse(row.state) as Record<string, unknown>;
    assert.equal(typeof parsed.count, "number", `${row.kind} state carries a count`);
  }
});

test("an active model lockout appears in the model_lockouts snapshot", () => {
  lockModel("openai", "conn-snap", "gpt-4o", "rate_limited", 60_000);
  try {
    collectRuntimeStateSnapshots();
    const row = allSnapshotRows().find((r) => r.kind === "model_lockouts");
    assert.ok(row, "model_lockouts row written");
    const state = JSON.parse(row.state) as {
      count: number;
      entries: Array<{ key: string; reason: string; until: number }>;
    };
    assert.ok(state.count >= 1, "lockout counted");
    const entry = state.entries.find((e) => e.key.includes("conn-snap"));
    assert.ok(entry, `snapshot carries the conn-snap lockout: ${JSON.stringify(state.entries)}`);
    assert.equal(entry.reason, "rate_limited");
    assert.ok(entry.until > Date.now() - 1000, "lockout until is a future epoch");
  } finally {
    // Best-effort cleanup of the lock — expired entries are skipped by the
    // sampler anyway, but do not leak state into other test files.
    clearModelLock("openai", "conn-snap", "gpt-4o");
  }
});

test("the interval job writes snapshot rows on its cadence and stops cleanly", async () => {
  stopRuntimeStateSnapshotJobForTests();
  const started = startRuntimeStateSnapshotJob({ intervalMs: 40 });
  assert.equal(started, true);
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const rows = allSnapshotRows();
    assert.ok(
      rows.length >= RUNTIME_STATE_SNAPSHOT_KINDS.length,
      `expected at least one full cycle, got ${rows.length} row(s)`
    );
  } finally {
    stopRuntimeStateSnapshotJobForTests();
  }
  const countAfterStop = allSnapshotRows().length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(allSnapshotRows().length, countAfterStop, "no rows after stop()");
});

test("startRuntimeStateSnapshotJob is idempotent (double start keeps one timer)", () => {
  stopRuntimeStateSnapshotJobForTests();
  const first = startRuntimeStateSnapshotJob({ intervalMs: 60_000 });
  const second = startRuntimeStateSnapshotJob({ intervalMs: 60_000 });
  assert.equal(first, true);
  assert.equal(second, false, "second start on a running job must be a no-op");
  stopRuntimeStateSnapshotJobForTests();
});
