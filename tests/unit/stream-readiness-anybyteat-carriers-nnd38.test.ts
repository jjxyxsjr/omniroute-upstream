/**
 * nnd.38 (#47/#30/#72): the zero-first-byte signal must survive from the
 * readiness gate to the attempt loop on at least one of its two carriers.
 *
 * The v3.8.52 restructure dropped BOTH carriers — the leg-result `anyByteAt`
 * field was lost in the streamingTail result construction, and the
 * X-OmniRoute-Any-Byte-At response header was emitted but never parsed —
 * which silently disabled the nnd.20 zero-byte rule (a silent upstream must
 * terminate, never be re-sent; 9-08 heap-amplification lesson).
 *
 * These tests drive the REAL producer (ensureStreamReadiness against
 * controllable streams) and the REAL dual-carrier resolver so a future
 * carrier drop fails here instead of in production.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ensureStreamReadiness } from "../../open-sse/utils/streamReadiness.ts";
import {
  shouldSwitchConnectionOnStreamReadinessTimeout,
  resolveStreamReadinessAnyByteAt,
} from "../../src/sse/handlers/chatHelpers.ts";

function silentBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start() {
      // Never enqueues anything: transport accepted, zero bytes ever.
    },
  });
}

function pingThenSilentBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      // A keepalive ping arrives (raw bytes = transport alive), then silence —
      // the "bytes but no content" stall shape.
      controller.enqueue(new TextEncoder().encode(": ping\n\n"));
    },
  });
}

function responseWith(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

// ── Producer: the readiness gate stamps both carriers ───────────────────────

test("producer: zero-byte hang → anyByteAt null + header 'none' + typed 504", async () => {
  const result = await ensureStreamReadiness(responseWith(silentBody()), { timeoutMs: 60 });

  assert.equal(result.ok, false);
  assert.equal(result.code, "STREAM_READINESS_TIMEOUT");
  assert.equal(result.anyByteAt, null, "zero bytes ever → explicit null, not undefined");
  const response = (result as { response?: Response }).response;
  assert.equal(response?.status, 504);
  assert.equal(response?.headers.get("X-OmniRoute-Any-Byte-At"), "none");
  assert.equal(response?.headers.get("Retry-After"), "1");
});

test("producer: ping-only stream → anyByteAt timestamp + header carries it", async () => {
  const before = Date.now();
  const result = await ensureStreamReadiness(responseWith(pingThenSilentBody()), {
    timeoutMs: 60,
    maxTimeoutMs: 80,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "STREAM_READINESS_TIMEOUT");
  const anyByteAt = (result as { anyByteAt?: number | null }).anyByteAt;
  assert.ok(typeof anyByteAt === "number" && anyByteAt >= before, "ping byte timestamp survives");
  const response = (result as { response?: Response }).response;
  assert.match(
    String(response?.headers.get("X-OmniRoute-Any-Byte-At")),
    /^\d+$/,
    "header carries the epoch-ms form"
  );
});

// ── Resolver: either carrier alone revives the signal ───────────────────────

test("resolver: result field wins when present (outer-gate carrier)", () => {
  assert.equal(resolveStreamReadinessAnyByteAt({ anyByteAt: null }), null);
  assert.equal(resolveStreamReadinessAnyByteAt({ anyByteAt: 12345 }), 12345);
});

test("resolver: header fallback when the field was dropped (inner-gate carrier)", () => {
  const none = new Response(null, { status: 504, headers: { "X-OmniRoute-Any-Byte-At": "none" } });
  assert.equal(resolveStreamReadinessAnyByteAt({ response: none }), null);
  const stamped = new Response(null, {
    status: 504,
    headers: { "X-OmniRoute-Any-Byte-At": "1729123456789" },
  });
  assert.equal(resolveStreamReadinessAnyByteAt({ response: stamped }), 1729123456789);
});

test("resolver: neither carrier → undefined (legacy unknown), never null", () => {
  assert.equal(resolveStreamReadinessAnyByteAt({}), undefined);
  assert.equal(
    resolveStreamReadinessAnyByteAt({ response: new Response(null, { status: 504 }) }),
    undefined,
    "missing header must not read as confirmed-zero-bytes"
  );
});

// ── Predicate pairing: the nnd.20 rule fires on the resolved value ─────────

test("predicate: zero-byte (null) terminates; timestamp switches; unknown stays legacy", () => {
  const decide = (value: number | null | undefined) =>
    shouldSwitchConnectionOnStreamReadinessTimeout(
      "stream_timeout",
      "STREAM_READINESS_TIMEOUT",
      0,
      false,
      value
    );
  assert.equal(decide(null), false, "confirmed zero bytes → terminate, never re-send");
  assert.equal(decide(1729123456789), true, "bytes-but-no-content → one bounded switch");
  assert.equal(decide(undefined), true, "unknown → legacy behavior (switch), as documented");
});

test("end-to-end pairing: producer output through the resolver reproduces the rule", async () => {
  const zeroByte = await ensureStreamReadiness(responseWith(silentBody()), { timeoutMs: 60 });
  const resolvedZero = resolveStreamReadinessAnyByteAt(
    zeroByte as unknown as { anyByteAt?: number | null; response?: Response }
  );
  assert.equal(resolvedZero, null, "carrier chain preserves the zero-byte verdict");
  assert.equal(
    shouldSwitchConnectionOnStreamReadinessTimeout(
      zeroByte.type,
      zeroByte.code,
      0,
      false,
      resolvedZero
    ),
    false,
    "a silent upstream must NOT be re-sent — the 9-08 lesson holds end to end"
  );
});
