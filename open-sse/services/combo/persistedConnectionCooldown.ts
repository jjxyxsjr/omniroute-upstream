import { cooldownUntilMs } from "../accountFallback.ts";
import {
  normalizeConnectionStatus,
  QUOTA_BLOCKING_CONNECTION_STATUSES,
  resolvePersistedConnectionCooldownSkipReason,
} from "./comboPredicates.ts";
import { recordSkippedConnectionCooldown } from "./skippedConnectionCooldown.ts";
import type { AttemptLoopState } from "./attemptLoopTypes.ts";

type Connection = Record<string, unknown> | null | undefined;
type CooldownState = Pick<AttemptLoopState, "skippedConnectionCooldownUntil">;

function recordRecoverablePersistedCooldown(state: CooldownState, connection: Connection): void {
  if (connection?.isActive !== true) return;
  const status = normalizeConnectionStatus(connection.testStatus);
  if (QUOTA_BLOCKING_CONNECTION_STATUSES.has(status) && status !== "rate_limited") return;
  const value = connection.rateLimitedUntil;
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return;
  const until = cooldownUntilMs(value);
  if (until > 8.64e15) return;
  const now = Date.now();
  recordSkippedConnectionCooldown(
    state,
    { available: false, reason: "connection_cooldown", retryAfterMs: until - now },
    now
  );
}

/** Retain a recoverable deadline from the same row used by the persisted skip gate. */
export async function resolveAndRecordPersistedCooldown(
  state: CooldownState,
  target: { modelStr: string; connectionId?: string | null },
  fetchConnection: (id: string) => Promise<Connection>,
  allowRateLimitedConnection = false,
  lastResort = false
): Promise<string | null> {
  let connection: Connection;
  const reason = await resolvePersistedConnectionCooldownSkipReason(
    target,
    async (id) => {
      connection = await fetchConnection(id);
      return connection;
    },
    allowRateLimitedConnection,
    // nnd.44 ③ (#213): encoding-aware exemption — future EPOCH cooldowns pass
    // for the last-resort dispatch, ISO planned blackouts still skip.
    lastResort
  );
  if (reason) recordRecoverablePersistedCooldown(state, connection);
  return reason;
}
