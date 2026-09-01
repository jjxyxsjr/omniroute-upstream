/**
 * 2b — data-URL strings inside logged request bodies must not be half-sliced.
 *
 * cloneBoundedChatLogPayload caps string length via truncateChatLogText
 * (head+marker+tail). For base64 image payloads that produces an irreparably
 * corrupt string (no IEND, libpng rejects, mod-4 length) — a "残图" that can
 * never be replayed for forensics. Vision request artifacts on 2026-09-01
 * were all truncated this way. Oversized data URLs now collapse to compact
 * metadata (mime, byte length, sha256, head prefix) instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const { cloneBoundedChatLogPayload } = await import("../../open-sse/handlers/chatCore/logTruncation.ts");

function fakePngB64(bytes: number): string {
  // Real PNG magic + padding so the data URL looks authentic to the detector.
  const buf = Buffer.alloc(Math.max(bytes, 8));
  Buffer.from("89504e470d0a1a0a", "hex").copy(buf);
  return buf.toString("base64");
}

function dataUrl(b64: string, mime = "image/png"): string {
  return `data:${mime};base64,${b64}`;
}

test("2b oversized data URL collapses to image metadata, not a sliced string", () => {
  const b64 = fakePngB64(60 * 1024); // ~80KB base64, over the 64K text cap
  const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl(b64) } }] }] };
  const out = cloneBoundedChatLogPayload(body) as typeof body & { messages: unknown };
  const block = (out.messages as { content: Record<string, unknown>[] }[])[0].content[0];
  const ref = block.image_url?.url as unknown;
  assert.equal(typeof ref, "object", "oversized data URL must become a metadata object");
  const meta = ref as Record<string, unknown>;
  assert.equal(meta._omniroute_image_ref, true);
  assert.equal(meta.mime, "image/png");
  assert.equal(meta.base64Bytes, b64.length);
  const expectedHash = createHash("sha256").update(b64).digest("hex").slice(0, 16);
  assert.equal(meta.sha256, expectedHash);
  assert.ok(String(meta.head).startsWith("data:image/png;base64,iVBORw0KGgo"));
});

test("2b small data URLs are kept verbatim", () => {
  const url = dataUrl(fakePngB64(64));
  const out = cloneBoundedChatLogPayload({ url }) as { url: string };
  assert.equal(out.url, url);
});

test("2b plain long text still uses head/tail truncation", () => {
  const long = "x".repeat(200_000);
  const out = cloneBoundedChatLogPayload({ t: long }) as { t: string };
  assert.ok(typeof out.t === "string", "plain text stays a string");
  assert.ok(out.t.includes("truncated"), "truncation marker present");
});

test("2b webp/jpeg mimes are recognized too", () => {
  for (const mime of ["image/webp", "image/jpeg"]) {
    const b64 = fakePngB64(70 * 1024);
    const out = cloneBoundedChatLogPayload({ u: dataUrl(b64, mime) }) as { u: Record<string, unknown> };
    assert.equal(out.u._omniroute_image_ref, true, mime);
    assert.equal(out.u.mime, mime);
  }
});
