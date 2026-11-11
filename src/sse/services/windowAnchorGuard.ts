/**
 * windowAnchorGuard.ts — nnd.44 ①a (iid 231 track B): native port of the
 * production-verified host script
 * deploy/omniroute/skills/omniroute-ops/scripts/glm-anchor-guard.js.
 *
 * WHY: providers whose quota window resets on a fixed local anchor (GLM 5h
 * session window, 06:00 Asia/Shanghai) get their window START anchored by the
 * first request after a reset. An idle account that takes its first request in
 * the small hours (01:00–05:55) carries its 5h window PAST the 06:00 anchor,
 * so the account is exhausted ("burned") precisely when the morning peak needs
 * it. The guard plans a blackout that ends just before the anchor
 * (RELEASE_AT=05:55 — 5 minutes of seam for the anchor ball), keeping idle
 * accounts untouched until the fresh window opens.
 *
 * Classification per active connection (identical semantics to the host
 * script, judge formula ratified by the operator 2026-11-09):
 *
 *   R = latest session-window snapshot next_reset_at (quota_snapshots,
 *       refreshed by the background quota refresh — no upstream call here)
 *   R NULL / already elapsed / stale beyond the window → ban [00:55, 05:55]
 *   R ∈ (01:00, 05:55]  (BJ time-of-day) → ban [R − LEAD_MINUTES, 05:55]
 *       (LEAD_MINUTES=15: one full cron round of margin, so a snapshot read
 *        right before R still gets the account banned before it burns)
 *   R ∈ (05:55, 06:00]  → naturally safe, no action (window ends before ball)
 *   R > 06:00           → tonight is already ruined — log only, no action
 *
 * WRITE DISCIPLINE (host-script parity, deliberately narrow):
 *   - writes rate_limited_until as an ISO-8601 STRING. Real 429s write epoch-ms
 *     numerics via setConnectionRateLimitUntil, so the raw encoding alone tells
 *     "planned blackout / operator manual" apart from "upstream 429 cooldown"
 *     (see isPlannedBlackoutRateLimitedUntil in open-sse accountFallback.ts —
 *     ①b/③ of this batch key off exactly that discriminator).
 *   - writes last_error='window-anchor-guard planned blackout' but NEVER
 *     last_error_type / test_status — quota pollers key on those to clear
 *     "recovered" state and must not lift the planned blackout early
 *     (maybeClearRecoveredQuotaState / syntheticRecoveryOverride).
 *   - only ever EXTENDS a cooldown (never shortens a longer real-429 lock),
 *     idempotent, survives restarts (future values are never cleared by
 *     clearStaleCrashCooldowns).
 *
 * The host cron (nightly pass + morning verify) stays deployed as a second
 * line of defense; the morning pass also independently verifies this module.
 *
 * Scheduler skeleton mirrors src/lib/quota/connectionRecovery.ts:
 * globalThis-guarded singleton (HMR/double-import safe), unref'd interval so
 * it never holds the process open, self-disable in build/test processes and
 * under OMNIROUTE_DISABLE_BACKGROUND_SERVICES / OMNIROUTE_DISABLE_WINDOW_ANCHOR_GUARD.
 * Outside the nightly action window the tick is a cheap no-op (one
 * localDayAndMinute computation, zero DB reads).
 */

import { cooldownUntilMs } from "@omniroute/open-sse/services/accountFallback.ts";
import { localDayAndMinute } from "@/lib/quota/schedules";
import { isAutomatedTestProcess } from "@/shared/utils/testProcess";

const LOG_PREFIX = "[WindowAnchorGuard]";
const DEFAULT_TICK_MS = 60 * 1000;
const MIN_TICK_MS = 5 * 1000;
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

/** Default providers under anchor protection (GLM 5h session window). */
const DEFAULT_PROVIDERS = "glm-cn";
/** Default anchor timezone. */
const DEFAULT_TIMEZONE = "Asia/Shanghai";
/** Default anchor moment (local HH:MM) the window must not be exhausted past. */
const DEFAULT_ANCHOR_AT = "06:00";
/** Blackout always releases here (local HH:MM), 5 minutes before the anchor. */
const DEFAULT_RELEASE_AT = "05:55";
/** R−15min: ban starts one full cron round before the snapshot reset. */
const DEFAULT_LEAD_MINUTES = 15;
/** 5h quota window (GLM session window). */
const DEFAULT_WINDOW_MS = 5 * 3_600_000;
/** Ticks begin this many minutes before the night-start ban moment. */
const ACTION_WINDOW_LEAD_MINUTES = 10;
/** A snapshot older than this past its reset is treated as idle/stale. */
const SNAPSHOT_STALE_SLACK_MS = 60 * 1000;
/** last_error label written alongside the blackout (never last_error_type). */
export const PLANNED_BLACKOUT_LABEL = "window-anchor-guard planned blackout";

export interface WindowAnchorGuardConfig {
  providers: string[];
  timezone: string;
  anchorMinute: number;
  releaseMinute: number;
  leadMinutes: number;
  windowMs: number;
  tickMs: number;
}

declare global {
  var __omnirouteWindowAnchorGuard:
    { initialized: boolean; interval: ReturnType<typeof setInterval> | null } | undefined;
}

function getGuardState() {
  if (!globalThis.__omnirouteWindowAnchorGuard) {
    globalThis.__omnirouteWindowAnchorGuard = { initialized: false, interval: null };
  }
  return globalThis.__omnirouteWindowAnchorGuard;
}

function isEnvFlagEnabled(name: string): boolean {
  const value = typeof process !== "undefined" ? process.env[name] : undefined;
  return !!value && TRUE_ENV_VALUES.has(value.trim().toLowerCase());
}

function isBuildProcess(): boolean {
  return typeof process !== "undefined" && process.env.NEXT_PHASE === "phase-production-build";
}

export function isWindowAnchorGuardDisabled(): boolean {
  return (
    isEnvFlagEnabled("OMNIROUTE_DISABLE_WINDOW_ANCHOR_GUARD") ||
    isEnvFlagEnabled("OMNIROUTE_DISABLE_BACKGROUND_SERVICES") ||
    isBuildProcess() ||
    isAutomatedTestProcess()
  );
}

function parseHhMm(raw: string | undefined, fallbackMinutes: number): number {
  if (!raw) return fallbackMinutes;
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallbackMinutes;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallbackMinutes;
  const total = hours * 60 + minutes;
  if (total < 0 || total >= 1440) return fallbackMinutes;
  return total;
}

export function resolveWindowAnchorGuardConfig(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}
): WindowAnchorGuardConfig {
  const providersRaw = (env.WINDOW_ANCHOR_GUARD_PROVIDERS ?? DEFAULT_PROVIDERS).trim();
  const providers = providersRaw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.toLowerCase() !== "none");
  const anchorMinute = parseHhMm(env.WINDOW_ANCHOR_GUARD_ANCHOR_AT, parseHhMm(DEFAULT_ANCHOR_AT, 360));
  const releaseMinute = parseHhMm(env.WINDOW_ANCHOR_GUARD_RELEASE_AT, parseHhMm(DEFAULT_RELEASE_AT, 355));
  const leadMinutesRaw = Number(env.WINDOW_ANCHOR_GUARD_LEAD_MINUTES);
  const windowMsRaw = Number(env.WINDOW_ANCHOR_GUARD_WINDOW_MS);
  const tickRaw = Number(env.WINDOW_ANCHOR_GUARD_INTERVAL_MS);
  return {
    providers,
    timezone: (env.WINDOW_ANCHOR_GUARD_TIMEZONE ?? DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE,
    anchorMinute,
    releaseMinute,
    leadMinutes:
      Number.isFinite(leadMinutesRaw) && leadMinutesRaw >= 0 && leadMinutesRaw <= 360
        ? Math.floor(leadMinutesRaw)
        : DEFAULT_LEAD_MINUTES,
    windowMs:
      Number.isFinite(windowMsRaw) && windowMsRaw >= 60_000 && windowMsRaw <= 24 * 3_600_000
        ? Math.floor(windowMsRaw)
        : DEFAULT_WINDOW_MS,
    tickMs:
      Number.isFinite(tickRaw) && tickRaw > 0 ? Math.max(MIN_TICK_MS, Math.floor(tickRaw)) : DEFAULT_TICK_MS,
  };
}

/** One connection's row, as this guard reads it. */
export interface AnchorConnectionRow {
  id: string;
  name: string | null;
  rateLimitedUntil: string | number | null;
}

/** Latest session-window snapshot per connection (epoch ms of next_reset_at). */
export interface AnchorSnapshotMap {
  get(connectionId: string): { resetAtMs: number | null; createdAtMs: number | null } | undefined;
}

/** Verdict for one connection inside the action window. Pure, time injected. */
export type AnchorPlan =
  | { kind: "ban"; fromMs: number; releaseMs: number; note: string }
  | { kind: "safe"; note: string }
  | { kind: "ruined"; note: string }
  | { kind: "future"; banFromMs: number; releaseMs: number; note: string };

export function classifyAnchorPlan(input: {
  nowMs: number;
  config: WindowAnchorGuardConfig;
  /** Local minute-of-day of now in the guard timezone. */
  nowMinuteOfDay: number;
  resetAtMs: number | null;
}): AnchorPlan {
  const { nowMs, config, nowMinuteOfDay, resetAtMs } = input;
  const { anchorMinute, releaseMinute, leadMinutes, windowMs, timezone } = config;
  // Anchors for "today" in the guard timezone. The tick only runs inside the
  // action window (< 6h wide), so minute-offset arithmetic is exact even under
  // a DST jump elsewhere in the zone — the offsets re-resolve on every tick.
  const releaseMs = nowMs + (releaseMinute - nowMinuteOfDay) * 60_000;
  const anchorMs = nowMs + (anchorMinute - nowMinuteOfDay) * 60_000;
  const nightStartMs = releaseMs - windowMs;

  const stale =
    resetAtMs === null ||
    !Number.isFinite(resetAtMs) ||
    resetAtMs <= nowMs ||
    resetAtMs > nowMs + windowMs + SNAPSHOT_STALE_SLACK_MS;
  if (stale) {
    const note =
      resetAtMs === null || !Number.isFinite(resetAtMs)
        ? "no session snapshot (idle, full) — protect from night start"
        : resetAtMs <= nowMs
          ? "snapshot window already elapsed — idle, protect from night start"
          : "snapshot stale beyond window — treat as idle";
    return { kind: "ban", fromMs: nightStartMs, releaseMs, note };
  }
  if (resetAtMs > anchorMs) {
    return {
      kind: "ruined",
      note: `current window outlives the anchor (reset ${new Date(resetAtMs).toISOString()}) — tonight already burned, no action`,
    };
  }
  const resetMinuteOfDay = localDayAndMinute(resetAtMs, timezone).minute;
  if (resetMinuteOfDay > releaseMinute && resetMinuteOfDay <= anchorMinute) {
    return { kind: "safe", note: `window ends just before the anchor (${resetMinuteOfDay} min-of-day)` };
  }
  if (resetMinuteOfDay > 60 && resetMinuteOfDay <= releaseMinute) {
    const banFrom = resetAtMs - leadMinutes * 60_000;
    if (banFrom > nowMs) {
      return {
        kind: "future",
        banFromMs: banFrom,
        releaseMs,
        note: `R in danger zone — planned ban starts ${new Date(banFrom).toISOString()}`,
      };
    }
    return { kind: "ban", fromMs: banFrom, releaseMs, note: "R in danger zone — ban now" };
  }
  return { kind: "ban", fromMs: nightStartMs, releaseMs, note: "R at/before 01:00 — danger starts at night start" };
}

/** Should this tick act at all? False outside [nightStart−lead, anchor). */
export function isInsideAnchorActionWindow(
  nowMinuteOfDay: number,
  config: WindowAnchorGuardConfig
): boolean {
  const actionStart =
    config.releaseMinute - config.windowMs / 60_000 - ACTION_WINDOW_LEAD_MINUTES;
  return nowMinuteOfDay >= Math.max(0, actionStart) && nowMinuteOfDay < config.anchorMinute;
}

interface GuardDeps {
  nowMs?: number;
  config?: WindowAnchorGuardConfig;
  loadConnections?: () => Promise<AnchorConnectionRow[]>;
  loadSnapshots?: () => Promise<AnchorSnapshotMap>;
  writeBlackout?: (connectionId: string, releaseIso: string) => Promise<boolean>;
  dryRun?: boolean;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}

async function loadConnectionsDefault(providers: string[]): Promise<AnchorConnectionRow[]> {
  const { getDbInstance } = await import("@/lib/db/core");
  const db = getDbInstance() as unknown as {
    prepare: <TRow>(sql: string) => { all: (...params: unknown[]) => TRow[] };
  };
  const placeholders = providers.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, name, rate_limited_until AS rateLimitedUntil
       FROM provider_connections WHERE provider IN (${placeholders}) AND is_active = 1`
    )
    .all(...providers) as Array<{ id: string; name: string | null; rateLimitedUntil: string | number | null }>;
  return rows;
}

async function loadSnapshotsDefault(providers: string[]): Promise<AnchorSnapshotMap> {
  const { getDbInstance } = await import("@/lib/db/core");
  const db = getDbInstance() as unknown as {
    prepare: <TRow>(sql: string) => { all: (...params: unknown[]) => TRow[] };
  };
  const placeholders = providers.map(() => "?").join(",");
  // Latest session-window snapshot per connection (same query shape as the
  // host script). provider filter on the outer select keeps foreign pools out.
  const rows = db
    .prepare(
      `SELECT s.connection_id AS cid, s.next_reset_at AS nra, s.created_at AS ca
       FROM quota_snapshots s
       WHERE s.window_key = 'session' AND s.provider IN (${placeholders})
         AND s.id IN (SELECT MAX(id) FROM quota_snapshots WHERE window_key = 'session' GROUP BY connection_id)`
    )
    .all(...providers) as Array<{ cid: string; nra: string | null; ca: string | null }>;
  const map = new Map<string, { resetAtMs: number | null; createdAtMs: number | null }>();
  for (const row of rows) {
    const resetAtMs = row.nra ? Date.parse(row.nra) : null;
    map.set(row.cid, {
      resetAtMs: resetAtMs !== null && Number.isFinite(resetAtMs) ? resetAtMs : null,
      createdAtMs: row.ca ? Date.parse(row.ca) : null,
    });
  }
  return map;
}

export interface WindowAnchorGuardTickResult {
  ticked: boolean;
  inWindow: boolean;
  written: number;
  ruined: number;
  skipped: number;
}

/**
 * Run one guard tick. Never throws — a failed tick logs and returns; the
 * scheduler keeps going. All external effects are injectable for tests.
 */
export async function runWindowAnchorGuardTick(deps: GuardDeps = {}): Promise<WindowAnchorGuardTickResult> {
  const config = deps.config ?? resolveWindowAnchorGuardConfig();
  const result: WindowAnchorGuardTickResult = { ticked: true, inWindow: false, written: 0, ruined: 0, skipped: 0 };
  if (config.providers.length === 0) return result;
  const nowMs = deps.nowMs ?? Date.now();
  const { minute } = localDayAndMinute(nowMs, config.timezone);
  if (!isInsideAnchorActionWindow(minute, config)) return result;
  result.inWindow = true;

  let connections: AnchorConnectionRow[];
  let snapshots: AnchorSnapshotMap;
  try {
    connections = await (deps.loadConnections ?? loadConnectionsDefault)(config.providers);
    snapshots = await (deps.loadSnapshots ?? (() => loadSnapshotsDefault(config.providers)))();
  } catch (err) {
    deps.logger?.warn?.(
      `${LOG_PREFIX} tick failed to load state: ${err instanceof Error ? err.message : String(err)}`
    );
    return result;
  }

  const write =
    deps.writeBlackout ??
    (async (connectionId: string, releaseIso: string) => {
      const { setConnectionPlannedBlackoutUntil } = await import("@/lib/db/providers/rateLimit");
      return setConnectionPlannedBlackoutUntil(connectionId, releaseIso, PLANNED_BLACKOUT_LABEL);
    });

  for (const connection of connections) {
    const snapshot = snapshots.get(connection.id);
    const plan = classifyAnchorPlan({
      nowMs,
      config,
      nowMinuteOfDay: minute,
      resetAtMs: snapshot?.resetAtMs ?? null,
    });
    const label = `${connection.name?.trim() || connection.id.slice(0, 8)}`;
    if (plan.kind === "safe") {
      deps.logger?.info?.(`${LOG_PREFIX} ${label} naturally safe — no action (${plan.note})`);
      continue;
    }
    if (plan.kind === "ruined") {
      deps.logger?.info?.(`${LOG_PREFIX} ${label} RUINED — no action (${plan.note})`);
      result.ruined += 1;
      continue;
    }
    if (plan.kind === "future") {
      deps.logger?.info?.(
        `${LOG_PREFIX} ${label} planned ban at ${new Date(plan.banFromMs).toISOString()} — not yet (${plan.note})`
      );
      continue;
    }
    // kind === "ban": inside [banFrom, release) — write unless already covered
    // (only extend, never shorten a longer live cooldown, whatever wrote it).
    if (nowMs >= plan.releaseMs) continue;
    const currentUntil = cooldownUntilMs(connection.rateLimitedUntil ?? "");
    if (Number.isFinite(currentUntil) && currentUntil >= plan.releaseMs) {
      result.skipped += 1;
      continue;
    }
    if (deps.dryRun) {
      deps.logger?.info?.(
        `${LOG_PREFIX} [DRY] ${label} would ban until ${new Date(plan.releaseMs).toISOString()} (${plan.note})`
      );
      continue;
    }
    try {
      const written = await write(connection.id, new Date(plan.releaseMs).toISOString());
      if (written) result.written += 1;
      deps.logger?.info?.(
        `${LOG_PREFIX} ${label} planned blackout until ${new Date(plan.releaseMs).toISOString()} (${plan.note})` +
          (written ? "" : " — row already covered, no write")
      );
    } catch (err) {
      deps.logger?.warn?.(
        `${LOG_PREFIX} ${label} blackout write failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (result.written > 0 || result.ruined > 0) {
    deps.logger?.info?.(
      `${LOG_PREFIX} pass done — written=${result.written} ruined=${result.ruined} skipped=${result.skipped}`
    );
  }
  return result;
}

/**
 * Start the anchor-guard scheduler (idempotent). No-op in build/test processes
 * and when disabled via env. One unref'd interval; ticks outside the nightly
 * action window cost a single timezone computation.
 */
export function initWindowAnchorGuardScheduler(): void {
  const state = getGuardState();
  if (state.initialized || isWindowAnchorGuardDisabled()) return;
  state.initialized = true;
  const config = resolveWindowAnchorGuardConfig();
  if (config.providers.length === 0) {
    console.log(`${LOG_PREFIX} disabled — WINDOW_ANCHOR_GUARD_PROVIDERS is empty`);
    return;
  }
  const logger = {
    info: (msg: string) => console.log(msg),
    warn: (msg: string) => console.warn(msg),
  };
  const runTick = () => {
    runWindowAnchorGuardTick({ logger }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG_PREFIX} tick error (non-fatal): ${msg}`);
    });
  };
  console.log(
    `${LOG_PREFIX} starting anchor guard — providers=${config.providers.join(",")} anchor=${config.anchorMinute}min release=${config.releaseMinute}min tz=${config.timezone} tick=${Math.round(config.tickMs / 1000)}s`
  );
  // First tick quickly (it self-gates to the action window); then the interval.
  const timer = setTimeout(runTick, 20_000);
  (timer as { unref?: () => void } | undefined)?.unref?.();
  state.interval = setInterval(runTick, config.tickMs);
  (state.interval as { unref?: () => void } | undefined)?.unref?.();
}

/** Stop the scheduler (tests / hot-reload). */
export function stopWindowAnchorGuardScheduler(): void {
  const state = getGuardState();
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }
  state.initialized = false;
}
