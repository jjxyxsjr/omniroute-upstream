/**
 * nnd.46 (#240) — Claude-door effort-variant translation.
 *
 * glm-5.3[-flash]-{low,high,max} ids are gateway conventions; the vendor's
 * anthropic door only knows base ids. The OpenAI-door pass
 * (applyZaiGlm53OpenAIDefaults) gates on zai/glm-coding-apikey, so custom
 * anthropic-compatible GLM connections ("glm-cn") sent variant names out raw
 * → upstream 400 (production: 2026-11-12/13, 59 requests, bridge describe +
 * codex client). The claude-wire sibling maps variant → base +
 * thinking.budget_tokens instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyZaiGlm53ClaudeDefaults } from "../../../open-sse/executors/default.ts";

const claudeBody = (over: Record<string, unknown> = {}) => ({
  model: "glm-5.3-flash-high",
  max_tokens: 8192,
  stream: false,
  messages: [{ role: "user", content: [{ type: "image", source: { type: "base64" } }] }],
  ...over,
});

test("variant → base + thinking.budget_tokens (glm-cn, the production hole)", () => {
  const out = applyZaiGlm53ClaudeDefaults(
    "glm-cn",
    "glm-5.3-flash-high",
    claudeBody()
  ) as Record<string, unknown>;
  assert.equal(out.model, "glm-5.3-flash", "suffix stripped");
  assert.equal(out.reasoning_effort, undefined, "openai-wire effort must not ride the claude wire");
  assert.equal(out.reasoning, undefined);
  const thinking = out.thinking as Record<string, unknown>;
  assert.equal(thinking.type, "enabled");
  assert.equal(thinking.clear_thinking, false);
  // "high" reads 131072 off the table, then fitThinkingToMaxTokens fits it
  // under the model's output cap with the caller's max_tokens as response
  // room: cap 131072 − room 8192 = 122880 (the requested budget is adjusted,
  // never the response room).
  assert.equal(thinking.budget_tokens, 122880, "high → full budget fitted under the cap");
  // Anthropic contract: max_tokens > budget_tokens after fitting.
  assert.equal(out.max_tokens, 131072);
  assert.ok((out.max_tokens as number) > (thinking.budget_tokens as number));
});

test("low variant gets the 1024 floor budget; client thinking budget wins", () => {
  const out = applyZaiGlm53ClaudeDefaults(
    "glm-cn",
    "glm-5.3-flash-low",
    claudeBody({ model: "glm-5.3-flash-low" })
  ) as Record<string, unknown>;
  assert.equal(out.model, "glm-5.3-flash");
  assert.equal((out.thinking as Record<string, unknown>).budget_tokens, 1024);

  const kept = applyZaiGlm53ClaudeDefaults(
    "glm-cn",
    "glm-5.3-flash-high",
    claudeBody({ thinking: { type: "enabled", budget_tokens: 4096 } })
  ) as Record<string, unknown>;
  assert.equal(
    (kept.thinking as Record<string, unknown>).budget_tokens,
    4096,
    "an explicit client budget is preserved, never overridden"
  );
});

test("base ids and foreign providers return untouched (no blast radius)", () => {
  const base = claudeBody({ model: "glm-5.3-flash" });
  const outBase = applyZaiGlm53ClaudeDefaults("glm-cn", "glm-5.3-flash", base);
  assert.equal(outBase, base, "base id on glm-cn keeps today's bare, working shape");

  const zaiLegacy = claudeBody(); // variant, but a provider outside the gate
  const outForeign = applyZaiGlm53ClaudeDefaults("some-other-provider", "glm-5.3-flash-high", zaiLegacy);
  assert.equal(outForeign, zaiLegacy);

  // zai variants on the claude wire reach this pass already stripped by the
  // OpenAI-door sibling — the base result must not be re-mutated.
  const alreadyStripped = claudeBody({ model: "glm-5.3-flash", reasoning_effort: "high" });
  const outStripped = applyZaiGlm53ClaudeDefaults("zai", "glm-5.3-flash", alreadyStripped);
  assert.equal(outStripped, alreadyStripped, "legacy zai shape is left alone");
});
