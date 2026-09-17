/**
 * #87: the reasoning-only probe behind the [callLogs] reasoning-only warning.
 * The real-world shape it must catch (Tencent LKEAP × MiniMax M3, 2026-09-17):
 * status 200, content=null, whole answer in reasoning_content, finish=stop.
 * Tool turns and normal text turns must stay silent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isReasoningOnlyResponse } from "../../../src/lib/usage/reasoningOnlyDetect.ts";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "这是模型的完整回答",
          ...overrides,
        },
        ...("choiceOverrides" in overrides ? (overrides.choiceOverrides as object) : {}),
      },
    ],
  };
}

describe("isReasoningOnlyResponse", () => {
  it("detects the observed failure shape: empty content + full answer in reasoning", () => {
    assert.equal(isReasoningOnlyResponse(body()), true);
  });

  it("detects the empty-string content variant", () => {
    assert.equal(isReasoningOnlyResponse(body({ content: "   " })), true);
  });

  it("ignores tool turns even when content is empty", () => {
    assert.equal(
      isReasoningOnlyResponse(
        body({ tool_calls: [{ id: "c1", function: { name: "Bash", arguments: "{}" } }] })
      ),
      false
    );
  });

  it("ignores tool turns with finish_reason=tool_calls", () => {
    const b = body();
    (b.choices[0] as { finish_reason?: string }).finish_reason = "tool_calls";
    assert.equal(isReasoningOnlyResponse(b), false);
  });

  it("ignores responses with visible content", () => {
    assert.equal(isReasoningOnlyResponse(body({ content: "回答正文" })), false);
  });

  it("ignores responses without reasoning", () => {
    assert.equal(isReasoningOnlyResponse(body({ reasoning_content: null })), false);
  });

  it("ignores non-object shapes", () => {
    assert.equal(isReasoningOnlyResponse(null), false);
    assert.equal(isReasoningOnlyResponse("ok"), false);
    assert.equal(isReasoningOnlyResponse({ choices: [] }), false);
    assert.equal(isReasoningOnlyResponse({}), false);
  });
});
