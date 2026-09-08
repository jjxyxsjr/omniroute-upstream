import test from "node:test";
import assert from "node:assert/strict";

import { ensureStreamReadiness } from "../../open-sse/utils/streamReadiness.ts";

const encoder = new TextEncoder();

/** Stream that never emits a single byte — the zero-first-byte hang shape. */
function neverBytesStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start() {
      await new Promise(() => {});
    },
  });
}

/** Stream that emits keepalive ping lines, then goes silent forever — bytes
 * arrived (transport alive) but no content event within the window. */
function pingThenSilentStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(": keepalive\n\n"));
      await new Promise(() => {});
    },
  });
}

test("nnd.20 zero-byte readiness timeout reports anyByteAt=null", async () => {
  const result = await ensureStreamReadiness(
    new Response(neverBytesStream(), { status: 200 }),
    { timeoutMs: 80, provider: "glm-cn", model: "glm-5.3-flash" }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "STREAM_READINESS_TIMEOUT");
  assert.equal("anyByteAt" in result && result.anyByteAt, null);
});

test("nnd.20 ping-only readiness timeout reports anyByteAt as a timestamp", async () => {
  const t0 = Date.now();
  const result = await ensureStreamReadiness(
    new Response(pingThenSilentStream(), { status: 200 }),
    { timeoutMs: 120, provider: "glm-cn", model: "glm-5.3-flash" }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "STREAM_READINESS_TIMEOUT");
  assert.ok("anyByteAt" in result);
  const anyByteAt = (result as { anyByteAt?: number | null }).anyByteAt;
  assert.ok(typeof anyByteAt === "number", `expected number, got ${anyByteAt}`);
  assert.ok(anyByteAt! >= t0 && anyByteAt! <= Date.now() + 50);
});

test("nnd.20 successful readiness keeps firstContentEventAt and stays unaffected", async () => {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`
        )
      );
      controller.close();
    },
  });
  const result = await ensureStreamReadiness(new Response(stream, { status: 200 }), {
    timeoutMs: 500,
    provider: "glm-cn",
    model: "glm-5.3-flash",
  });
  assert.equal(result.ok, true);
  assert.ok(typeof (result as { firstContentEventAt?: number }).firstContentEventAt === "number");
});
