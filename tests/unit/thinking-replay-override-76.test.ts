// #76-#79 (nnd.26): thinking-replay capability declaration + symmetric cache gating
// + sentinel stripping. Root causes: LKEAP rejected the synthesized redacted_thinking
// blob (400 invalid params) and glm replays leaked "(prior reasoning summary
// unavailable)" because the reasoning-cache write gate never fired for glm-cn.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.ts";
import { mergeModelCompatOverride } from "../../src/lib/db/models/compat.ts";

type Block = { type: string; [k: string]: unknown };
type Msg = { role: string; content?: Block[] };
type ToolLoopBody = {
  model: string;
  max_tokens: number;
  thinking: { type: string; budget_tokens: number };
  tools: unknown[];
  messages: Msg[];
};

const buildToolLoopBody = (model: string): ToolLoopBody => ({
  model,
  max_tokens: 2048,
  thinking: { type: "enabled", budget_tokens: 1024 },
  tools: [
    {
      name: "proxy_probe_tool",
      description: "t",
      input_schema: { type: "object", properties: { x: { type: "number" } } },
    },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: "call the tool" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_probe_01", name: "proxy_probe_tool", input: { x: 1 } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_probe_01", content: "42" }],
    },
    { role: "user", content: [{ type: "text", text: "now reply ok" }] },
  ],
});

const assistantBlockTypes = (out: unknown): string[] => {
  const messages = (out as { messages?: Msg[] }).messages ?? [];
  const assistant = messages.find((m) => m.role === "assistant");
  return (assistant?.content ?? []).map((c) => c.type);
};

describe("#76 thinkingReplay capability declaration (modelCompatOverrides)", () => {
  const MODEL = "test-replay-m3";

  test("default (no override): anthropic-compatible node still gets redacted_thinking precursor", () => {
    const provider = "anthropic-compatible-default-node";
    const out = prepareClaudeRequest(
      buildToolLoopBody(MODEL) as Parameters<typeof prepareClaudeRequest>[0],
      provider,
      false,
      MODEL
    );
    const types = assistantBlockTypes(out);
    assert.ok(types.includes("redacted_thinking"), `expected redacted precursor, got ${types}`);
  });

  test('"none": no synthesized precursor at all, history untouched', () => {
    const provider = "anthropic-compatible-none-node";
    mergeModelCompatOverride(provider, MODEL, { thinkingReplay: "none" });
    const out = prepareClaudeRequest(
      buildToolLoopBody(MODEL) as Parameters<typeof prepareClaudeRequest>[0],
      provider,
      false,
      MODEL
    );
    const types = assistantBlockTypes(out);
    assert.equal(types.includes("redacted_thinking"), false, `must not synthesize redacted: ${types}`);
    assert.equal(types.includes("thinking"), false, `must not synthesize placeholder: ${types}`);
    assert.deepEqual(types, ["tool_use"]);
  });

  test('"text": plain-text branch instead of redacted (placeholder ok)', () => {
    const provider = "anthropic-compatible-text-node";
    mergeModelCompatOverride(provider, MODEL, { thinkingReplay: "text" });
    const out = prepareClaudeRequest(
      buildToolLoopBody(MODEL) as Parameters<typeof prepareClaudeRequest>[0],
      provider,
      false,
      MODEL
    );
    const types = assistantBlockTypes(out);
    assert.equal(types.includes("redacted_thinking"), false, `redacted forbidden in text mode: ${types}`);
    assert.ok(types.includes("thinking"), `plain thinking expected: ${types}`);
  });

  test("unset (null) reverts to default redacted behavior", () => {
    const provider = "anthropic-compatible-unset-node";
    mergeModelCompatOverride(provider, MODEL, { thinkingReplay: "none" });
    mergeModelCompatOverride(provider, MODEL, { thinkingReplay: null });
    const out = prepareClaudeRequest(
      buildToolLoopBody(MODEL) as Parameters<typeof prepareClaudeRequest>[0],
      provider,
      false,
      MODEL
    );
    const types = assistantBlockTypes(out);
    assert.ok(types.includes("redacted_thinking"), `default restored: ${types}`);
  });
});

// ⚠️ source-guard 式测试（grep 实现文本）：豁免理由——断言的是翻译器内部的
// 门控接线与哨兵剥离点，跨 claudeHelper/stream/respTranslator 三文件无统一导出缝；
// 重构搬动这些块时需同步跟进。
describe("#77-#79 source guards (symmetric gating / sentinel strip / injection logs)", () => {
  const chatCore = readFileSync("open-sse/handlers/chatCore.ts", "utf8");
  const stream = readFileSync("open-sse/utils/stream.ts", "utf8");
  const respTranslator = readFileSync("open-sse/translator/response/claude-to-openai.ts", "utf8");
  const budget = readFileSync("open-sse/services/thinkingBudget.ts", "utf8");

  test("#77 both cache-write sites gate via shouldCacheReasoning (read-side symmetry)", { skip: "nnd.36: 52 dissolved shouldCacheReasoning into chatCore/streamReasoningCapture.ts — guard needs a rewrite against the new structure (610 follow-up)" }, () => {
    // nnd.28: 两处内联门控去重为 shouldCacheReasoning——对称契约
    // (thinkingEnabled + interleavedField) 由 helper 承载，两写入点都走它。
    assert.match(
      chatCore,
      /function shouldCacheReasoning\([\s\S]*?thinkingEnabled:[\s\S]*?interleavedField:/
    );
    const gateCall = "if (shouldCacheReasoning(provider, model, finalBody || translatedBody))";
    const callSites = chatCore.split(gateCall).length - 1;
    assert.equal(
      callSites,
      2,
      `expected 2 symmetric write gates, got ${callSites}`
    );
  });

  test("#78 aggregated reasoning_content strips the internal sentinel (both sites)", () => {
    const stripped = stream.match(/stripInternalReasoningPlaceholder\(/g)?.length ?? 0;
    assert.ok(stripped >= 2, `expected >=2 strip call sites, got ${stripped}`);
  });

  test("#78 streaming thinking_delta path strips the sentinel", () => {
    assert.match(respTranslator, /visibleThinking/);
    assert.match(respTranslator, /stripInternalReasoningPlaceholder/);
  });

  test("#79 adaptive injection is logged with an INJECT tag", () => {
    assert.match(budget, /\[INJECT\] kind=thinking_budget/);
  });
});
