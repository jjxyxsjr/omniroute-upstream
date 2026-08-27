/**
 * Regression (2026-08-27 incident): a Claude-protocol client (Claude Code on
 * /v1/messages) working against the all-text `max` combo had a screenshot
 * returned by a tool — the image nested inside a `tool_result` block's content
 * array (user message content[0].content[0]).
 *
 * The combo compatibility filter's media detector sees nested hits and failed
 * closed (capability_mismatch 400 "No target in combo max has confirmed vision
 * support"), but the vision bridge's extract↔replace pair only handled
 * TOP-LEVEL image parts — the nested image was silently skipped, the describe
 * path never ran, and the raw image reached the filter.
 *
 * Fix under test: extractImageParts/replaceImageParts cover images nested in
 * `tool_result` content arrays with the same positional contract, so the
 * bridge describes them and the all-text combo can answer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-vb-toolresult-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { extractImageParts, replaceImageParts } = await import(
  "../../../src/lib/guardrails/visionBridgeHelpers.ts"
);
const { VisionBridgeGuardrail } = await import("../../../src/lib/guardrails/visionBridge.ts");
const { getResolvedModelCapabilities } = await import("../../../src/lib/modelCapabilities.ts");
const core = await import("../../../src/lib/db/core.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// ── extractImageParts ───────────────────────────────────────────────────────

test("extract finds an image nested inside a tool_result content array", () => {
  const messages = [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
          ],
        },
        { type: "text", text: "截图里是什么?" },
      ],
    },
  ];
  const parts = extractImageParts(messages);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].messageIndex, 0);
  assert.equal(parts[0].partIndex, 0, "partIndex points at the tool_result container");
  assert.equal(parts[0].innerIndex, 0, "innerIndex points inside the tool_result content array");
  assert.equal(parts[0].imageType, "image");
  assert.ok(parts[0].imageUrl.startsWith("data:image/png;base64,"));
});

test("extract keeps canonical interleaved order across top-level and nested images", () => {
  const messages = [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } }],
        },
      ],
    },
    { role: "assistant", content: "ok" },
    {
      role: "user",
      content: [
        { type: "text", text: "and this one" },
        { type: "image", source: { type: "url", url: "https://example.com/top.png" } },
      ],
    },
  ];
  const parts = extractImageParts(messages);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].imageUrl, "data:image/png;base64,AAA=", "nested msg0 image comes first");
  assert.equal(parts[0].innerIndex, 0);
  assert.equal(parts[1].messageIndex, 2, "top-level msg2 image comes second");
  assert.equal(parts[1].imageUrl, "https://example.com/top.png");
  assert.equal(parts[1].innerIndex, undefined, "top-level parts carry no innerIndex");
});

test("extract ignores tool_result blocks with non-image content", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "plain text result" },
        { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "no media" }] },
      ],
    },
  ];
  assert.deepEqual(extractImageParts(messages), []);
});

// ── replaceImageParts ───────────────────────────────────────────────────────

test("replace splices the description INTO the tool_result content, preserving the block", () => {
  const body = {
    model: "max",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
            ],
          },
          { type: "text", text: "截图里是什么?" },
        ],
      },
    ],
  };
  const out = replaceImageParts(body as never, ["[Image 1]: a dark green 1px screenshot"]);
  const block = (out.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content[0];
  assert.equal(block.type, "tool_result", "the container block survives");
  assert.equal(block.tool_use_id, "t1", "tool_use_id survives");
  const inner = block.content as Array<Record<string, unknown>>;
  assert.equal(inner.length, 1);
  assert.equal(inner[0].type, "text", "nested image becomes a text part in place");
  assert.equal(inner[0].text, "[Image 1]: a dark green 1px screenshot");
  assert.equal(
    JSON.stringify(out).includes("base64"),
    false,
    "no raw image bytes remain in the payload"
  );
});

test("replace keeps a nested image whose describe failed (null description)", () => {
  const body = {
    model: "max",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }],
          },
        ],
      },
    ],
  };
  const out = replaceImageParts(body as never, [null]);
  const firstMessage = (out.messages as Array<{ content: Array<Record<string, unknown>> }>)[0];
  const inner = (firstMessage.content[0].content as unknown) as Array<Record<string, unknown>>;
  assert.equal(inner[0].type, "image", "original nested image preserved");
  assert.ok(JSON.stringify(out).includes("base64"), "raw image bytes preserved");
});

test("replace lands each description on the right image across mixed nesting", () => {
  const body = {
    model: "max",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
            ],
          },
          { type: "image", source: { type: "url", url: "https://example.com/top.png" } },
        ],
      },
    ],
  };
  const out = replaceImageParts(body as never, ["desc-A", "desc-B", "desc-C"]);
  const content = (out.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
  const inner = content[0].content as Array<Record<string, unknown>>;
  assert.equal(inner[0].text, "desc-A", "first nested image gets the first description");
  assert.equal(inner[1].text, "desc-B", "second nested image gets the second description");
  assert.equal((content[1] as { text?: string }).text, "desc-C", "top-level image gets the third");
});

// ── Guardrail end-to-end (incident shape, describe mode) ────────────────────

const VISION_MODEL = "openai/gpt-4o";
const TEXT_MODEL_A = "google/gemma-2-27b";
const TEXT_MODEL_B = "mistral/mistral-large-latest";

test("fixture models have the expected static vision capability", () => {
  assert.equal(getResolvedModelCapabilities(VISION_MODEL).supportsVision, true);
  assert.notEqual(getResolvedModelCapabilities(TEXT_MODEL_A).supportsVision, true);
  assert.notEqual(getResolvedModelCapabilities(TEXT_MODEL_B).supportsVision, true);
});

test("bridge describes a tool_result-nested image for a no-vision combo (2026-08-27 incident)", async () => {
  await combosDb.createCombo({
    name: "text-only-combo",
    models: [
      { provider: "google", model: TEXT_MODEL_A },
      { provider: "mistral", model: TEXT_MODEL_B },
    ],
    strategy: "priority",
  });

  let visionCallCount = 0;
  const guardrail = new VisionBridgeGuardrail({
    deps: {
      // Production uses the modalityBridge* keys with mode "describe" — the
      // exact configuration live on 229 at incident time.
      getSettings: async () => ({
        modalityBridgeVisionEnabled: true,
        modalityBridgeVisionModel: VISION_MODEL,
        modalityBridgeVisionMode: "describe",
        modalityBridgeVisionPrompt: "Describe this image concisely.",
        modalityBridgeVisionMaxImages: 10,
      }),
      callVisionModel: async () => {
        visionCallCount++;
        return "a dark green screenshot";
      },
      hasUsableCredentials: async () => null,
    },
  });

  const result = await guardrail.preCall(
    {
      model: "text-only-combo",
      max_tokens: 128000,
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_fe7f3215",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: PNG },
                },
              ],
            },
            { type: "text", text: "截图里显示的是什么?" },
          ],
        },
      ],
    },
    { log: { debug() {}, warn() {}, info() {}, error() {} } } as never
  );

  assert.equal(result.blocked ?? false, false);
  assert.equal(visionCallCount, 1, "the nested image must be described exactly once");
  const payload = result.modifiedPayload as {
    messages: Array<{ content: Array<Record<string, unknown>> }>;
  };
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("base64"), false, "no raw image bytes remain");
  assert.ok(serialized.includes("a dark green screenshot"), "description present in payload");
  const block = payload.messages[0].content[0];
  assert.equal(block.type, "tool_result", "tool_result block preserved");
  assert.equal(block.tool_use_id, "call_fe7f3215");
});
