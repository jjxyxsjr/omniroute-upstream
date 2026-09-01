/**
 * 2e/2f — pre-dispatch media guardrails.
 *
 * GLM-V family APIs reject requests that mix images with video/file blocks in
 * one message list (docs: "不支持同时理解文件、视频和图像"), surfacing as an
 * opaque upstream 400 "图片输入格式/解析错误" (code 1210). The gateway now
 * fails fast with an actionable message instead. Multi-image requests are also
 * capped (community norm ≤10; GLM-V multi-image fragility history zai-org/GLM-V#232).
 */
import test from "node:test";
import assert from "node:assert/strict";

const { checkRequestMediaGuardrails, resolveMaxImagesPerRequest } = await import(
  "../../open-sse/services/combo/comboStructure.ts"
);

function img(i = 0) {
  return { type: "image_url", image_url: { url: `data:image/png;base64,AAA${i}` } };
}
function video() {
  return { type: "video_url", video_url: { url: "https://x/v.mp4" } };
}
function body(parts: unknown[]) {
  return { messages: [{ role: "user", content: parts }] };
}

test("2e mixed image + video in one request fails fast", () => {
  const v = checkRequestMediaGuardrails(body([img(), { type: "text", text: "hi" }, video()]));
  assert.ok(v, "expected a violation");
  assert.equal(v.code, "mixed_media_not_supported");
  assert.ok(
    v.message.toLowerCase().includes("single request") || v.message.includes("不能"),
    v.message
  );
});

test("2f over-limit image count fails fast (default 10)", () => {
  const parts = Array.from({ length: 11 }, (_, i) => img(i));
  const v = checkRequestMediaGuardrails(body(parts));
  assert.ok(v && v.code === "too_many_images");
  assert.ok(v.message.includes("11"));
});

test("2f exactly at the limit passes", () => {
  const parts = Array.from({ length: 10 }, (_, i) => img(i));
  assert.equal(checkRequestMediaGuardrails(body(parts)), null);
});

test("2e video-only and text-only requests pass untouched", () => {
  assert.equal(checkRequestMediaGuardrails(body([video()])), null);
  assert.equal(checkRequestMediaGuardrails(body([{ type: "text", text: "hi" }])), null);
});

test("2f env knob: 0 disables the count cap only — mixed-media stays enforced", () => {
  const parts = Array.from({ length: 50 }, (_, i) => img(i));
  assert.equal(checkRequestMediaGuardrails(body(parts), 0), null);
  const mixed = checkRequestMediaGuardrails(body([img(), video()]), 0);
  assert.ok(mixed && mixed.code === "mixed_media_not_supported");
});

test("2f resolveMaxImagesPerRequest parses env", () => {
  assert.equal(resolveMaxImagesPerRequest({}), 10);
  assert.equal(resolveMaxImagesPerRequest({ OMNIROUTE_MAX_IMAGES_PER_REQUEST: "3" }), 3);
  assert.equal(resolveMaxImagesPerRequest({ OMNIROUTE_MAX_IMAGES_PER_REQUEST: "0" }), 0);
  assert.equal(resolveMaxImagesPerRequest({ OMNIROUTE_MAX_IMAGES_PER_REQUEST: "junk" }), 10);
});
