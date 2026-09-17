/**
 * Think Tag Parser
 *
 * Parses <think>...</think> tags from LLM output and converts them
 * to a structured `reasoning_content` field.
 *
 * Used by providers like DeepSeek, Qwen, and Qoder that embed
 * chain-of-thought reasoning inside <think> tags.
 *
 * Usage:
 *   import { extractThinkTags, hasThinkTags } from "./thinkTagParser.ts";
 *
 *   const { reasoning, content } = extractThinkTags(rawOutput);
 *   // reasoning = "step-by-step thinking..."
 *   // content = "final answer..."
 */

import { REASONING_TAG_NAMES, shouldParseTextualReasoningTags } from "../handlers/responseSanitizer/reasoning.ts";
import { appendBoundedText, buildSyntheticChatChunk } from "./streamHelpers.ts";

// Open tags are derived from the shared tag-name list so the streaming parser
// and the aggregate extractor can never drift apart (MiniMax M3's Chinese tags
// 思考/反思/推理/推敲 included — hermes-agent#43827).
const THINK_OPEN_TAGS: readonly string[] = REASONING_TAG_NAMES.map((name) => `<${name}>`);

function closeTagFor(name: string): string {
  return `</${name}>`;
}

// Legacy single-tag forms, kept verbatim for the deprecated extractThinkTags /
// hasThinkTags convenience exports (no internal callers) — the multi-tag
// machinery below does not use them.
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * Every proper prefix of every open tag ("<", "<t", ... "<think", "<思", ...),
 * derived from the open tags themselves so the list cannot drift out of sync.
 */
const THINK_OPEN_PARTIALS: readonly string[] = (() => {
  const seen = new Set<string>();
  for (const tag of THINK_OPEN_TAGS) {
    for (let i = 1; i < tag.length; i++) seen.add(tag.slice(0, i));
  }
  return [...seen];
})();

/**
 * Create the mutable streaming-parse context for one SSE stream.
 * `enabled` decides whether the caller should attempt think-tag parsing at
 * all for this stream (passthrough mode + a provider/model that is known to
 * emit textual `<think>` tags); `active`/`insideThink`/`buffer` track parse
 * progress once a tag has been seen. `model` is stashed for `flushThink`'s
 * synthetic chunk so callers don't need to pass it again at flush time.
 *
 * @param {boolean} isPassthroughMode
 * @param {unknown} provider
 * @param {string} [model]
 */
export function initThinkState(isPassthroughMode: boolean, provider?: unknown, model?: string) {
  return {
    enabled: isPassthroughMode && shouldParseTextualReasoningTags(provider, model),
    insideThink: false,
    // Name of the currently open tag, so the closing tag pairs with the same
    // name (multi-tag support: <think> … <思考> …).
    currentTag: null as string | null,
    buffer: "",
    active: false,
    model,
  };
}

/**
 * Find the earliest open tag in `buffer`. Returns the tag's name and the
 * index of its "<", or null when no open tag is present.
 */
function findEarliestOpenTag(buffer: string): { name: string; index: number } | null {
  let best: { name: string; index: number } | null = null;
  for (let i = 0; i < REASONING_TAG_NAMES.length; i++) {
    const idx = buffer.indexOf(THINK_OPEN_TAGS[i]);
    if (idx !== -1 && (best === null || idx < best.index)) {
      best = { name: REASONING_TAG_NAMES[i], index: idx };
    }
  }
  return best;
}

/**
 * Longest suffix of `buffer` that is a proper prefix of some open tag — the
 * part that must stay buffered because a tag may be split across chunks.
 * Returns "" when the tail cannot grow into an open tag.
 */
function trailingOpenTagPartial(buffer: string): string {
  for (const partial of THINK_OPEN_PARTIALS) {
    if (partial.length > 0 && buffer.endsWith(partial)) return partial;
  }
  return "";
}

/**
 * Check whether a streaming text chunk contains a full open tag,
 * or ends with a prefix of one (so the caller knows to keep buffering
 * instead of treating the tag as ordinary content split across chunks).
 *
 * @param {string} value - Streaming text chunk
 * @returns {boolean}
 */
export function containsOrMayEndWithThinkOpenTag(value: string): boolean {
  return THINK_OPEN_TAGS.some((tag) => value.includes(tag)) || trailingOpenTagPartial(value) !== "";
}

/**
 * Check if text contains think tags
 * @param {string} text - Raw output text
 * @returns {boolean}
 */
export function hasThinkTags(text) {
  if (!text) return false;
  return text.includes(THINK_OPEN);
}

/**
 * Extract think tags from text
 * Returns the reasoning content (inside <think>) and the cleaned final content
 *
 * @param {string} text - Raw output text
 * @returns {{ reasoning: string|null, content: string }}
 */
export function extractThinkTags(text) {
  if (!text || !text.includes(THINK_OPEN)) {
    return { reasoning: null, content: text || "" };
  }

  let reasoning = "";
  let content = text;
  let iterations = 0;
  const maxIterations = 10; // safety limit

  while (content.includes(THINK_OPEN) && iterations < maxIterations) {
    const openIdx = content.indexOf(THINK_OPEN);
    const closeIdx = content.indexOf(THINK_CLOSE, openIdx);

    if (closeIdx === -1) {
      // Unclosed think tag — treat everything after <think> as reasoning
      reasoning += content.slice(openIdx + THINK_OPEN.length);
      content = content.slice(0, openIdx);
      break;
    }

    // Extract the think content
    const thinkContent = content.slice(openIdx + THINK_OPEN.length, closeIdx);
    reasoning += (reasoning ? "\n" : "") + thinkContent;

    // Remove the think block from content
    content = content.slice(0, openIdx) + content.slice(closeIdx + THINK_CLOSE.length);
    iterations++;
  }

  return {
    reasoning: reasoning.trim() || null,
    content: content.trim(),
  };
}

/**
 * Process a streaming delta chunk and extract think content.
 * Maintains state across chunks using a context object.
 *
 * @param {string} delta - New text chunk
 * @param {object} ctx - Mutable context object { insideThink, buffer }
 * @returns {{ reasoningDelta: string|null, contentDelta: string|null }}
 */
export function processStreamingThinkDelta(delta, ctx) {
  if (!ctx.buffer) ctx.buffer = "";

  ctx.buffer += delta;
  let reasoningDelta = "";
  let contentDelta = "";

  while (ctx.buffer.length > 0) {
    if (ctx.insideThink) {
      // Looking for the closing tag that pairs with the open one
      const closeTag = closeTagFor(ctx.currentTag || "think");
      const closeIdx = ctx.buffer.indexOf(closeTag);
      if (closeIdx === -1) {
        // Might be a partial tag at the end — keep last few chars
        if (ctx.buffer.length > closeTag.length) {
          const safe = ctx.buffer.slice(0, -(closeTag.length - 1));
          reasoningDelta += safe;
          ctx.buffer = ctx.buffer.slice(-(closeTag.length - 1));
        }
        break;
      }
      reasoningDelta += ctx.buffer.slice(0, closeIdx);
      ctx.buffer = ctx.buffer.slice(closeIdx + closeTag.length);
      ctx.insideThink = false;
      ctx.currentTag = null;
    } else {
      // Looking for the earliest opening tag
      const open = findEarliestOpenTag(ctx.buffer);
      if (open === null) {
        // Might be a partial tag at the end — keep only the partial prefix
        const partial = trailingOpenTagPartial(ctx.buffer);
        if (partial) {
          contentDelta += ctx.buffer.slice(0, ctx.buffer.length - partial.length);
          ctx.buffer = partial;
        } else {
          contentDelta += ctx.buffer;
          ctx.buffer = "";
        }
        break;
      }
      contentDelta += ctx.buffer.slice(0, open.index);
      ctx.buffer = ctx.buffer.slice(open.index + THINK_OPEN_TAGS[REASONING_TAG_NAMES.indexOf(open.name)].length);
      ctx.insideThink = true;
      ctx.currentTag = open.name;
    }
  }

  return {
    reasoningDelta: reasoningDelta || null,
    contentDelta: contentDelta || null,
  };
}

/**
 * Parse a streaming SSE delta's `content` field for `<think>` tags in place,
 * when applicable. No-ops (returns false, delta untouched) unless parsing is
 * `ctx.enabled` for this stream AND either a tag is already open or this
 * chunk contains/may end with a `<think>` open tag.
 *
 * Mutates `delta.content` (stripped of think markup) and sets
 * `delta.reasoning_content` when reasoning text was extracted.
 *
 * @param {object} ctx - Mutable context object from `initThinkState`
 * @param {{ content: unknown, reasoning_content?: string }} delta
 * @returns {boolean} true if the delta was parsed for think tags
 */
export function applyThinkTag(
  ctx,
  delta: { content: unknown; reasoning_content?: string }
): boolean {
  if (!ctx.enabled || typeof delta?.content !== "string") return false;
  if (!ctx.active && !containsOrMayEndWithThinkOpenTag(delta.content)) return false;

  ctx.active = true;
  const { reasoningDelta, contentDelta } = processStreamingThinkDelta(delta.content, ctx);
  delta.content = contentDelta || "";
  if (reasoningDelta) delta.reasoning_content = reasoningDelta;
  return true;
}

/**
 * Flush remaining buffer content from streaming context.
 * Call this when the stream ends.
 *
 * @param {object} ctx - Mutable context object { insideThink, buffer }
 * @returns {{ reasoningDelta: string|null, contentDelta: string|null }}
 */
export function flushThinkBuffer(ctx) {
  if (!ctx.buffer) return { reasoningDelta: null, contentDelta: null };

  const remaining = ctx.buffer;
  ctx.buffer = "";

  if (ctx.insideThink) {
    return { reasoningDelta: remaining || null, contentDelta: null };
  }
  return { reasoningDelta: null, contentDelta: remaining || null };
}

/**
 * Flush remaining buffer content from a streaming context at end-of-stream
 * and assemble a synthetic OpenAI-shaped chat completion chunk, plus the
 * accumulator updates for it, ready for the caller to enqueue as SSE output.
 *
 * Returns `null` when parsing was never `ctx.enabled`/`ctx.active` for this
 * stream, or when there is nothing left to flush — callers can skip
 * emitting an empty synthetic chunk and leave their accumulators untouched.
 *
 * @param {object} ctx - Mutable context object from `initThinkState`
 *   (its `model` is reused for the synthetic chunk)
 * @param {string} [responsesId] - Response id to reuse, falls back to a
 *   generated `chatcmpl-<timestamp>` id
 * @param {string} accReasoning - Caller's running reasoning accumulator
 * @param {string} accContent - Caller's running content accumulator
 * @returns {{
 *   syntheticChunk: Record<string, unknown>,
 *   flushOutput: string,
 *   reasoning: string,
 *   content: string,
 *   addedLength: number
 * }|null}
 */
export function flushThink(
  ctx,
  responsesId: string | undefined,
  accReasoning: string,
  accContent: string
): {
  syntheticChunk: Record<string, unknown>;
  flushOutput: string;
  reasoning: string;
  content: string;
  addedLength: number;
} | null {
  if (!ctx.enabled || !ctx.active) return null;

  const { reasoningDelta, contentDelta } = flushThinkBuffer(ctx);
  if (!reasoningDelta && !contentDelta) return null;

  const delta: Record<string, string> = {};
  if (reasoningDelta) delta.reasoning_content = reasoningDelta;
  if (contentDelta) delta.content = contentDelta;

  const syntheticChunk = buildSyntheticChatChunk(responsesId, ctx.model, delta);

  return {
    syntheticChunk,
    flushOutput: `data: ${JSON.stringify(syntheticChunk)}\n\n`,
    reasoning: appendBoundedText(accReasoning, reasoningDelta || ""),
    content: appendBoundedText(accContent, contentDelta || ""),
    addedLength: (reasoningDelta?.length || 0) + (contentDelta?.length || 0),
  };
}
