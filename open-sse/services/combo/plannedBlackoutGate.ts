/**
 * plannedBlackoutGate.ts — nnd.44 ①c (iid 231 track C).
 *
 * WHY THIS EXISTS: during a planned blackout (windowAnchorGuard ISO-encoding
 * rate_limited_until, or an operator manual lock) the AUTO-strategy candidate
 * builder drops every candidate whose connection carries a future
 * rate_limited_until (combo.ts visibility filter — model-locked / cooled
 * candidates never reach winner election). A glm-only combo therefore resolves
 * to ZERO orderedTargets and the empty-pool exit in combo.ts answers
 *
 *     404 "Combo has no executable targets"  (code model_not_found)
 *
 * — a NOT-FOUND that tells the client (and stock SDKs) the model does not
 * exist, when the truth is "every account is deliberately parked until
 * 05:55". Clients hard-fail or reconfigure on a 404; the honest answer is a
 * retryable 429 with the earliest recovery instant, exactly like the
 * all-targets-skipped exit (#89 exit B / nnd.30 #161 honest-gate family).
 *
 * This module scans a combo's own step providers for ACTIVE connections whose
 * rate_limited_until is BOTH future AND ISO-encoded — numeric epoch values are
 * real-429 cooldowns and keep the legacy 404 path (the attempt loop's exit B
 * already gives those an honest 429 with retry-after when they skip at gate
 * level; only the candidate-resolution layer lost them).
 */
import {
  cooldownUntilMs,
  formatRetryAfter,
  isPlannedBlackoutRateLimitedUntil,
} from "../accountFallback.ts";
import { parseModel } from "../model.ts";
import { getProviderAlias, resolveProviderId } from "../../../src/shared/constants/providers.ts";
import { getCachedProviderConnections } from "../../../src/lib/db/readCache.ts";
import { errorResponseWithComboDiagnostics } from "../../utils/error.ts";
import type { ComboLike } from "./types.ts";

/** Earliest FUTURE planned blackout (ISO encoding) among the combo's providers. */
export async function findEarliestPlannedBlackout(
  combo: ComboLike
): Promise<{ untilIso: string; provider: string } | null> {
  const providers = new Set<string>();
  for (const step of Array.isArray(combo.models) ? combo.models : []) {
    if (typeof step === "string") {
      const provider = parseModel(step).provider;
      if (provider && provider !== "unknown") providers.add(provider);
      continue;
    }
    if (step && typeof step === "object") {
      const record = step as { provider?: unknown; providerId?: unknown; model?: unknown };
      const explicit =
        typeof record.providerId === "string" && record.providerId.trim()
          ? record.providerId.trim()
          : typeof record.provider === "string" && record.provider.trim()
            ? record.provider.trim()
            : null;
      const provider =
        explicit ??
        (typeof record.model === "string" ? parseModel(record.model).provider : null);
      if (provider && provider !== "unknown") providers.add(provider);
    }
  }
  if (providers.size === 0) return null;

  const nowMs = Date.now();
  let earliestMs: number | null = null;
  let earliestProvider = "";
  let earliestIso: string | null = null;
  try {
    for (const provider of providers) {
      const canonical = resolveProviderId(provider);
      const alias = getProviderAlias(canonical);
      const ids = [...new Set([provider, canonical, alias].filter(Boolean))] as string[];
      const rows = await Promise.all(
        ids.map((id) => getCachedProviderConnections({ provider: id, isActive: true }))
      );
      for (const connection of rows.flat()) {
        const raw = (connection as { rateLimitedUntil?: unknown }).rateLimitedUntil;
        if (!isPlannedBlackoutRateLimitedUntil(raw)) continue;
        const untilMs = cooldownUntilMs(raw as string);
        if (!Number.isFinite(untilMs) || untilMs <= nowMs) continue;
        if (earliestMs === null || untilMs < earliestMs) {
          earliestMs = untilMs;
          earliestProvider = provider;
          earliestIso = typeof raw === "string" ? raw.trim() : new Date(untilMs).toISOString();
        }
      }
    }
  } catch {
    return null; // best-effort by design: terminal-error construction must never throw
  }
  return earliestIso ? { untilIso: earliestIso, provider: earliestProvider } : null;
}

/**
 * The planned-blackout honest gate for the empty-pool exit. Returns a 429 with
 * Retry-After + the recovery moment (Beijing) when the pool was emptied by a
 * planned blackout, or null when it was not (caller keeps its legacy 404).
 * Mirrors the semantics of comboAttemptLoop's all-targets-skipped exit (#89
 * exit B): standard Retry-After header, diagnostics body, recovery hint.
 */
export async function buildPlannedBlackoutResponse(combo: ComboLike): Promise<Response | null> {
  const blackout = await findEarliestPlannedBlackout(combo);
  if (!blackout) return null;
  const readyAtMs = cooldownUntilMs(blackout.untilIso);
  const retryAfterSeconds = Number.isFinite(readyAtMs)
    ? Math.max(1, Math.ceil((readyAtMs - Date.now()) / 1000) + 1)
    : undefined;
  const readyAtText = Number.isFinite(readyAtMs)
    ? new Date(readyAtMs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
    : null;
  const message = readyAtText
    ? `All targets are in a planned blackout (window anchor guard${blackout.provider ? `, provider ${blackout.provider}` : ""}); earliest recovery at ${readyAtText} (Beijing) — retry after ${retryAfterSeconds}s`
    : "All targets are in a planned blackout (window anchor guard)";
  const retryHuman = formatRetryAfter(blackout.untilIso);
  const fullMessage = retryHuman ? `${message} (${retryHuman})` : message;
  return errorResponseWithComboDiagnostics(
    429,
    fullMessage,
    {
      poolSize: 0,
      attempted: 0,
      excluded: [],
      attemptOrder: [],
      terminalReason: "planned_blackout",
      ...(retryAfterSeconds
        ? {
            recovery: {
              action: "wait",
              next_step: `计划封禁至 ${readyAtText ?? blackout.untilIso}（北京时间），约 ${retryAfterSeconds}s 后重试`,
              retry_after_seconds: retryAfterSeconds,
            },
          }
        : {}),
    },
    {
      code: "PLANNED_BLACKOUT",
      type: "rate_limit_error",
      retryAfterSeconds,
      retryAfter: blackout.untilIso,
    }
  );
}
