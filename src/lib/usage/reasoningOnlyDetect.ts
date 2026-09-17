/**
 * Reasoning-only response probe.
 *
 * Detects the "answer trapped in the thinking channel" failure shape: the
 * assistant message carries a non-empty `reasoning_content`, an empty
 * `content`, no tool_calls, and the choice finished with "stop". Every such
 * row logs as HTTP 200, so without this probe the failure is invisible to
 * status-based monitoring (observed 2026-09-17 on Tencent LKEAP × MiniMax M3:
 * 96 of 110 text-bearing turns delivered the whole answer inside the reasoning
 * channel while the text channel came back empty).
 *
 * Zero-import leaf (same convention as responseSanitizer/reasoning.ts) so the
 * call-log hot path and unit tests can use it without pulling the DB layer.
 */

type MaybeMessage = {
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: unknown;
};

type MaybeChoice = {
  finish_reason?: unknown;
  message?: MaybeMessage;
};

function hasToolCalls(message: MaybeMessage | undefined): boolean {
  const calls = message?.tool_calls;
  if (calls === null || calls === undefined) return false;
  return Array.isArray(calls) ? calls.length > 0 : true;
}

function contentIsEmpty(message: MaybeMessage | undefined): boolean {
  const content = message?.content;
  if (content === null || content === undefined) return true;
  if (typeof content === "string") return content.trim().length === 0;
  if (Array.isArray(content)) return content.length === 0;
  return false;
}

function reasoningIsPresent(message: MaybeMessage | undefined): boolean {
  const reasoning = message?.reasoning_content;
  return typeof reasoning === "string" && reasoning.trim().length > 0;
}

/**
 * True when the aggregated response delivered reasoning but no visible
 * assistant text and no tool call — a strong "thinking-channel misroute"
 * fingerprint (legitimate pure-reasoning stops are rare; tool turns are
 * excluded via finish_reason/tool_calls).
 */
export function isReasoningOnlyResponse(responseBody: unknown): boolean {
  if (!responseBody || typeof responseBody !== "object") return false;
  const choices = (responseBody as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const choice = choices[0] as MaybeChoice;
  if (choice?.finish_reason !== "stop") return false;
  const message = choice.message;
  if (hasToolCalls(message)) return false;
  return contentIsEmpty(message) && reasoningIsPresent(message);
}
