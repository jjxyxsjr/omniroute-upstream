/**
 * redacted_thinking on Claude-compat upstreams that don't speak it (nnd.11).
 *
 * 2026-08-31 first sighting: sessions with thinking enabled carry
 * redacted_thinking blocks in history; GLM's translation layer digests them,
 * but anthropic-compatible passthrough forwards them verbatim and Volcano ark
 * 400s — whitelist is text/thinking/image/…, no redacted_thinking. Real
 * Anthropic upstreams MUST keep the blocks verbatim (they validate signatures
 * and reject modified blocks), so the cure is a per-provider env allowlist:
 * OMNIROUTE_NO_REDACTED_THINKING_PROVIDERS lists provider IDs whose compat
 * endpoints reject the block type; those get plain thinking placeholder
 * conversion instead.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OMNIROUTE_NO_REDACTED_THINKING_PROVIDERS = "anthropic-compatible-test-ark";

const { prepareClaudeRequest, resolveProvidersWithoutRedactedThinking } = await import(
  "../../open-sse/translator/helpers/claudeHelper.ts"
);

function historyBody() {
  return {
    model: "test-model",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "encblob==" },
          { type: "text", text: "answer" },
        ],
      },
      { role: "user", content: "go on" },
    ],
  };
}

function blockTypes(body: ReturnType<typeof historyBody>): string[] {
  const asst = body.messages.find((m) => m.role === "assistant");
  const content = asst?.content;
  return Array.isArray(content) ? content.map((b) => b.type) : [];
}

test("listed compat provider converts redacted_thinking to plain thinking", () => {
  const body = prepareClaudeRequest(historyBody(), "anthropic-compatible-test-ark");
  const types = blockTypes(body);
  assert.ok(!types.includes("redacted_thinking"), `no redacted block, got ${types.join(",")}`);
  assert.ok(types.includes("thinking"), "placeholder thinking present");
});

test("unlisted anthropic-compatible provider keeps blocks verbatim", () => {
  const body = prepareClaudeRequest(historyBody(), "anthropic-compatible-other-relay");
  assert.ok(blockTypes(body).includes("redacted_thinking"));
});

test("claude OAuth keeps blocks verbatim", () => {
  const body = prepareClaudeRequest(historyBody(), "claude");
  assert.ok(blockTypes(body).includes("redacted_thinking"));
});

test("env list parsing trims and ignores empties", () => {
  const set = resolveProvidersWithoutRedactedThinking({
    OMNIROUTE_NO_REDACTED_THINKING_PROVIDERS: " a , b ,, a ",
  });
  assert.equal(set.size, 2);
  assert.ok(set.has("a") && set.has("b"));
});
