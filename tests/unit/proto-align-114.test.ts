/**
 * #114 — protocol-aligned door selection (nnd.40).
 *
 * GLM Coding Plan accounts serve both doors; production connections pin the
 * Anthropic door (#37) so the 79% openai-protocol traffic pays a translation.
 * These tests pin the resolver: env gate, unambiguous openai-shape detection
 * (tools[].function wrapper / string system), conservative ambiguity, and the
 * untouched claude/openai defaults.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { isProtocolAlignedRoutingEnabled, isClearlyOpenAIShapedBody, resolveProtocolAlignedTransport } =
  await import("../../open-sse/executors/glmProtocolAlign.ts");

const OPENAI_TOOLS_BODY = {
  model: "glm-5.3",
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
};
const CLAUDE_TOOLS_BODY = {
  model: "glm-5.3",
  system: [{ type: "text", text: "You are a helpful assistant." }],
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "get_weather", input_schema: {} }],
};
const AMBIGUOUS_BODY = { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] };

test("#114 env gate: unset / junk → off; 1/true/on → on", () => {
  assert.equal(isProtocolAlignedRoutingEnabled({}), false);
  assert.equal(isProtocolAlignedRoutingEnabled({ OMNIROUTE_PROTOCOL_ALIGNED_ROUTING: "" }), false);
  assert.equal(isProtocolAlignedRoutingEnabled({ OMNIROUTE_PROTOCOL_ALIGNED_ROUTING: "junk" }), false);
  assert.equal(isProtocolAlignedRoutingEnabled({ OMNIROUTE_PROTOCOL_ALIGNED_ROUTING: "0" }), false);
  assert.equal(isProtocolAlignedRoutingEnabled({ OMNIROUTE_PROTOCOL_ALIGNED_ROUTING: "1" }), true);
  assert.equal(isProtocolAlignedRoutingEnabled({ OMNIROUTE_PROTOCOL_ALIGNED_ROUTING: "true" }), true);
  assert.equal(isProtocolAlignedRoutingEnabled({ OMNIROUTE_PROTOCOL_ALIGNED_ROUTING: " ON " }), true);
});

test("#114 shape detection: tools wrapper and string system are unambiguous openai", () => {
  assert.equal(isClearlyOpenAIShapedBody(OPENAI_TOOLS_BODY), true);
  assert.equal(isClearlyOpenAIShapedBody({ messages: [], system: "plain system" }), true);
  assert.equal(isClearlyOpenAIShapedBody({ messages: [], system: "" }), false, "empty string system is not a signal");
});

test("#114 shape detection: claude shapes and ambiguous bodies stay unpinned", () => {
  assert.equal(isClearlyOpenAIShapedBody(CLAUDE_TOOLS_BODY), false);
  assert.equal(isClearlyOpenAIShapedBody(AMBIGUOUS_BODY), false);
  assert.equal(isClearlyOpenAIShapedBody(null), false);
  assert.equal(isClearlyOpenAIShapedBody("not a record"), false);
});

test("#114 resolver: env off → nothing moves, whatever the body", () => {
  assert.equal(resolveProtocolAlignedTransport(OPENAI_TOOLS_BODY, "anthropic"), "anthropic");
  assert.equal(resolveProtocolAlignedTransport(OPENAI_TOOLS_BODY, "openai"), "openai");
});

test("#114 resolver: env on + claude-pinned + clearly-openai body → openai door (the 79% win)", () => {
  const prev = process.env.OMNIROUTE_PROTOCOL_ALIGNED_ROUTING;
  process.env.OMNIROUTE_PROTOCOL_ALIGNED_ROUTING = "1";
  try {
    assert.equal(resolveProtocolAlignedTransport(OPENAI_TOOLS_BODY, "anthropic"), "openai");
    // Fallback door arithmetic lives in the executor: other(openai)=anthropic — translated door still reachable.
  } finally {
    if (prev === undefined) delete process.env.OMNIROUTE_PROTOCOL_ALIGNED_ROUTING;
    else process.env.OMNIROUTE_PROTOCOL_ALIGNED_ROUTING = prev;
  }
});

test("#114 resolver: claude-shaped and ambiguous bodies keep the pinned anthropic door (zero change for the 20%)", () => {
  const prev = process.env.OMNIROUTE_PROTOCOL_ALIGNED_ROUTING;
  process.env.OMNIROUTE_PROTOCOL_ALIGNED_ROUTING = "1";
  try {
    assert.equal(resolveProtocolAlignedTransport(CLAUDE_TOOLS_BODY, "anthropic"), "anthropic");
    assert.equal(resolveProtocolAlignedTransport(AMBIGUOUS_BODY, "anthropic"), "anthropic");
    assert.equal(resolveProtocolAlignedTransport(null, "anthropic"), "anthropic");
  } finally {
    if (prev === undefined) delete process.env.OMNIROUTE_PROTOCOL_ALIGNED_ROUTING;
    else process.env.OMNIROUTE_PROTOCOL_ALIGNED_ROUTING = prev;
  }
});

test("#114 resolver: openai primary is never re-doorred (v1 scope: only the pinned-door case changes)", () => {
  const prev = process.env.OMNIROUTE_PROTOCOL_ALIGNED_ROUTING;
  process.env.OMNIROUTE_PROTOCOL_ALIGNED_ROUTING = "1";
  try {
    assert.equal(resolveProtocolAlignedTransport(CLAUDE_TOOLS_BODY, "openai"), "openai");
    assert.equal(resolveProtocolAlignedTransport(AMBIGUOUS_BODY, "openai"), "openai");
  } finally {
    if (prev === undefined) delete process.env.OMNIROUTE_PROTOCOL_ALIGNED_ROUTING;
    else process.env.OMNIROUTE_PROTOCOL_ALIGNED_ROUTING = prev;
  }
});
