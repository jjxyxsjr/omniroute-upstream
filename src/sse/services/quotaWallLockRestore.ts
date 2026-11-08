/**
 * nnd.42c (#224): restore quota-wall model lockouts after a restart.
 *
 * modelLockouts is in-memory only; the daily 07:15 BJ restart wiped it, so
 * the first real request after every restart re-hit a wall the gateway had
 * already paid for — one guaranteed wasted upstream call per restart per
 * walled account (2026-11-07: 1 re-hit; 2026-11-08: 3 re-hits incl. a
 * user-visible 503 chain). Replays the walls from call_logs: any recent
 * wall-shaped 429 whose parsed reset is STILL IN THE FUTURE re-arms the
 * lockout to that instant, with the same 30-day sanity ceiling and upstream
 * -reset bypass the live 429 path applies (nnd.42b ④).
 *
 * Wall text families this replays (must stay in sync with
 * quota429Internalizer.QUOTA_WALL_PATTERNS):
 *   - ark: "exceeded the <window> usage quota. It will reset at … +0800"
 *   - GLM [1308]: "已达到 5 小时的使用上限。您的限额将在 … 重置"
 */
import { getDbInstance } from "@/lib/db/core";
import { recordModelLockoutFailure } from "@omniroute/open-sse/services/accountFallback.ts";
import { extractResetAtMs } from "@omniroute/open-sse/services/combo/quota429Internalizer.ts";

const WALL_429_LIKE =
  "(error_summary LIKE '%usage quota%' OR error_summary LIKE '%5 小时%上限%' OR error_summary LIKE '%[1308]%')";

export function restoreQuotaWallLockoutsFromHistory(lookbackMs = 3 * 24 * 3_600_000): number {
  const db = getDbInstance();
  const since = new Date(Date.now() - lookbackMs).toISOString();
  // Latest wall row per (provider, account, model); attempt rows carry the
  // upstream account, the final client-facing rows carry '-' and are excluded.
  const rows = db
    .prepare(
      `SELECT provider, account, model, error_summary
       FROM call_logs cl
       WHERE timestamp >= ? AND status = 429 AND account != '-' AND account IS NOT NULL
         AND provider IS NOT NULL AND model IS NOT NULL AND ${WALL_429_LIKE}
         AND timestamp = (
           SELECT MAX(timestamp) FROM call_logs x
           WHERE x.status = 429 AND x.account = cl.account AND x.model = cl.model
             AND x.provider = cl.provider AND x.account != '-' AND x.timestamp >= ?
         )`
    )
    .all(since, since) as Array<{
    provider: string;
    account: string;
    model: string;
    error_summary: string | null;
  }>;

  const now = Date.now();
  let restored = 0;
  for (const row of rows) {
    const resetAt = extractResetAtMs(row.error_summary ?? "");
    if (resetAt === null || resetAt <= now) continue; // already expired — nothing to arm
    const conn = db
      .prepare("SELECT id FROM provider_connections WHERE TRIM(name) = ? AND provider = ?")
      .get(row.account.trim(), row.provider) as { id: string } | undefined;
    if (!conn) continue;
    const exactCooldownMs = Math.min(resetAt - now, 30 * 24 * 3_600_000);
    recordModelLockoutFailure(row.provider, conn.id, row.model, "quota_exhausted", 429, 30_000, null, {
      exactCooldownMs,
      maxCooldownMs: 30 * 24 * 3_600_000,
      // The reset came from persisted upstream prose — same trust ruling as
      // the live 429 paths (nnd.42b ④, see proseResetHintBypassesMaxCooldownMs).
      exactCooldownIsUpstreamReset: true,
      scope: "exact",
    });
    restored++;
  }
  return restored;
}
