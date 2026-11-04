import test from "node:test";
import assert from "node:assert/strict";
const { isImageOverload400, stripOldestImages } = await import("../../open-sse/services/combo/imageOverloadRetry.ts");

test("detects image overload 400", () => {
  assert.equal(isImageOverload400(400, "This request carries 11 images, exceeding the per-request limit of 10"), true);
  assert.equal(isImageOverload400(400, "some other error"), false);
  assert.equal(isImageOverload400(500, "carries 11 images"), false);
});

test("strips oldest images, keeps recent 3 messages intact", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,old1" } }] },
      { role: "assistant", content: "reply1" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,old2" } }] },
      { role: "assistant", content: "reply2" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,recent" } }, { type: "text", text: "look at this" }] },
    ],
  };
  const r = stripOldestImages(body, 3);
  assert.equal(r.stripped, true);
  assert.equal(r.strippedCount, 1, "stripped 1 old image (idx 0; idx 2 is within keep-recent-3)");
  const msgs = (r.body as { messages: Array<{ role: string; content: unknown }> }).messages;
  // Recent image (last user message) should survive
  const lastContent = msgs[4].content as Array<{ type: string }>;
  assert.ok(lastContent.some(p => p.type === "image_url"), "recent image kept");
  // Old images replaced with placeholder
  const firstContent = msgs[0].content as Array<{ type: string; text?: string }>;
  assert.ok(firstContent.some(p => p.type === "text" && p.text?.includes("removed")), "old image replaced");
});

test("no images to strip → returns unchanged", () => {
  const body = { messages: [{ role: "user", content: "just text" }] };
  const r = stripOldestImages(body, 3);
  assert.equal(r.stripped, false);
  assert.equal(r.body, body);
});
