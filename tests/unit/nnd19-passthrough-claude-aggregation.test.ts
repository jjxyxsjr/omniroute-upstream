// nnd.19: three fixes for the 2026-09-07 glm-5.3 empty-content storm.
//
// Storm anatomy (production evidence 2026-09-07): a Claude→Claude passthrough
// stream (glm-cn Anthropic door, psd targetFormat=claude) delivered a full SSE
// response to the client (~100KB, completion_tokens=786 billed by Zhipu), but
// the passthrough branch's onComplete aggregation never accumulated Claude
// events (only OpenAI chunks / Responses deltas were collected), so the
// synthesized call-log body carried content=null. isEmptyContentResponse then
// reclassified the finished stream as 502/empty_content, and the quality-502
// model lockout fanned one soft failure out into minutes of ALL_TARGETS_SKIPPED.
import test from "node:test";
import assert from "node:assert/strict";

import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.ts";
import { isEmptyContentResponse } from "../../open-sse/services/errorClassifier.ts";
import { resolveModelLockoutSettings } from "../../src/lib/resilience/modelLockoutSettings";

// A realistic interleaved-thinking Claude SSE stream: thinking block + text
// block (the shape Zhipu's glm-5.3 returns for Claude Code / ZCode clients).
const CLAUDE_INTERLEAVED_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"glm-5.3"}}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"让我想想"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"你好"}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"世界"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":786}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
].join("\n\n") + "\n\n";

const CLAUDE_TOOL_USE_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m2","type":"message","role":"assistant","content":[]}}',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"Bash","input":{}}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":"}}',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":120}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
].join("\n\n") + "\n\n";

interface CompletedPayload {
  status?: number;
  responseBody?: Record<string, unknown>;
}

async function runClaudePassthrough(sse: string): Promise<CompletedPayload | null> {
  let completed: CompletedPayload | null = null;
  const transform = createPassthroughStreamWithLogger(
    "glm-cn",
    null,
    null,
    "glm-5.3",
    null,
    { model: "glm-cn/glm-5.3", stream: true, messages: [] },
    (payload) => {
      completed = payload as CompletedPayload;
    },
    null,
    null,
    "claude",
    null
  );

  const encoder = new TextEncoder();
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const chunks: string[] = [];
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
    } catch {
      // flush races can close the readable early; the forwarded bytes are
      // asserted via the onComplete aggregation, not here
    }
  })();

  await writer.write(encoder.encode(sse));
  await writer.close();
  await pump;
  return completed;
}

function messageOf(completed: CompletedPayload | null): Record<string, unknown> {
  assert.ok(completed, "onComplete must fire for a claude passthrough stream");
  const body = completed.responseBody as { choices?: Array<{ message?: Record<string, unknown> }> };
  assert.ok(Array.isArray(body?.choices) && body.choices[0]?.message, "aggregated body must be chat-shaped");
  return body.choices[0].message as Record<string, unknown>;
}

test("nnd.19 fix1: claude passthrough aggregates text_delta into responseBody.content", async () => {
  const completed = await runClaudePassthrough(CLAUDE_INTERLEAVED_SSE);
  const message = messageOf(completed);
  assert.equal(message.content, "你好世界");
  assert.equal(message.reasoning_content, "让我想想");
});

test("nnd.19 fix1: claude tool_use stream marks tool_calls, not empty content", async () => {
  const completed = await runClaudePassthrough(CLAUDE_TOOL_USE_SSE);
  const body = completed!.responseBody as {
    choices?: Array<{ message?: Record<string, unknown>; finish_reason?: string }>;
  };
  const choice = body.choices![0];
  assert.equal(choice.finish_reason, "tool_calls", "tool_use stream must finish as tool_calls");
  // A pure tool-call turn has no visible text; the aggregation must still not
  // look like an empty fake success once content aggregation exists.
  assert.equal(isEmptyContentResponse(completed!.responseBody), false);
});

test("nnd.19 fix2: billed completion_tokens>0 is never empty content (choices shape)", () => {
  // Exact production shape from 2026-09-07T02:37:54 artifact: content lost by
  // aggregation, upstream billed 786 output tokens.
  assert.equal(
    isEmptyContentResponse({
      choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }],
      usage: { prompt_tokens: 90419, completion_tokens: 786, total_tokens: 91205 },
    }),
    false
  );
});

test("nnd.19 fix2: claude-shape body with billed output_tokens>0 is never empty content", () => {
  assert.equal(
    isEmptyContentResponse({
      content: [],
      stop_reason: "end_turn",
      usage: { output_tokens: 786, input_tokens: 90419 },
    }),
    false
  );
});

test("nnd.15 burnout guard stays: zero-billed reasoning-only stream is still a fake success", () => {
  assert.equal(
    isEmptyContentResponse({
      choices: [
        {
          message: { role: "assistant", content: null, reasoning_content: "想了但没输出" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
    }),
    true
  );
  // and the classic no-usage empty shape stays flagged
  assert.equal(
    isEmptyContentResponse({
      choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }],
    }),
    true
  );
});

test("nnd.19 fix3: model lockout defaults quality failures OFF (no fan-out lockout)", () => {
  const defaults = resolveModelLockoutSettings(null);
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.qualityFailureLockout, false, "quality 502 must not lock by default");
  // Explicit opt-in still honors the operator's choice.
  const optedIn = resolveModelLockoutSettings({ modelLockout: { enabled: true, qualityFailureLockout: true } });
  assert.equal(optedIn.qualityFailureLockout, true);
  // Existing production shape (no qualityFailureLockout field) keeps upstream
  // HTTP-status lockout but turns the quality branch off with zero config edits.
  const prodShape = resolveModelLockoutSettings({
    modelLockout: { enabled: true, errorCodes: [403, 404, 429, 502, 503, 504] },
  });
  assert.equal(prodShape.enabled, true);
  assert.equal(prodShape.qualityFailureLockout, false);
});
