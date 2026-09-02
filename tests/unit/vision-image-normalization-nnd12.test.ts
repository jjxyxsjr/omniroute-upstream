/**
 * 2c (nnd.12) — gateway-side vision image normalization before dispatch.
 *
 * The GLM-V vision pipeline is Qwen2-VL style: 14px patches merged 2×2, RGB
 * conversion, smart_resize under a pixel budget (HF zai-org/GLM-4.6V-Flash
 * preprocessor). Feeding it oversized/exotic-encoded images produced a stream
 * of upstream 400 code 1210 ("image parse error") and occasional hangs.
 * Normalization targets the pipeline's comfort zone: convert to RGB, long
 * edge ≤4096, total pixels ≤4,194,304, re-encode as baseline JPEG/PNG.
 * Default ON (operator-approved 2c decision — this is a format fix, not PII
 * mutation), OMNIROUTE_IMAGE_NORMALIZATION=0 turns it off. Failures are
 * fail-open: a bad image is passed through untouched, never rejected.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  resolveVisionImageNormalization,
  normalizeVisionImageBuffer,
  normalizeVisionImagesInBody,
} = await import("../../open-sse/utils/visionImageNormalization.ts");

const sharp = (await import("sharp").then((m) => m.default ?? m).catch(() => null)) as
  | ((input: Buffer, opts?: unknown) => any)
  | null;

test("2c env switch: default on; 0/false disables; 1/true enables", () => {
  assert.equal(resolveVisionImageNormalization({}), true);
  assert.equal(resolveVisionImageNormalization({ OMNIROUTE_IMAGE_NORMALIZATION: "0" }), false);
  assert.equal(resolveVisionImageNormalization({ OMNIROUTE_IMAGE_NORMALIZATION: "false" }), false);
  assert.equal(resolveVisionImageNormalization({ OMNIROUTE_IMAGE_NORMALIZATION: "1" }), true);
  assert.equal(resolveVisionImageNormalization({ OMNIROUTE_IMAGE_NORMALIZATION: "" }), true);
});

test("2c oversized PNG is resized into the long-edge and pixel budget", async () => {
  if (!sharp) return; // sharp missing on this host — covered in CI/container
  // 6000×800 PNG: long edge 6000 > 4096 AND 4.8M pixels > 4.19M.
  const input = await sharp({
    create: { width: 6000, height: 800, channels: 3, background: "#334455" },
  })
    .png()
    .toBuffer();
  const out = await normalizeVisionImageBuffer(input);
  assert.equal(out.changed, true);
  assert.equal(out.mime, "image/png");
  const meta = await sharp(out.buffer).metadata();
  assert.ok((meta.width ?? 0) <= 4096, `width ${meta.width} within 4096`);
  assert.ok((meta.height ?? 0) <= 4096, `height ${meta.height} within 4096`);
  assert.ok(
    (meta.width ?? 0) * (meta.height ?? 0) <= 4_194_304,
    "pixel budget respected"
  );
});

test("2c alpha-carrying image is flattened to white and re-encoded as baseline JPEG", async () => {
  if (!sharp) return;
  const input = await sharp({
    create: { width: 256, height: 256, channels: 4, background: "#00000080" },
  })
    .png()
    .toBuffer();
  const out = await normalizeVisionImageBuffer(input);
  assert.equal(out.changed, true);
  assert.equal(out.mime, "image/jpeg");
  const meta = await sharp(out.buffer).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.hasAlpha, false, "alpha must be gone (flattened)");
  assert.equal(meta.isProgressive ?? false, false, "baseline (non-progressive) JPEG");
});

test("2c an already-compliant RGB JPEG passes through byte-identical", async () => {
  if (!sharp) return;
  const input = await sharp({
    create: { width: 640, height: 480, channels: 3, background: "#aabbcc" },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const out = await normalizeVisionImageBuffer(input);
  assert.equal(out.changed, false);
  assert.ok(out.buffer.equals(input), "byte-identical passthrough");
});

test("2c body walker rewrites OpenAI image_url and Claude source data URIs, leaves URLs and text alone", async () => {
  if (!sharp) return;
  const png = await sharp({
    create: { width: 5000, height: 600, channels: 3, background: "#112233" },
  })
    .png()
    .toBuffer();
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;

  const body = {
    model: "glm-4.6v",
    messages: [
      { role: "user", content: "look at these" },
      {
        role: "user",
        content: [
          { type: "text", text: "screenshot:" },
          { type: "image_url", image_url: { url: dataUri } },
          { type: "image_url", image_url: { url: "https://example.com/remote.png" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "claude-form:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
        ],
      },
    ],
  };
  const stats = await normalizeVisionImagesInBody(body);
  assert.equal(stats.normalized, 2, "one OpenAI-form + one Claude-form image normalized");
  assert.equal(stats.skipped, 0, "remote URLs are not attempted (not downloaded, not counted)");

  const openaiUrl = (body.messages[1] as any).content.find((p: any) => p.type === "image_url" && p.image_url.url.startsWith("data:")).image_url.url;
  assert.notEqual(openaiUrl, dataUri, "oversized data URI was rewritten");
  assert.match(openaiUrl, /^data:image\/png;base64,/);

  const claudeBlock = (body.messages[2] as any).content.find((p: any) => p.type === "image");
  const rewritten = Buffer.from(claudeBlock.source.data, "base64");
  const meta = await sharp(rewritten).metadata();
  assert.ok((meta.width ?? 0) <= 4096, "Claude-form image also normalized");
});

test("2c garbage data URIs are skipped, never thrown", async () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,not-really-base64!!!" } },
        ],
      },
    ],
  };
  const stats = await normalizeVisionImagesInBody(body);
  assert.equal(stats.normalized, 0);
  assert.equal(stats.skipped, 1);
  assert.equal(
    (body.messages[0] as any).content[0].image_url.url,
    "data:image/png;base64,not-really-base64!!!",
    "garbage passed through untouched (fail-open)"
  );
});
