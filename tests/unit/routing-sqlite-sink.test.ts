/**
 * tests/unit/routing-sqlite-sink.test.ts
 *
 * nnd.25 (backend analysis): RoutingSqliteSink (open-sse/services/routing/sqliteSink.ts)
 *  - record() only buffers; flush() batch-inserts into the routing_events table
    with the correct column mapping (ts ISO / outcome / ttft / latency / tokens /
    retries / fallback_used / finish_reason / connection_id)
 *  - a saturated buffer drops the OLDEST events and counts the loss
 *  - registered by default from initRoutingObservability()
 *  - 7-day rolling cleanup (routing_events + runtime_state_snapshots) deletes
 *    old rows and keeps recent ones
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getDbInstance } from "../../src/lib/db/core.ts";
import { RoutingSqliteSink } from "../../open-sse/services/routing/sqliteSink.ts";
import type { RoutingEvent } from "../../open-sse/services/routing/events.ts";
import {
  initRoutingObservability,
  resetRoutingObservability,
} from "../../open-sse/services/routing/index.ts";
import { listRoutingEventSinks } from "../../open-sse/services/routing/events.ts";
import {
  cleanupRoutingEvents,
  cleanupRuntimeStateSnapshots,
} from "../../src/lib/db/cleanup.ts";

function event(partial: Partial<RoutingEvent> = {}): RoutingEvent {
  return {
    requestId: "req-1",
    provider: "openai",
    model: "gpt-4o",
    strategy: "auto",
    latencyMs: 120,
    ttftMs: 40,
    itlMs: 12,
    inputTokens: 10,
    outputTokens: 20,
    cost: 0.01,
    retries: 1,
    fallbackUsed: true,
    outcome: "success",
    status: 200,
    finishReason: "stop",
    connectionId: "conn-1",
    ts: 1_700_000_000_000,
    ...partial,
  };
}

interface RoutingEventRow {
  ts: string;
  request_id: string | null;
  provider: string;
  model: string;
  strategy: string;
  outcome: string;
  status: number | null;
  latency_ms: number;
  ttft_ms: number | null;
  itl_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  retries: number;
  fallback_used: number;
  finish_reason: string | null;
  connection_id: string | null;
}

function allRoutingEventRows(): RoutingEventRow[] {
  return getDbInstance()
    .prepare("SELECT * FROM routing_events ORDER BY id")
    .all() as RoutingEventRow[];
}

// Rows persist across tests in this file's process — start each case clean.
test.beforeEach(() => {
  const db = getDbInstance();
  db.prepare("DELETE FROM routing_events").run();
  db.prepare("DELETE FROM runtime_state_snapshots").run();
});

test("RoutingSqliteSink buffers on record and flush() writes rows with correct column mapping", () => {
  const sink = new RoutingSqliteSink({ flushIntervalMs: 1_000_000 });
  try {
    sink.record(event());
    assert.equal(sink.getStats().buffered, 1);
    const written = sink.flush();
    assert.equal(written, 1);
    assert.equal(sink.getStats().buffered, 0);
    assert.equal(sink.getStats().written, 1);

    const rows = allRoutingEventRows();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.ts, new Date(1_700_000_000_000).toISOString());
    assert.equal(row.request_id, "req-1");
    assert.equal(row.provider, "openai");
    assert.equal(row.model, "gpt-4o");
    assert.equal(row.strategy, "auto");
    assert.equal(row.outcome, "success");
    assert.equal(row.status, 200);
    assert.equal(row.latency_ms, 120);
    assert.equal(row.ttft_ms, 40);
    assert.equal(row.itl_ms, 12);
    assert.equal(row.input_tokens, 10);
    assert.equal(row.output_tokens, 20);
    assert.equal(row.retries, 1);
    assert.equal(row.fallback_used, 1);
    assert.equal(row.finish_reason, "stop");
    assert.equal(row.connection_id, "conn-1");
  } finally {
    sink.stop();
  }
});

test("RoutingSqliteSink maps null observability fields and fallback=false to SQL nulls/0", () => {
  const sink = new RoutingSqliteSink({ flushIntervalMs: 1_000_000 });
  try {
    sink.record(
      event({
        requestId: "req-null",
        ttftMs: null,
        itlMs: null,
        inputTokens: null,
        outputTokens: null,
        fallbackUsed: false,
        retries: 0,
        status: null,
        finishReason: null,
        connectionId: null,
        outcome: "timeout",
      })
    );
    sink.flush();
    const row = allRoutingEventRows().find((r) => r.request_id === "req-null");
    assert.ok(row, "row written");
    assert.equal(row.outcome, "timeout");
    assert.equal(row.status, null);
    assert.equal(row.ttft_ms, null);
    assert.equal(row.itl_ms, null);
    assert.equal(row.input_tokens, null);
    assert.equal(row.output_tokens, null);
    assert.equal(row.retries, 0);
    assert.equal(row.fallback_used, 0);
    assert.equal(row.finish_reason, null);
    assert.equal(row.connection_id, null);
  } finally {
    sink.stop();
  }
});

test("RoutingSqliteSink drops the oldest events when the buffer saturates and counts the loss", () => {
  const sink = new RoutingSqliteSink({ maxBufferedEvents: 5, flushIntervalMs: 1_000_000 });
  try {
    for (let i = 0; i < 20; i++) sink.record(event({ requestId: `r-${i}` }));
    const stats = sink.getStats();
    assert.equal(stats.buffered, 5, "buffer stays bounded");
    assert.equal(stats.dropped, 15, "every rejected event is counted");
    const written = sink.flush();
    assert.equal(written, 5);
    const ids = allRoutingEventRows().map((r) => r.request_id);
    // The OLDEST events are the sacrifice — the newest 5 survive.
    assert.deepEqual(ids, ["r-15", "r-16", "r-17", "r-18", "r-19"]);
  } finally {
    sink.stop();
  }
});

test("initRoutingObservability registers the sqlite sink by default", () => {
  resetRoutingObservability();
  try {
    const { sinks } = initRoutingObservability({});
    assert.ok(sinks.includes("sqlite"), `sinks: ${sinks.join(", ")}`);
    assert.ok(listRoutingEventSinks().includes("sqlite"));
  } finally {
    resetRoutingObservability();
  }
});

test("cleanupRoutingEvents deletes rows older than 7 days and keeps recent rows", async () => {
  const db = getDbInstance();
  const insert = db.prepare(
    `INSERT INTO routing_events (
       ts, request_id, provider, model, strategy, outcome
     ) VALUES (?, ?, 'openai', 'gpt-4o', 'auto', 'success')`
  );
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
  insert.run(eightDaysAgo, "old-1");
  insert.run(sixDaysAgo, "recent-1");

  const result = await cleanupRoutingEvents();

  assert.equal(result.errors, 0);
  assert.equal(result.deleted, 1);
  const remaining = db
    .prepare("SELECT request_id FROM routing_events")
    .all() as Array<{ request_id: string }>;
  assert.deepEqual(remaining.map((r) => r.request_id), ["recent-1"]);
});

test("cleanupRuntimeStateSnapshots deletes rows older than 7 days and keeps recent rows", async () => {
  const db = getDbInstance();
  const insert = db.prepare(
    "INSERT INTO runtime_state_snapshots (ts, kind, entity, state) VALUES (?, ?, NULL, ?)"
  );
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
  insert.run(eightDaysAgo, "model_lockouts", '{"count":0}');
  insert.run(sixDaysAgo, "model_lockouts", '{"count":1}');

  const result = await cleanupRuntimeStateSnapshots();

  assert.equal(result.errors, 0);
  assert.equal(result.deleted, 1);
  const remaining = db
    .prepare("SELECT state FROM runtime_state_snapshots")
    .all() as Array<{ state: string }>;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].state, '{"count":1}');
});
