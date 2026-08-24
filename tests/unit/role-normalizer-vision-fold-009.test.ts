// 009 (2026-08-25): normalizeSystemRole's system→user fold used to rebuild the
// first user message as a plain string, physically deleting image parts — a
// pasted screenshot alongside a system prompt was silently stripped for models
// flagged without system role (glm-4.6v). Guards: (1) the fold preserves every
// non-text part of the first user message; (2) glm-4.6v/4.5v are exempt from
// the fold entirely (native system accepted on the modern Zhipu endpoint);
// (3) legacy string-content behavior is unchanged. Evidence chain in deploy
// docs/060, 2026-08-25 04:45 entry (wire-capture).
import test from "node:test";
import assert from "node:assert/strict";

const { normalizeSystemRole } = await import("../../open-sse/services/roleNormalizer.ts");

test("fold keeps image parts of the first user message (009)", () => {
  const out = normalizeSystemRole(
    [
      { role: "system", content: "你是视觉助手" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          { type: "text", text: "图什么颜色" },
        ],
      },
    ],
    "glm-cn",
    "glm-4.5"
  );
  const first = out.find((m: { role: string }) => m.role === "user");
  assert.ok(Array.isArray(first.content), "content must stay an array");
  const types = first.content.map((p: { type?: string }) => p.type);
  assert.ok(types.includes("text"), "folded text part present");
  assert.ok(types.includes("image_url"), "image part SURVIVES the fold");
  const textPart = first.content.find((p: { type?: string }) => p.type === "text");
  assert.ok(textPart.text.includes("[System Instructions]"), "system text folded in");
  assert.ok(textPart.text.includes("[User Message]"), "user text folded in");
});

test("glm-4.6v / glm-4.5v are exempt from the fold (native system, 009)", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
  ];
  for (const model of ["glm-4.6v", "glm-4.5v", "GLM-4.6V"]) {
    const out = normalizeSystemRole(messages, "glm-cn", model);
    assert.equal(out[0].role, "system", `${model} keeps its system message`);
    assert.equal(out.length, 2, `${model} array untouched`);
  }
});

test("legacy string-content fold is unchanged (regression guard)", () => {
  const out = normalizeSystemRole(
    [
      { role: "system", content: "S" },
      { role: "user", content: "hello" },
    ],
    "glm-cn",
    "glm-4.5"
  );
  const first = out.find((m: { role: string }) => m.role === "user");
  assert.equal(typeof first.content, "string");
  assert.ok(first.content.includes("[System Instructions]\nS\n\n[User Message]\nhello"));
});

test("older glm text models still fold (regression guard)", () => {
  const out = normalizeSystemRole(
    [
      { role: "system", content: "S" },
      { role: "user", content: "hello" },
    ],
    "glm-cn",
    "glm-4.5"
  );
  assert.ok(!out.some((m: { role: string }) => m.role === "system"), "glm-4.5 still folds");
});
