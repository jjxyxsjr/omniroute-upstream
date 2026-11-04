/**
 * imageOverloadRetry.ts — total纲小件: strip oldest history images on 400 overload.
 *
 * Production evidence (2026-11-04): user 陶刚's agent accumulated 11 images
 * across 11 turns (1 per turn). Each turn re-sends the FULL history, so the
 * upstream sees all 11 images and 400s with "carries 11 images, exceeding
 * the per-request limit". The user didn't send 11 images at once — they
 * accumulated one per turn over a session.
 *
 * Fix: when upstream returns this specific 400, strip the OLDEST images from
 * the message history (keep the most recent ones) and retry. The stripped
 * images are replaced with a text placeholder so the conversation still
 * makes sense.
 *
 * nnd.40. Evidence: 总纲 #216 小件.
 */

const IMAGE_OVERLOAD_RE = /carries (\d+) images?[,]? exceeding the per-request limit/i;

export interface ImageStripResult {
  stripped: boolean;
  strippedCount: number;
  body: unknown;
}

export function isImageOverload400(status: number, errorText: string): boolean {
  return status === 400 && IMAGE_OVERLOAD_RE.test(errorText);
}

/**
 * Strip the oldest images from message history, replacing them with text
 * placeholders. Keeps the most recent images (they're most likely referenced
 * by the current turn).
 */
export function stripOldestImages(
  body: Record<string, unknown>,
  keepCount: number = 3
): ImageStripResult {
  const messages = body.messages;
  if (!Array.isArray(messages)) return { stripped: false, strippedCount: 0, body };

  let stripped = 0;
  // Walk from the OLDEST message, stripping images until we're under the limit
  const patched = messages.map((msg, idx) => {
    if (idx >= messages.length - keepCount) return msg; // keep recent messages intact
    const content = (msg as Record<string, unknown>)?.content;
    if (!Array.isArray(content)) return msg;

    const patchedContent = content.map((part) => {
      const p = part as Record<string, unknown>;
      if (
        p?.type === "image_url" || p?.type === "image" || p?.type === "input_image"
      ) {
        stripped++;
        return { type: "text", text: "[image removed to fit request limit]" };
      }
      return part;
    });

    return { ...(msg as Record<string, unknown>), content: patchedContent };
  });

  if (stripped === 0) return { stripped: false, strippedCount: 0, body };
  return { stripped: true, strippedCount: stripped, body: { ...body, messages: patched } };
}
