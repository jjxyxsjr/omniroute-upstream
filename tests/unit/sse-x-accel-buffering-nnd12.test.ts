/**
 * 2g-c (nnd.12) — every client-facing streaming/SSE exit must send
 * `X-Accel-Buffering: no` so a reverse proxy in front of the gateway (nginx /
 * 宝塔 default proxy_buffering) cannot batch the stream into ~14KB chunks.
 * The main chatCore exit already sets it (chatCore/responseHeaders.ts); these
 * are the bypass exits that build their own headers and used to miss it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// checkSemanticCache -> getCachedResponse reads the semantic_cache SQLite
// table, so the isolated DATA_DIR must exist before that import runs.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-xaccel-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { withEarlyStreamKeepalive } = await import("../../open-sse/utils/earlyStreamKeepalive.ts");
const { checkSemanticCache } = await import("../../open-sse/handlers/chatCore/semanticCache.ts");
const { generateSignature, setCachedResponse, clearCache } =
  await import("../../src/lib/semanticCache.ts");
const { createStreamingResponse } = await import("../../open-sse/utils/bypassResponse.ts");
const { transformOpenAISSEToGeminiSSE } =
  await import("../../open-sse/translator/response/openai-to-gemini-sse.ts");
const { protectMcpSseResponse } = await import("../../open-sse/mcp-server/httpTransport.ts");
const core = await import("../../src/lib/db/core.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function drain(response: Response): Promise<void> {
  const reader = response.body!.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    /* consumer-side read errors are irrelevant here */
  }
}

test("2g-c earlyStreamKeepalive slow-path SSE sends X-Accel-Buffering: no", async () => {
  const slow = new Promise<Response>((resolve) => {
    setTimeout(
      () =>
        resolve(
          new Response("data: {}\n\ndata: [DONE]\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          })
        ),
      120
    );
  });

  const result = await withEarlyStreamKeepalive(slow, { thresholdMs: 25, intervalMs: 20 });
  assert.equal(result.headers.get("x-accel-buffering"), "no");
  await drain(result);
});

test("2g-c semantic-cache streaming HIT sends X-Accel-Buffering: no (JSON HIT does not)", async () => {
  clearCache();
  const baseArgs = {
    semanticCacheEnabled: true,
    body: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "cached query" }],
      temperature: 0,
    },
    clientRawRequest: { headers: {} },
    model: "gpt-4o",
    provider: "openai",
    reqLogger: { logConvertedResponse: () => {} },
    effectiveServiceTier: undefined,
    connectionId: null,
    startTime: Date.now() - 5,
    log: { debug: () => {} },
    persistAttemptLogs: () => {},
    apiKeyId: null,
    // nnd.31: 51 threads a pending-request scope through checkSemanticCache.
    pendingScope: {
      id: null,
      model: "gpt-4o",
      provider: "openai",
      connectionId: null,
      videoTranscriptSensitive: false,
    },
  };
  const cached = {
    id: "chatcmpl-cached-1",
    choices: [
      { index: 0, message: { role: "assistant", content: "cached answer" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };
  const signature = generateSignature(
    baseArgs.model,
    baseArgs.body.messages,
    baseArgs.body.temperature,
    undefined,
    undefined
  );
  setCachedResponse(signature, baseArgs.model, cached);

  const streamHit = await checkSemanticCache({ ...baseArgs, stream: true } as never);
  assert.ok(streamHit?.response, "streaming HIT should produce a response");
  assert.equal(streamHit.response.headers.get("content-type"), "text/event-stream");
  assert.equal(streamHit.response.headers.get("x-accel-buffering"), "no");
  await streamHit.response.body?.cancel();

  const jsonHit = await checkSemanticCache({ ...baseArgs, stream: false } as never);
  assert.ok(jsonHit?.response, "JSON HIT should produce a response");
  assert.equal(
    jsonHit.response.headers.get("x-accel-buffering"),
    null,
    "non-streaming JSON HIT must not carry the SSE header"
  );
});

test("2g-c bypassResponse createStreamingResponse sends X-Accel-Buffering: no", async () => {
  const out = createStreamingResponse("openai", "gpt-4o");
  assert.ok(out.response);
  assert.match(out.response.headers.get("content-type") || "", /text\/event-stream/);
  assert.equal(out.response.headers.get("x-accel-buffering"), "no");
});

test("2g-c Gemini streamGenerateContent SSE sends X-Accel-Buffering: no", async () => {
  const upstream = new Response(
    'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
  const out = transformOpenAISSEToGeminiSSE(upstream, "fallback");
  assert.equal(out.headers.get("x-accel-buffering"), "no");
  await out.body?.cancel();
});

test("2g-c protectMcpSseResponse stamps X-Accel-Buffering: no on POST SSE responses", () => {
  const response = new Response("event: message\ndata: {}\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
  const out = protectMcpSseResponse(
    new Request("http://localhost/api/mcp/stream", { method: "POST" }),
    response
  );
  assert.equal(out.headers.get("x-accel-buffering"), "no");
});
