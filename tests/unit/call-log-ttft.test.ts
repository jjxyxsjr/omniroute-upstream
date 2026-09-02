/**
 * 2g — call_logs carries streaming first-token latency (ttft_ms).
 * Migration 163 adds ttft_ms + queue_wait_ms (queue_wait wiring pending);
 * streaming attempts persist their measured TTFT, non-stream rows stay null.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import { saveCallLog } from "../../src/lib/usage/callLogs.ts";

test.after(() => {
  resetDbInstance();
});

test("call_logs has ttft_ms and queue_wait_ms columns", () => {
  const db = getDbInstance();
  const cols = (db.prepare("PRAGMA table_info(call_logs)").all() as { name: string }[]).map(
    (c) => c.name
  );
  assert.ok(cols.includes("ttft_ms"), "ttft_ms column present");
  assert.ok(cols.includes("queue_wait_ms"), "queue_wait_ms column present");
});

test("saveCallLog persists ttft_ms for streaming rows and null otherwise", async () => {
  const db = getDbInstance();
  const streamId = `test-ttft-${Date.now()}-s`;
  const nonStreamId = `test-ttft-${Date.now()}-n`;

  const base = {
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 5_000,
    tokens: {},
  };
  await saveCallLog({ ...base, id: streamId, ttftMs: 1_234.6 });
  await saveCallLog({ ...base, id: nonStreamId, ttftMs: null });

  const s = db
    .prepare("SELECT ttft_ms FROM call_logs WHERE id = ?")
    .get(streamId) as { ttft_ms: number | null };
  const n = db
    .prepare("SELECT ttft_ms FROM call_logs WHERE id = ?")
    .get(nonStreamId) as { ttft_ms: number | null };
  assert.equal(s.ttft_ms, 1235, "rounded integer persisted");
  assert.equal(n.ttft_ms, null, "non-stream rows stay null");
});

test("garbage ttftMs values persist as null", async () => {
  const db = getDbInstance();
  const id = `test-ttft-${Date.now()}-g`;
  await saveCallLog({
    id,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "m",
    provider: "p",
    duration: 10,
    tokens: {},
    ttftMs: Number.NaN,
  });
  const row = db.prepare("SELECT ttft_ms FROM call_logs WHERE id = ?").get(id) as {
    ttft_ms: number | null;
  };
  assert.equal(row.ttft_ms, null);
});

/**
 * 2g-a (nnd.12) — queue_wait_ms finally carries data. The column existed since
 * migration 163 but no writer ever populated it (all NULL in production);
 * the admission→dispatch gap is now wired through persistAttemptLogs.
 */
test("2g-a saveCallLog persists queue_wait_ms and nulls garbage", async () => {
  const db = getDbInstance();
  const base = {
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 5_000,
    tokens: {},
  };
  const waitedId = `test-qwait-${Date.now()}-w`;
  const noWaitId = `test-qwait-${Date.now()}-n`;
  const garbageId = `test-qwait-${Date.now()}-g`;

  await saveCallLog({ ...base, id: waitedId, queueWaitMs: 321.7 });
  await saveCallLog({ ...base, id: noWaitId });
  await saveCallLog({ ...base, id: garbageId, queueWaitMs: Number.NaN });

  const w = db.prepare("SELECT queue_wait_ms FROM call_logs WHERE id = ?").get(waitedId) as {
    queue_wait_ms: number | null;
  };
  const n = db.prepare("SELECT queue_wait_ms FROM call_logs WHERE id = ?").get(noWaitId) as {
    queue_wait_ms: number | null;
  };
  const g = db.prepare("SELECT queue_wait_ms FROM call_logs WHERE id = ?").get(garbageId) as {
    queue_wait_ms: number | null;
  };
  assert.equal(w.queue_wait_ms, 322, "rounded integer persisted");
  assert.equal(n.queue_wait_ms, null, "absent queueWaitMs stays null");
  assert.equal(g.queue_wait_ms, null, "NaN queueWaitMs stays null");
});
