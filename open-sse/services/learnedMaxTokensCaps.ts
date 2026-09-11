/**
 * nnd.22 补丁②: learned per-provider+model ceilings for `max_tokens`.
 *
 * Mirror of learnedThinkingCaps.ts (thinking_budget 400 clamp-and-retry,
 * Gemini-family). Some upstreams advertise a max_tokens ceiling LOWER than
 * what clients legitimately ask for — e.g. the Ark coding endpoint rejects
 * 178586 with "expected a value <= 131072" while GLM's OpenAI endpoint
 * accepts the same body. Clients (ZCode pulls max, agents compute
 * context-derived budgets) cannot know every plan's ceiling; the gateway
 * absorbs the difference: parse the advertised ceiling from the 400, clamp,
 * retry once, and record it so FUTURE requests pre-clamp with zero extra
 * round-trips (2026-09-10: 谭婧琳 17 rejects on 9-09, operator-ordered fix —
 * "用户感知到就是我们的问题，网关替用户兜住").
 */

const learnedCaps = new Map<string, number>();

function capKey(provider: string | null | undefined, model: string | null | undefined): string {
  return `${(provider || "").toLowerCase()}::${(model || "").toLowerCase()}`;
}

export function getLearnedMaxTokensCap(
  provider: string | null | undefined,
  model: string | null | undefined
): number | null {
  return learnedCaps.get(capKey(provider, model)) ?? null;
}

export function recordLearnedMaxTokensCap(
  provider: string | null | undefined,
  model: string | null | undefined,
  cap: number
): number {
  const key = capKey(provider, model);
  const existing = learnedCaps.get(key);
  if (existing !== undefined && existing <= cap) {
    return existing; // already learned an equal-or-lower ceiling; keep it
  }
  learnedCaps.set(key, cap);
  return cap;
}

/**
 * Extract the upstream-advertised max_tokens ceiling from a 400 body.
 * Observed shapes (Ark anthropic endpoint, 2026-09-09/10):
 *   "The parameter `max_tokens` ... integer above maximum value, expected a
 *    value <= 131072, but got 178586 instead."            → 131072
 *   "The parameter `max_tokens` ... not valid: integer, expected a value
 *    < 8192"                                              → 8191 (exclusive bound)
 * Only matches max_tokens errors (never thinking_budget / other params).
 * Returns null for anything else.
 *
 * nnd.24 ④ (2026-09-11 实测定案): Ark 的 JSON 序列化把 `<` 转义成 `\u003c`
 * (实测 raw body: "expected a value \u003c= 131072")。反应块拿的是 clone().text()
 * 的原始响应文本——不经过 JSON.parse——字面 `<=` 正则对转义形永不命中，导致
 * 9-11 生产两笔 400 零钳制零学习静默穿透（复现容器用日志里的“已还原形”造假
 * 上游全部误绿）。故匹配前先把 JSON 六进制转义还原再跑正则。
 */
export function parseMaxTokensCeiling(errText: unknown): number | null {
  if (typeof errText !== "string" || !errText) return null;
  // Unescape JSON \uXXXX forms of <, =, & so the literal regexes below can see
  // them. Only these three appear in upstream validation messages in practice;
  // anything else is left untouched.
  const normalized = errText
    .replace(/\\u003[cC]/g, "<")
    .replace(/\\u003[dD]/g, "=")
    .replace(/\\u0026/g, "&");
  const inclusive = /max_tokens[^\n]*?expected a value\s*<=\s*(\d+)/i.exec(normalized);
  if (inclusive) {
    const max = Number(inclusive[1]);
    return Number.isFinite(max) && max > 0 ? max : null;
  }
  const exclusive = /max_tokens[^\n]*?expected a value\s*<\s*(\d+)/i.exec(normalized);
  if (exclusive) {
    const max = Number(exclusive[1]);
    if (Number.isFinite(max) && max > 1) return max - 1;
    return null;
  }
  return null;
}

/** Test-only: clear the learned-cap Map between tests. */
export function __test_resetLearnedMaxTokensCaps(): void {
  learnedCaps.clear();
}

/**
 * Clamp a top-level `max_tokens` (anthropic/openai request shape) down to the
 * ceiling. When the body carries Claude-style thinking with a budget_tokens
 * that would now exceed max_tokens (the anthropic contract requires
 * budget_tokens < max_tokens — the gateway's adaptive thinkingBudget injection
 * is exactly what inflates max_tokens past upstream ceilings: client 8192 +
 * injected budget 170394 = 178586, observed 2026-09-09/10), the budget is
 * squeezed to max_tokens - 1024 so the clamped pair stays contract-valid.
 * Returns true when the body was actually modified.
 */
export function clampTopLevelMaxTokens(body: unknown, cap: number): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (!(Number.isFinite(cap) && cap > 0)) return false;
  const rec = body as {
    max_tokens?: unknown;
    thinking?: { budget_tokens?: unknown } | null;
  };
  const current = Number(rec.max_tokens);
  if (!Number.isFinite(current) || current <= cap) return false;
  rec.max_tokens = cap;
  const budget = Number(rec.thinking?.budget_tokens);
  if (Number.isFinite(budget) && budget > cap - 1024) {
    rec.thinking = { ...rec.thinking, budget_tokens: Math.max(cap - 1024, 0) };
  }
  return true;
}
