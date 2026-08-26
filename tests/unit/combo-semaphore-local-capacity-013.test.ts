// 013: account-semaphore queue timeouts are LOCAL capacity pressure, not
// upstream quota failures. chatCore returns HTTP 429 with
// error.code = SEMAPHORE_TIMEOUT / SEMAPHORE_QUEUE_FULL (errorType
// "account_semaphore_capacity") when the per-connection maxConcurrent gate
// times out or its FIFO queue is full. The combo layer's local-capacity
// exemption (isLocalQueueCapacityErrorBody) must recognize those bodies so
// they do NOT fall through to checkFallbackError(429) — which would apply
// exponential cooldown + backoffLevel++ to a connection whose only "failure"
// is that OUR OWN queue was full (the "colder the busier" feedback loop on
// narrow lanes like tx=1 / ark=3). Same semantics as the pre-existing
// RATE_LIMIT_QUEUE_* exemption family (deploy 195 §1).
import test from "node:test";
import assert from "node:assert/strict";

import { isLocalQueueCapacityErrorBody } from "@omniroute/open-sse/services/combo/comboPredicates.ts";
import { createStreamingErrorResult } from "@omniroute/open-sse/handlers/chatCore/streamErrorResult.ts";
import { createErrorResult } from "@omniroute/open-sse/utils/error.ts";

test("013: predicate recognizes SEMAPHORE_TIMEOUT code", () => {
  assert.equal(
    isLocalQueueCapacityErrorBody({ error: { code: "SEMAPHORE_TIMEOUT" } }),
    true
  );
});

test("013: predicate recognizes SEMAPHORE_QUEUE_FULL code", () => {
  assert.equal(
    isLocalQueueCapacityErrorBody({ error: { code: "SEMAPHORE_QUEUE_FULL" } }),
    true
  );
});

test("013: predicate recognizes account_semaphore_capacity type (case-insensitive)", () => {
  assert.equal(
    isLocalQueueCapacityErrorBody({ error: { type: "Account_Semaphore_Capacity" } }),
    true
  );
});

test("013: predicate still recognizes the RATE_LIMIT_QUEUE family (no regression)", () => {
  assert.equal(
    isLocalQueueCapacityErrorBody({ error: { code: "RATE_LIMIT_QUEUE_TIMEOUT" } }),
    true
  );
});

test("013: predicate rejects unrelated error codes", () => {
  assert.equal(isLocalQueueCapacityErrorBody({ error: { code: "RATE_LIMIT_EXCEEDED" } }), false);
  assert.equal(isLocalQueueCapacityErrorBody({ error: { code: "UPSTREAM_429" } }), false);
  assert.equal(isLocalQueueCapacityErrorBody(null), false);
});

test("013: streaming semaphore 429 body round-trips into the predicate", async () => {
  const result = createStreamingErrorResult(429, "Semaphore timeout", "SEMAPHORE_TIMEOUT");
  const raw = await result.response.text();
  const firstDataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(firstDataLine, "SSE body must carry a data: line");
  const body = JSON.parse(firstDataLine.slice("data: ".length));
  assert.equal(body.error.code, "SEMAPHORE_TIMEOUT");
  assert.equal(isLocalQueueCapacityErrorBody(body), true);
});

test("013: non-streaming semaphore 429 body round-trips into the predicate", async () => {
  // This is the exact call chatCore's semaphore branch must make — passing the
  // code (+ type) so the combo layer can classify the body as local capacity.
  // Before 013 the branch called createErrorResult(429, msg) with NO code,
  // leaving the non-streaming body unidentifiable.
  const result = createErrorResult(
    429,
    "Semaphore timeout",
    null,
    "SEMAPHORE_TIMEOUT",
    "account_semaphore_capacity"
  );
  const body = await result.response.json();
  assert.equal(body.error.code, "SEMAPHORE_TIMEOUT");
  assert.equal(body.error.type, "account_semaphore_capacity");
  assert.equal(isLocalQueueCapacityErrorBody(body), true);
});
