/**
 * nnd.44 ②-fix (#232 regression guard): the LIVE-TRIAL chain test — a streamed
 * row must land in SQLite with the chunk aggregate columns NON-NULL and the
 * TTFT-audit pair SEPARATED, driving the REAL saveCallLog → artifact worker →
 * reply-UPDATE pipeline (the exact chain that read all-NULL in trial while
 * pure-math unit tests stayed green). Epochs use real wall-clock gaps — no
 * same-instant mocks (that is how the collapse escaped the first review).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import { saveCallLog, waitForCallLogSaves } from "../../src/lib/usage/callLogs.ts";

test.after(async () => {
  await waitForCallLogSaves(5_000);
  resetDbInstance();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a streamed row persists non-null chunk aggregates through the real artifact-worker chain", async () => {
  const db = getDbInstance();

  // Real elapsed gaps: dispatch → first output ≈ 60ms; content at +30ms after
  // output; three forward epochs with 25-40ms pacing gaps.
  const dispatchEpoch = Date.now();
  await sleep(60);
  const firstOutputEpoch = Date.now();
  await sleep(30);
  const firstContentEpoch = Date.now();
  const epochs = [firstOutputEpoch];
  for (const gap of [25, 40, 25]) {
    await sleep(gap);
    epochs.push(Date.now());
  }

  const id = `test-chunk-cols-${Date.now()}`;
  await saveCallLog({
    id,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 200,
    // responseBody forces detailExpected → the artifact-worker path (the
    // production chain for streamed rows); the UPDATE after the worker reply
    // is what fills the chunk columns.
    responseBody: { choices: [{ message: { content: "hi" } }] },
    tokens: {},
    ttftMs: 90,
    firstByteAt: firstOutputEpoch,
    firstForwardAt: dispatchEpoch,
    chunkTiming: {
      epochs,
      truncated: false,
      firstContentEpochMs: firstContentEpoch,
    },
  });
  await waitForCallLogSaves(10_000);

  const row = db
    .prepare(
      `SELECT first_byte_at, first_forward_at, chunk_itl_p99_ms, chunk_pause_2s_count,
              first_content_at, detail_state
       FROM call_logs WHERE id = ?`
    )
    .get(id) as {
    first_byte_at: number | null;
    first_forward_at: number | null;
    chunk_itl_p99_ms: number | null;
    chunk_pause_2s_count: number | null;
    first_content_at: number | null;
    detail_state: string;
  };

  assert.ok(row, "row inserted");
  assert.equal(row.detail_state, "ready", "artifact published (worker chain ran)");
  // Guard 1 — the #227 collapse: the audit pair must differ by the REAL
  // dispatch→output gap (≥30ms), not sit on one instant.
  assert.ok(row.first_byte_at != null, "first_byte_at non-null");
  assert.ok(row.first_forward_at != null, "first_forward_at non-null");
  const delta = row.first_byte_at! - row.first_forward_at!;
  assert.ok(
    delta >= 30 && delta <= 2_000,
    `first_byte_at − first_forward_at must be the real ~60ms gap, got ${delta}ms`
  );
  // Guard 2 — the all-NULL trial rows: aggregates must land via the worker
  // reply UPDATE. Gaps were 25/40/25ms → p99 (nearest-rank, rank 3 of 3) = 40.
  assert.ok(row.chunk_itl_p99_ms != null, "chunk_itl_p99_ms non-null (worker reply landed)");
  assert.ok(
    row.chunk_itl_p99_ms! >= 20 && row.chunk_itl_p99_ms! <= 150,
    `chunk_itl_p99_ms sane ms magnitude, got ${row.chunk_itl_p99_ms}`
  );
  assert.ok(row.chunk_pause_2s_count != null, "chunk_pause_2s_count non-null");
  assert.equal(row.chunk_pause_2s_count, 0, "no >2s stalls in this sample");
  assert.ok(row.first_content_at != null, "first_content_at non-null");
  const contentLag = row.first_content_at! - row.first_byte_at!;
  assert.ok(
    contentLag >= 15 && contentLag <= 2_000,
    `first_content_at trails first output by the real ~30ms gap, got ${contentLag}ms`
  );
});

test("a no-artifact row still gets chunk aggregates via the inline fallback", async () => {
  const db = getDbInstance();
  const base = Date.now();
  const id = `test-chunk-inline-${Date.now()}`;
  await saveCallLog({
    id,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 100,
    tokens: {},
    ttftMs: 50,
    firstByteAt: base + 80,
    firstForwardAt: base,
    chunkTiming: {
      epochs: [base, base + 20, base + 45, base + 70],
      truncated: false,
      firstContentEpochMs: base + 45,
    },
  });
  await waitForCallLogSaves(5_000);
  const row = db
    .prepare(
      `SELECT first_byte_at, first_forward_at, chunk_itl_p99_ms, chunk_pause_2s_count,
              first_content_at, detail_state
       FROM call_logs WHERE id = ?`
    )
    .get(id) as Record<string, number | string | null>;
  assert.ok(row, "row inserted");
  assert.equal(row.detail_state, "none", "no artifact expected");
  assert.equal(row.first_byte_at, base + 80);
  assert.equal(row.first_forward_at, base);
  assert.ok(row.chunk_itl_p99_ms != null, "inline fallback fills chunk_itl_p99_ms");
  assert.equal(row.chunk_itl_p99_ms, 25, "nearest-rank p99 of gaps 20/25/25");
  assert.equal(row.chunk_pause_2s_count, 0);
  assert.equal(row.first_content_at, base + 45);
});

test("non-stream rows keep NULL aggregates (honest absence, not zeros)", async () => {
  const db = getDbInstance();
  const id = `test-chunk-null-${Date.now()}`;
  await saveCallLog({
    id,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 100,
    tokens: {},
  });
  await waitForCallLogSaves(5_000);
  const row = db
    .prepare(
      `SELECT first_byte_at, first_forward_at, chunk_itl_p99_ms, chunk_pause_2s_count, first_content_at
       FROM call_logs WHERE id = ?`
    )
    .get(id) as Record<string, number | null>;
  assert.equal(row.first_byte_at, null);
  assert.equal(row.first_forward_at, null);
  assert.equal(row.chunk_itl_p99_ms, null);
  assert.equal(row.chunk_pause_2s_count, null);
  assert.equal(row.first_content_at, null);
});
