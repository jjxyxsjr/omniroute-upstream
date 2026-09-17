/**
 * #87: Chinese reasoning tags (思考/反思/推理/推敲) must flow through the same
 * extraction machinery as the English <think> family — both the aggregate
 * extractor (extractThinkingFromContent) and the streaming state machine
 * (processStreamingThinkDelta). Also pins the `\b` → `(?![-\w])` regex fix:
 * an ASCII word boundary never fires after a CJK tag name, so without the fix
 * <思考>…</思考> is invisible to THINK_TAG_REGEX.
 *
 * Upstream context: MiniMax M3 emits these Chinese tags
 * (NousResearch/hermes-agent#43827); the ASCII-only \b gap was verified live
 * before writing this suite.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  REASONING_TAG_FRAGMENT_REGEX,
  THINK_TAG_REGEX,
  cleanReasoningFragment,
  extractThinkingFromContent,
} from "../../open-sse/handlers/responseSanitizer/reasoning.ts";
import {
  containsOrMayEndWithThinkOpenTag,
  flushThinkBuffer,
  initThinkState,
  processStreamingThinkDelta,
} from "../../open-sse/utils/thinkTagParser.ts";

describe("reasoning tags — Chinese names, aggregate extractor", () => {
  it("extracts a complete <思考> block and keeps the answer as content", () => {
    const { content, thinking } = extractThinkingFromContent("<思考>先分析一下</思考>最终答案");
    assert.equal(thinking, "先分析一下");
    assert.equal(content, "最终答案");
  });

  it("extracts a complete <推理> block", () => {
    const { content, thinking } = extractThinkingFromContent("<推理>step by step</推理>answer");
    assert.equal(thinking, "step by step");
    assert.equal(content, "answer");
  });

  it("treats an unclosed Chinese tag tail as reasoning", () => {
    const { content, thinking } = extractThinkingFromContent("正文<反思>未闭合的思考尾巴");
    assert.equal(thinking, "未闭合的思考尾巴");
    assert.equal(content, "正文");
  });

  it("strips leftover Chinese tag fragments", () => {
    assert.equal(cleanReasoningFragment("<推理>残留标签"), "残留标签");
    assert.equal(cleanReasoningFragment("</推敲>残留"), "残留");
  });

  it("THINK_TAG_REGEX matches Chinese tags (the \\b form did not)", () => {
    assert.ok(THINK_TAG_REGEX.test("<推敲>x</推敲>"));
    THINK_TAG_REGEX.lastIndex = 0;
    assert.ok(THINK_TAG_REGEX.test("<反思>y</反思>"));
  });

  it("keeps the English anti-prefix defense: <thinkx> and <think-> stay unmatched", () => {
    const tagOnly = REASONING_TAG_FRAGMENT_REGEX;
    tagOnly.lastIndex = 0;
    assert.ok(!tagOnly.test("<thinkx>"));
    tagOnly.lastIndex = 0;
    assert.ok(!tagOnly.test("<think->"));
  });

  it("English extraction behavior is unchanged", () => {
    const { content, thinking } = extractThinkingFromContent("<think>reasoning</think>answer");
    assert.equal(thinking, "reasoning");
    assert.equal(content, "answer");
  });
});

describe("reasoning tags — Chinese names, streaming state machine", () => {
  it("splits a Chinese-tagged stream split across chunks", () => {
    const ctx = initThinkState(true);
    let reasoning = "";
    let content = "";
    for (const chunk of ["<思", "考>推理过", "程</思", "考>最终答案"]) {
      const r = processStreamingThinkDelta(chunk, ctx);
      if (r.reasoningDelta) reasoning += r.reasoningDelta;
      if (r.contentDelta) content += r.contentDelta;
    }
    const flushed = flushThinkBuffer(ctx);
    if (flushed.reasoningDelta) reasoning += flushed.reasoningDelta;
    if (flushed.contentDelta) content += flushed.contentDelta;
    assert.equal(reasoning, "推理过程");
    assert.equal(content, "最终答案");
    assert.equal(ctx.insideThink, false);
  });

  it("keeps English streaming behavior unchanged across chunk splits", () => {
    const ctx = initThinkState(true);
    let reasoning = "";
    let content = "";
    for (const chunk of ["pre<thi", "nk>reasoni", "ng</thi", "nk>post"]) {
      const r = processStreamingThinkDelta(chunk, ctx);
      if (r.reasoningDelta) reasoning += r.reasoningDelta;
      if (r.contentDelta) content += r.contentDelta;
    }
    const flushed = flushThinkBuffer(ctx);
    if (flushed.reasoningDelta) reasoning += flushed.reasoningDelta;
    if (flushed.contentDelta) content += flushed.contentDelta;
    assert.equal(reasoning, "reasoning");
    assert.equal(content, "prepost");
  });

  it("routes an unclosed Chinese tag fully to reasoning (delta + flush)", () => {
    const ctx = initThinkState(true);
    const r = processStreamingThinkDelta("<思考>只思考没说完", ctx);
    assert.equal(r.contentDelta, null);
    const flushed = flushThinkBuffer(ctx);
    const reasoning = (r.reasoningDelta ?? "") + (flushed.reasoningDelta ?? "");
    assert.equal(reasoning, "只思考没说完");
  });

  it("detects a chunk that may end with a split Chinese open tag", () => {
    assert.ok(containsOrMayEndWithThinkOpenTag("答案<思"));
    assert.ok(containsOrMayEndWithThinkOpenTag("包含<思考>完整"));
    assert.ok(!containsOrMayEndWithThinkOpenTag("普通正文结尾"));
  });
});
