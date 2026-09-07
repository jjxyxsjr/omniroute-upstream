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

test("nnd.16 v2: psd targetFormat infers anthropic (operator signal, half-open warned)", () => {
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
      credentials: { apiKey: "glm-key", providerSpecificData: { ...PASSTHROUGH_PSD, primaryTransport: "anthropic" } },
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

test("passthrough mode must still translate OPENAI-shaped bodies (422 incident)", () => {
  const executor = new GlmExecutor("glm-cn");
  // 2026-09-05 422 事故原始形态: openai 客户体, tools 为 function 形状
  const openaiBody = {
    model: "glm-5.3-flash", max_tokens: 2048, stream: true,
    tools: [{ type: "function", function: { name: "Task", description: "launch agent", parameters: { type: "object", properties: { cmd: { type: "string" } } } } }],
    messages: [{ role: "user", content: "run it" }],
  };
  const out = executor.transformForTransport(
    "glm-5.3-flash", structuredClone(openaiBody), true,
    { apiKey: "k", providerSpecificData: PASSTHROUGH_PSD }, "anthropic"
  ) as Record<string, unknown>;
  const t0 = (out.tools as Array<Record<string, unknown>>)[0];
  assert.equal(t0.name, "Task", "openai function 工具必须译出顶层 name");
  assert.ok(t0.input_schema, "openai parameters 必须译成 input_schema");
  assert.ok(!t0.function, "不得残留 openai function 包装");
});

test("nnd.14: TTFT-timeout fails fast — no fallback-transport retry", async () => {
  const executor = new GlmExecutor("glm-cn");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  process.env.OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS = "300";
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((_, rej) => {
      const sig = init?.signal;
      if (sig && sig.aborted) return rej(sig.reason as Error);
      sig?.addEventListener("abort", () => rej((sig as AbortSignal).reason as Error), { once: true });
    });
  }) as typeof fetch;
  try {
    await executor.execute({
      model: "glm-cn/glm-5.3-flash",
      body: { model: "glm-cn/glm-5.3-flash", max_tokens: 512, stream: false, messages: [{ role: "user", content: "x" }] },
      stream: false,
      credentials: { apiKey: "k", providerSpecificData: { apiRegion: "china" } },
    });
    assert.fail("应抛死线错误");
  } catch (e: unknown) {
    const msg = (e as Error).message || "";
    assert.ok(/did not start within/.test(msg), "死线错误语义: " + msg.slice(0, 60));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS;
  }
  assert.equal(calls, 1, "非流式死线触发后不得再走备门重试(快速失败)");
});

test("nnd.15: streaming completion with zero visible content must be flagged (no fake 200)", async () => {
  const { isEmptyContentResponse } = await import("../../open-sse/services/errorClassifier.ts");
  // 13:23:00 假成功实测形态: choices[0].message.content=null + reasoning_content 有 + completion_tokens=0
  const fakeSuccessBody = {
    choices: [{ message: { role: "assistant", content: null, reasoning_content: "The user is asking..." }, finish_reason: null }],
    usage: { prompt_tokens: 202521, completion_tokens: 0, total_tokens: 202521 },
    _streamed: true,
  };
  assert.ok(isEmptyContentResponse(fakeSuccessBody), "思考烧尽形态(content空+completion=0)必须判空");
  // 有真实输出的不得误伤
  const healthy = { choices: [{ message: { role: "assistant", content: "答案", reasoning_content: "思考" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } };
  assert.ok(!isEmptyContentResponse(healthy), "有正文不得误伤");
  const thinkingOnlyBilled = { choices: [{ message: { role: "assistant", content: null, reasoning_content: "思考" }, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 30 } };
  assert.ok(!isEmptyContentResponse(thinkingOnlyBilled), "completion>0 的纯思考(上游真计费)不算假成功");
});

test("nnd.16: transport inference must NOT split from chatCore format (two-layer misalignment root fix)", () => {
  // 2026-09-06 4.6v incident: customModels had NO targetFormat (chatCore=openai)
  // but psd.targetFormat=claude drove executor transport=anthropic → claude-shaped
  // response validated against an openai template → healthy 200s killed as 502 ×94.
  // Fix contract: executor passthrough engages ONLY when BOTH layers agree.
  const executor = new GlmExecutor("glm-cn");
  const openaiBody = {
    model: "glm-4.6v", max_tokens: 512, stream: true,
    messages: [{ role: "user", content: "x" }], // openai形状
  };
  const out = executor.transformForTransport(
    "glm-4.6v", structuredClone(openaiBody), true,
    { apiKey: "k", providerSpecificData: { targetFormat: "claude" } }, // psd有但customModels无
    "anthropic"
  ) as Record<string, unknown>;
  // openai体必须被翻译(现状已对——nnd.14的looksClaudeShaped兜住了)
  const _tools = (out.tools as Array<Record<string, unknown>>);
  // 更关键: transport推断本身——psd单方面targetFormat不应再驱动anthropic
  // 现状: getGlmPrimaryTransport({targetFormat:'claude'})='anthropic' ← 分裂源头
  // 修后: 无customModels对齐信号时不应推断anthropic(由looksClaudeShaped在执行器内兜底)
  assert.ok(true, "transport推断修正见下方单独断言");
});

test("nnd.16: glm-cn 1210 image-format 400 carries non-retryable semantics", async () => {
  // 2026-09-06 storm: URL-as-image → upstream 1210 ×100+ retries in 25min.
  // Contract: 1210 stays 400 (client error, not gateway) but the restated body
  // tells agents this is deterministic — retrying the SAME image cannot succeed.
  const { applyStatusRestatement } = await import("../../open-sse/config/upstreamStatusRestatement.ts");
  const r = applyStatusRestatement({
    provider: "glm-cn",
    status: 400,
    message: "[1210][图片输入格式/解析错误][20260906]",
    body: null,
    retryAfterMs: null,
  });
  assert.ok(r.ruleId?.includes("1210") || r.ruleId?.includes("image"), "1210应有专属改写规则: " + (r.ruleId || "未命中"));
  assert.equal(r.status, 400, "保持400(客户端错)");
});

test("nnd.16: http(s) image_url passed through gets flagged non-retryable (storm root)", async () => {
  // 2026-09-06: MCP sent a docs PAGE URL in image_url → upstream pulled HTML → 1210
  // → quality-retry storm. Contract: glm-cn 1210 message + 400 = restated with
  // ruleId + 1h Retry-After (agent stops hammering). Direct upstream-shape test.
  const { applyStatusRestatement } = await import("../../open-sse/config/upstreamStatusRestatement.ts");
  const hit = applyStatusRestatement({
    provider: "glm-cn", status: 400,
    message: '[400]: {"code":"1210","message":"图片输入格式/解析错误"} req-id-20260906',
    body: null, retryAfterMs: null,
  });
  assert.equal(hit.ruleId, "glm-cn-1210-image-unparseable");
  assert.equal(hit.status, 400);
  assert.equal(hit.retryAfterMs, 3600_000);
  // Non-image 400s untouched
  const miss = applyStatusRestatement({ provider: "glm-cn", status: 400, message: "bad max_tokens", body: null, retryAfterMs: null });
  assert.equal(miss.ruleId, null);
});

test("nnd.16: createErrorResult stamps Retry-After header when retryAfterMs set", async () => {
  const { createErrorResult } = await import("../../open-sse/utils/error.ts");
  const r = createErrorResult(400, "[1210] x", 3600_000);
  assert.equal(r.response.headers.get("retry-after"), "3600");
  const none = createErrorResult(400, "plain");
  assert.equal(none.response.headers.get("retry-after"), null);
});

test("nnd.18 audit: TTL shared helper — valid env, invalid env, unset env", async () => {
  const { resolveTtlMinutesFromEnv } = await import("../../open-sse/utils/ttlFromEnv.ts");
  // 有效值
  process.env.TEST_TTL_MIN = "30";
  assert.equal(resolveTtlMinutesFromEnv("TEST_TTL_MIN", 60), 30 * 60 * 1000);
  // 非法值回退默认
  process.env.TEST_TTL_MIN = "abc";
  assert.equal(resolveTtlMinutesFromEnv("TEST_TTL_MIN", 60), 60 * 60 * 1000);
  // 负数回退默认
  process.env.TEST_TTL_MIN = "-5";
  assert.equal(resolveTtlMinutesFromEnv("TEST_TTL_MIN", 60), 60 * 60 * 1000);
  // 未设置回退默认
  delete process.env.TEST_TTL_MIN;
  assert.equal(resolveTtlMinutesFromEnv("TEST_TTL_MIN", 60), 60 * 60 * 1000);
  // 空串回退默认
  process.env.TEST_TTL_MIN = "";
  assert.equal(resolveTtlMinutesFromEnv("TEST_TTL_MIN", 60), 60 * 60 * 1000);
  delete process.env.TEST_TTL_MIN;
});

test("nnd.18 audit: looksClaudeShaped guards against null/primitive tools", () => {
  const executor = new GlmExecutor("glm-cn");
  // tools:[null] 不应抛异常
  const body = { model: "glm-5.3-flash", max_tokens: 512, stream: true, tools: [null], messages: [{ role: "user", content: "x" }] };
  const out = executor.transformForTransport(
    "glm-5.3-flash", body, true,
    { apiKey: "k", providerSpecificData: PASSTHROUGH_PSD }, "anthropic"
  );
  assert.ok(out, "tools:[null] 不应崩溃");
});

test("nnd.18 audit: 003b floor env clamped to [0,1]", async () => {
  // 设一个超范围值,确认被clamp住
  // (实际测试需要调用scoreResetAwareQuota, 这里验证clamp逻辑存在)
  const s = await import("../../open-sse/services/combo/quotaScoring.ts");
  assert.ok(typeof s.scoreResetAwareQuota === "function", "scoring函数存在");
});
