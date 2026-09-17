import test from "node:test";
import assert from "node:assert/strict";

const {
  hasThinkTags,
  extractThinkTags,
  processStreamingThinkDelta,
  flushThinkBuffer,
  containsOrMayEndWithThinkOpenTag,
  applyThinkTag,
} = await import("../../open-sse/utils/thinkTagParser.ts");

test("hasThinkTags detects opening tags and ignores empty input", () => {
  assert.equal(hasThinkTags("before <think>plan</think> after"), true);
  assert.equal(hasThinkTags("plain answer"), false);
  assert.equal(hasThinkTags(""), false);
});

test("extractThinkTags returns reasoning and cleaned content", () => {
  const result = extractThinkTags("Hello <think>step 1</think> world");

  assert.deepEqual(result, {
    reasoning: "step 1",
    content: "Hello  world",
  });
});

test("extractThinkTags concatenates multiple think blocks and handles unclosed tags", () => {
  assert.deepEqual(extractThinkTags("A <think>first</think> B <think>second</think> C"), {
    reasoning: "first\nsecond",
    content: "A  B  C",
  });

  assert.deepEqual(extractThinkTags("prefix <think>unfinished reasoning"), {
    reasoning: "unfinished reasoning",
    content: "prefix",
  });
});

test("processStreamingThinkDelta extracts content and reasoning across split tags", () => {
  const ctx = { insideThink: false, buffer: "" };

  const first = processStreamingThinkDelta("Hello <thi", ctx);
  const second = processStreamingThinkDelta("nk>plan</th", ctx);
  const third = processStreamingThinkDelta("ink> world", ctx);

  // #87 multi-tag buffering: only a tail that can still grow into an open tag
  // stays buffered, so "Hello " flushes immediately (the old form held back a
  // fixed 6-char tail). The reasoning/content totals are unchanged.
  assert.deepEqual(first, {
    reasoningDelta: null,
    contentDelta: "Hello ",
  });
  assert.deepEqual(second, {
    reasoningDelta: null,
    contentDelta: null,
  });
  assert.deepEqual(third, {
    reasoningDelta: "plan",
    contentDelta: " world",
  });
  assert.equal(ctx.insideThink, false);
  assert.equal(ctx.buffer, "");

  const flushed = flushThinkBuffer(ctx);
  assert.deepEqual(flushed, {
    reasoningDelta: null,
    contentDelta: null,
  });
});

test("containsOrMayEndWithThinkOpenTag flags a chunk ending on any partial open tag", () => {
  for (const partial of ["<", "<t", "<th", "<thi", "<thin", "<think"]) {
    assert.equal(containsOrMayEndWithThinkOpenTag(`answer ${partial}`), true, partial);
  }
  assert.equal(containsOrMayEndWithThinkOpenTag("plain answer"), false);
});

test("applyThinkTag buffers an open tag split as '<think' + '>' across deltas", () => {
  const ctx = { enabled: true, active: false, insideThink: false, buffer: "" };

  const opening: { content: unknown; reasoning_content?: string } = { content: "<think" };
  assert.equal(applyThinkTag(ctx, opening), true);
  assert.equal(opening.content, "");

  const rest: { content: unknown; reasoning_content?: string } = {
    content: ">plan</think>answer",
  };
  assert.equal(applyThinkTag(ctx, rest), true);
  assert.equal(rest.reasoning_content, "plan");
  // #87: "answer" cannot grow into a tag, so it flushes in this delta instead
  // of waiting for end-of-stream.
  assert.equal(rest.content, "answer");

  assert.deepEqual(flushThinkBuffer(ctx), {
    reasoningDelta: null,
    contentDelta: null,
  });
});

test("processStreamingThinkDelta keeps partial closing tags buffered while inside think", () => {
  const ctx = { insideThink: true, buffer: "" };

  const result = processStreamingThinkDelta("reasoning</th", ctx);
  assert.deepEqual(result, {
    reasoningDelta: "reason",
    contentDelta: null,
  });
  assert.equal(ctx.buffer, "ing</th");
});

test("flushThinkBuffer returns remaining content or reasoning based on parser state", () => {
  const contentCtx = { insideThink: false, buffer: "tail" };
  const reasoningCtx = { insideThink: true, buffer: "tail-thought" };

  assert.deepEqual(flushThinkBuffer(contentCtx), {
    reasoningDelta: null,
    contentDelta: "tail",
  });
  assert.deepEqual(flushThinkBuffer(reasoningCtx), {
    reasoningDelta: "tail-thought",
    contentDelta: null,
  });
  assert.deepEqual(flushThinkBuffer({ insideThink: false, buffer: "" }), {
    reasoningDelta: null,
    contentDelta: null,
  });
});
