import test from "node:test";
import assert from "node:assert/strict";

import { resolveAlternateFormat } from "../../open-sse/config/providers/alternateFormats.ts";
import { glm_cnProvider } from "../../open-sse/config/providers/registry/glm/cn/index.ts";
import { getGlmPrimaryTransport } from "../../open-sse/config/glmProvider.ts";
import { resolveChatCoreTargetFormat } from "../../open-sse/handlers/chatCore/targetFormat.ts";
import { GlmExecutor } from "../../open-sse/executors/glm.ts";

const CLAUDE_BODY = {
  model: "glm-cn/glm-5.3-flash",
  max_tokens: 2048,
  stream: true,
  system: [{ type: "text", text: "be terse" }],
  thinking: { type: "adaptive", budget_tokens: 1024 },
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

const PASSTHROUGH_PSD = { apiRegion: "china", targetFormat: "claude" };

test("glm-cn registry declares the Anthropic-door alternate format", () => {
  const alt = resolveAlternateFormat(glm_cnProvider, { targetFormat: "claude" });
  assert.ok(alt, "claude alternate must be declared for glm-cn");
  assert.equal(alt.format, "claude");
  assert.equal(alt.baseUrl, "https://open.bigmodel.cn/api/anthropic/v1/messages");
  assert.equal(alt.authHeader, "x-api-key");
});

test("psd targetFormat=claude infers the anthropic transport", () => {
  assert.equal(getGlmPrimaryTransport(PASSTHROUGH_PSD), "anthropic");
  assert.equal(getGlmPrimaryTransport({ apiRegion: "china" }), "openai");
});

test("chatCore keeps claude as the wire target for a passthrough connection", () => {
  const { targetFormat } = resolveChatCoreTargetFormat({
    provider: "glm-cn",
    resolvedModel: "glm-5.3-flash",
    apiFormat: undefined,
    sourceFormat: "claude",
    customModelTargetFormat: undefined,
    providerSpecificData: PASSTHROUGH_PSD,
  });
  assert.equal(targetFormat, "claude");
});

test("transformForTransport passes a claude body through untranslated", () => {
  const executor = new GlmExecutor("glm-cn");
  // chatCore strips the provider alias before handing the model to the executor
  const body = { ...structuredClone(CLAUDE_BODY), model: "glm-5.3-flash" };
  const out = executor.transformForTransport(
    "glm-5.3-flash",
    body,
    true,
    { apiKey: "k", providerSpecificData: PASSTHROUGH_PSD },
    "anthropic"
  ) as Record<string, unknown>;

  assert.equal(out.model, "glm-5.3-flash");
  assert.ok(Array.isArray(out.system), "system array must stay claude-shaped");
  assert.ok(Array.isArray((out.messages as unknown[])[0]
    ? ((out.messages as { content: unknown }[])[0].content as unknown[])
    : []), "content blocks must stay claude-shaped");
  const thinking = out.thinking as { type: string; budget_tokens?: number };
  assert.equal(thinking.type, "enabled", "adaptive must normalize to enabled for Zhipu");
  assert.equal(thinking.budget_tokens, 1024, "budget preserved");
  assert.equal(out.max_tokens, 2048);
});

test("transformForTransport still translates openai bodies without targetFormat", () => {
  const executor = new GlmExecutor("glm-cn");
  const out = executor.transformForTransport(
    "glm-cn/glm-5.3-flash",
    { model: "glm-cn/glm-5.3-flash", max_tokens: 512, stream: true, messages: [{ role: "user", content: "hi" }] },
    true,
    { apiKey: "k", providerSpecificData: { apiRegion: "china" } },
    "anthropic"
  ) as Record<string, unknown>;

  assert.ok(Array.isArray(out.system) || out.system === undefined);
  const first = (out.messages as { role: string; content: unknown }[])[0];
  assert.equal(first.role, "user");
  assert.ok(Array.isArray(first.content), "openai→claude translation must still happen");
});

test("execute() hits the china anthropic door and returns claude SSE untranslated", async () => {
  const executor = new GlmExecutor("glm-cn");
  const originalFetch = globalThis.fetch;
  let captured: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null =
    null;

  globalThis.fetch = async (url, init: RequestInit = {}) => {
    captured = {
      url: String(url),
      body: JSON.parse(String(init.body || "{}")) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
    };
    return new Response(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant","content":[]}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } }
    );
  };

  try {
    const result = await executor.execute({
      model: "glm-cn/glm-5.3-flash",
      body: structuredClone(CLAUDE_BODY),
      stream: true,
      credentials: { apiKey: "glm-key", providerSpecificData: PASSTHROUGH_PSD },
    });

    assert.ok(captured);
    assert.equal(captured.url, "https://open.bigmodel.cn/api/anthropic/v1/messages?beta=true");
    assert.equal(captured.headers["x-api-key"], "glm-key");
    assert.match(String(captured.headers["User-Agent"] ?? ""), /^claude-cli\//);
    assert.ok(Array.isArray(captured.body.system), "wire body must stay claude-shaped");
    assert.equal(captured.body.thinking.type, "enabled");
    assert.equal(result.targetFormat, "claude");

    const text = await result.response.text();
    assert.match(text, /message_start/, "response must be raw anthropic SSE, not translated");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
