import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

useDecollidedMigrationsDir();
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-tail-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { writeCallArtifact, readCallArtifact } = await import(
  "../../src/lib/usage/callLogArtifacts.ts"
);

const OMITTED = "[omitted: call log artifact size limit exceeded]";

// A Claude-Code-style session: many turns, each turn a big message. The whole
// body serializes well past the 512KB cap — the shape where the old code
// dropped everything to OMITTED and incident triage lost the failure context
// entirely (#91).
function bigChatBody(messageCount: number, perMessageBytes: number) {
  const filler = "x".repeat(perMessageBytes);
  // Marker at the END of each message: the tail-shrink keeps the tail of every
  // text, so only end-anchored markers survive — the same property a real
  // conversation relies on (the newest words of a turn are what matter).
  return {
    model: "glm-5.3",
    stream: true,
    messages: Array.from({ length: messageCount }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `${filler} end-msg-${i}` }],
    })),
  };
}

function artifact(body: unknown) {
  return {
    schemaVersion: 5 as const,
    summary: {
      id: `tail-${Math.random().toString(16).slice(2)}`,
      timestamp: new Date().toISOString(),
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      model: "glm-5.3",
      requestedModel: null,
    },
    requestBody: body,
    responseBody: { choices: [{ message: { content: "ok" } }] },
    error: null,
  } as never;
}

function roundTrip(input: ReturnType<typeof artifact>) {
  const relativePath = `tail-limit/${(input as { summary: { id: string } }).summary.id}.json`;
  assert.ok(writeCallArtifact(input, relativePath), "artifact should be written");
  const { artifact: stored, state } = readCallArtifact(relativePath);
  assert.equal(state, "ready");
  assert.ok(stored, "artifact should be readable");
  return stored as unknown as Record<string, unknown>;
}

test("an oversized chat body keeps tail messages instead of omitting everything", () => {
  // ~48 turns x ~24KB ≈ 1.2MB — 2.4x the default cap.
  const stored = roundTrip(artifact(bigChatBody(48, 24 * 1024)));

  const req = stored.requestBody as Record<string, unknown>;
  const messages = req.messages as Array<Record<string, unknown>>;

  assert.notEqual(stored.requestBody, OMITTED);
  assert.ok(Array.isArray(messages), "messages array should survive");
  assert.ok(messages.length > 0 && messages.length < 49, `tail messages kept, got ${messages?.length}`);
  assert.deepEqual(messages[0], { _omniroute_truncated_array: true, originalLength: 48 });
  // Tail retention: the LAST authored turn must be present (the newest turns
  // carry the failure context — the whole point of #91).
  const last = messages[messages.length - 1];
  const lastText = JSON.stringify(last);
  assert.ok(lastText.includes("end-msg-47"), `last message retained, got tail starting at ${lastText.slice(0, 60)}`);
});

test("the tail-retained artifact fits the size budget on disk", () => {
  const relPath = `tail-limit/fit-${Math.random().toString(16).slice(2)}.json`;
  assert.ok(writeCallArtifact(artifact(bigChatBody(48, 24 * 1024)), relPath));
  const size = fs.statSync(path.join(TEST_DATA_DIR, "call_logs", relPath)).size;
  assert.ok(size <= 512 * 1024, `artifact must stay under the cap, got ${size}`);
});

// An agentic body where the newest human input sits far from the end: a long
// tool-result train follows it, and earlier conversation history precedes it.
// This is the production shape #92 measured on >400KB sessions (42% carry
// their last human input >60 messages back).
function agenticBody(toolTurns: number, perTurnBytes: number) {
  const turns: Array<{ role: string; content: unknown }> = [];
  // Older conversation history before the newest human input.
  for (let i = 0; i < 20; i++) {
    turns.push({ role: "user", content: `旧历史轮 ${i}` });
    turns.push({ role: "assistant", content: "ok" });
  }
  turns.push({ role: "user", content: [{ type: "text", text: "这是最重要的一条真人输入 end-human" }] });
  // Each tool turn = tool_result + assistant ack = 2 messages, so the human
  // input ends up `toolTurns * 2` messages from the end.
  for (let i = 0; i < toolTurns; i++) {
    turns.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(perTurnBytes) }],
    });
    turns.push({ role: "assistant", content: "ok" });
  }
  return { model: "glm-5.3", stream: true, messages: turns };
}

test("window extends back to the newest human input when tools trail it (#92)", () => {
  // Newest human input is 100 messages from the end (50 tool turns trailing).
  const body = agenticBody(50, 16 * 1024); // ~800KB of tool results behind it
  const stored = roundTrip(artifact(body));

  const req = stored.requestBody as Record<string, unknown>;
  assert.notEqual(stored.requestBody, OMITTED);
  const messages = req.messages as Array<Record<string, unknown>>;
  const serialized = JSON.stringify(messages);
  assert.ok(serialized.includes("end-human"), "the newest human input survives the window");
  assert.ok(
    serialized.includes("truncated: call log size limit"),
    "tool-result turns inside the window are shrunk to the small budget"
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(stored.requestBody)) <= 512 * 1024,
    "extended window still fits the cap"
  );
});

test("hunt is capped: a human input beyond 150 messages back stays dropped", () => {
  // 100 tool turns = 200 messages of trailing tools: the input sits 200 back.
  const body = agenticBody(100, 16 * 1024);
  const stored = roundTrip(artifact(body));

  const req = stored.requestBody as Record<string, unknown>;
  assert.notEqual(stored.requestBody, OMITTED);
  const serialized = JSON.stringify(req.messages);
  assert.ok(!serialized.includes("end-human"), "beyond the hunt cap the old input stays dropped");
  assert.ok(
    Buffer.byteLength(JSON.stringify(stored.requestBody)) <= 512 * 1024,
    "capped window fits the budget"
  );
});

test("bodies without a messages array keep the old minimal-omitted behavior", () => {
  // Non-chat body (string) that trips the cap on its own — the pre-#91 shape.
  const stored = roundTrip(artifact("y".repeat(900 * 1024)));

  assert.equal(stored.requestBody, OMITTED);
});

test("oversized messages individually shrink instead of breaking the budget", () => {
  // Few turns, but one turn is huge: the tail picker must also cut the
  // retained messages' text down, not just drop whole messages.
  const body = bigChatBody(3, 300 * 1024); // ~900KB in 3 messages
  const stored = roundTrip(artifact(body));

  const req = stored.requestBody as Record<string, unknown>;
  assert.notEqual(stored.requestBody, OMITTED);
  const messages = req.messages as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(messages) && messages.length === 3, "all three turns survive");
  assert.ok(
    Buffer.byteLength(JSON.stringify(stored.requestBody)) <= 512 * 1024,
    "retained body fits budget"
  );
  const first = JSON.stringify(messages[0]);
  assert.ok(first.includes("x".repeat(100)), "turn text is cut but kept");
  const last = JSON.stringify(messages[messages.length - 1]);
  assert.ok(last.includes("truncated: call log size limit"), "cut turns say so");
});
