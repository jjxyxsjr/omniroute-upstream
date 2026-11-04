import test from "node:test";
import assert from "node:assert/strict";
const { classifyTransient5xx } = await import("../../open-sse/services/combo/transient5xxInternalizer.ts");

test("GLM [1234] network error → retry", () => {
  const c = classifyTransient5xx(500, "[500]: [1234][网络错误，错误id 20261104135612e7a4ea973ef14b21]");
  assert.equal(c.shouldRetry, true);
});

test("generic 502 bad gateway → retry", () => {
  assert.equal(classifyTransient5xx(502, "Bad Gateway").shouldRetry, true);
});

test("context overflow → never retry (request-scoped)", () => {
  assert.equal(classifyTransient5xx(400, "This model's maximum context length is 200000 tokens").shouldRetry, false);
});

test("STREAM_READINESS_TIMEOUT → never retry (deadline already handled by combo)", () => {
  assert.equal(classifyTransient5xx(504, "Stream produced no non-ping SSE event — STREAM_READINESS_TIMEOUT").shouldRetry, false);
});

test("unknown 5xx → retry (conservative default)", () => {
  assert.equal(classifyTransient5xx(500, "some weird error").shouldRetry, true);
});
