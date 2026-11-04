/**
 * glmProtocolAlign.ts — #114 protocol-aligned door selection (nnd.40).
 *
 * GLM Coding Plan accounts natively serve both an Anthropic door
 * (/api/anthropic) and an OpenAI coding door (/api/coding/paas/v4). Our
 * production connections pin targetFormat=claude (the #37 passthrough), so
 * EVERY request rides the Anthropic door — which means the ~79% of traffic
 * whose clients speak the OpenAI protocol pays an openai→claude translation
 * before leaving the gateway (2026-11-04 protocol census: openai 79% /
 * claude 20% / responses 1%), plus the Anthropic door's shape-sensitive
 * prompt caching (fork forensics: synthetic openai bodies never cache there
 * while the coding door cached a 35k prefix 100%).
 *
 * With OMNIROUTE_PROTOCOL_ALIGNED_ROUTING enabled, a CLEARLY openai-shaped
 * body on a claude-pinned connection goes out through the OpenAI coding door
 * untranslated; the executor's existing dual-door failover still retries the
 * opposite door on retryable failures, so pool liquidity is preserved.
 * Claude-shaped and ambiguous bodies keep the current Anthropic passthrough
 * untouched — zero behavior change for the 20% claude-protocol users.
 *
 * Detection is deliberately conservative — only bodies that are UNAMBIGUOUSLY
 * openai-shaped (tools[].function wrapper, or a string system field) are
 * re-doorred; anything ambiguous stays on the pinned door.
 */

import type { GlmTransport } from "../config/glmProvider.ts";

const PROTOCOL_ALIGNED_ROUTING_ENV = "OMNIROUTE_PROTOCOL_ALIGNED_ROUTING";

export function isProtocolAlignedRoutingEnabled(
  env: { [k: string]: string | undefined } = process.env
): boolean {
  const v = env[PROTOCOL_ALIGNED_ROUTING_ENV];
  if (typeof v !== "string") return false;
  const n = v.trim().toLowerCase();
  return n === "1" || n === "true" || n === "on";
}

/**
 * True only for bodies that are unambiguously OpenAI-chat-shaped:
 *   - tools[0] carries the `.function` wrapper (Claude tools have top-level
 *     name + input_schema), or
 *   - `system` is a plain string (Claude uses an array of blocks / no field).
 * No-tools + no-string-system bodies are ambiguous → false (stay pinned).
 */
export function isClearlyOpenAIShapedBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const rec = body as Record<string, unknown>;
  const tools = rec.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    const first = tools[0];
    return !!(
      first &&
      typeof first === "object" &&
      "function" in (first as Record<string, unknown>)
    );
  }
  return typeof rec.system === "string" && rec.system.length > 0;
}

/**
 * Override the primary door for THIS request. Only re-doors anthropic→openai
 * on a claude-pinned connection with a clearly-openai body; every other
 * combination keeps the caller's default.
 */
export function resolveProtocolAlignedTransport(
  body: unknown,
  primary: GlmTransport
): GlmTransport {
  if (!isProtocolAlignedRoutingEnabled()) return primary;
  if (primary !== "anthropic") return primary;
  return isClearlyOpenAIShapedBody(body) ? "openai" : primary;
}
