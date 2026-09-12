/**
 * nnd.25 (backend analysis): runtime-state snapshot job.
 *
 * Every 5 minutes (setInterval + unref) samples three otherwise process-local
 * state sources into the `runtime_state_snapshots` table (migration 178), one
 * aggregate row per kind, so post-hoc incident analysis can see what the
 * router believed at the time:
 *   1. `model_lockouts`   — accountFallback's in-memory modelLockout map
 *                           (via the read-only getModelLockoutSummary() export)
 *   2. `circuit_breakers` — the shared circuit-breaker registry statuses
 *                           (getAllCircuitBreakerStatuses, compacted)
 *   3. `admission_semaphores` — accountSemaphore gate stats (queued/running
 *                           depth per provider:account gate)
 *
 * Design rules (per the nnd.25 batch brief): NEVER refactor a hot path to make
 * a source samplable — a source is sampled only through an existing read-only
 * export. Each kind is isolated in try/catch: one failing sampler must not
 * suppress the others. Writes go through the src/lib/db/backendAnalysis DAO.
 */

import { getModelLockoutSummary } from "./accountFallback.ts";
import { getStats as getAccountSemaphoreStats } from "./accountSemaphore.ts";
import { getAllCircuitBreakerStatuses } from "../../src/shared/utils/circuitBreaker";
import {
  insertRuntimeStateSnapshot,
  type RuntimeStateSnapshotRow,
} from "../../src/lib/db/backendAnalysis";

/** Kinds sampled each cycle — one aggregate row per kind per cycle. */
export const RUNTIME_STATE_SNAPSHOT_KINDS = [
  "model_lockouts",
  "circuit_breakers",
  "admission_semaphores",
] as const;

export type RuntimeStateSnapshotKind = (typeof RUNTIME_STATE_SNAPSHOT_KINDS)[number];

export const RUNTIME_STATE_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

export interface RuntimeStateSnapshotJobOptions {
  intervalMs?: number;
}

let snapshotTimer: ReturnType<typeof setInterval> | null = null;

/** Compact projection of CircuitBreakerStatus — drop transitionHistory etc. */
function sampleCircuitBreakers(): { count: number; breakers: unknown[] } {
  const statuses = getAllCircuitBreakerStatuses();
  return {
    count: statuses.length,
    breakers: statuses.map((s) => ({
      name: s.name,
      state: s.state,
      failureCount: s.failureCount,
      lastFailureTime: s.lastFailureTime,
      retryAfterMs: s.retryAfterMs,
      openCycleCount: s.openCycleCount,
    })),
  };
}

/** Aggregate the per-gate semaphore stats into queue/running depth totals. */
function sampleAdmissionSemaphores(): {
  count: number;
  totalQueued: number;
  totalRunning: number;
  gates: Record<string, { queued: number; running: number; maxConcurrency: number }>;
} {
  const stats = getAccountSemaphoreStats();
  const gates: Record<string, { queued: number; running: number; maxConcurrency: number }> = {};
  let totalQueued = 0;
  let totalRunning = 0;
  for (const [key, entry] of Object.entries(stats)) {
    gates[key] = {
      queued: entry.queued,
      running: entry.running,
      maxConcurrency: entry.maxConcurrency,
    };
    totalQueued += entry.queued;
    totalRunning += entry.running;
  }
  return { count: Object.keys(stats).length, totalQueued, totalRunning, gates };
}

type Sampler = () => { count: number } & Record<string, unknown>;

const SAMPLERS: Record<RuntimeStateSnapshotKind, Sampler> = {
  model_lockouts: () => {
    const entries = getModelLockoutSummary();
    return { count: entries.length, entries };
  },
  circuit_breakers: sampleCircuitBreakers,
  admission_semaphores: sampleAdmissionSemaphores,
};

/**
 * Run one sampling cycle: one aggregate row per kind. Returns the number of
 * rows written. A sampler that throws (or a failed insert) skips that kind for
 * this cycle — the next cycle retries; never throws to the caller (the timer).
 */
export function collectRuntimeStateSnapshots(now = new Date()): number {
  let written = 0;
  const ts = now.toISOString();
  for (const kind of RUNTIME_STATE_SNAPSHOT_KINDS) {
    let row: RuntimeStateSnapshotRow;
    try {
      row = { ts, kind, entity: null, state: JSON.stringify(SAMPLERS[kind]()) };
      insertRuntimeStateSnapshot(row);
      written += 1;
    } catch (err: unknown) {
      console.warn(
        `[RuntimeStateSnapshots] ${kind} sample failed (skipped this cycle):`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return written;
}

/**
 * Start the periodic snapshot job. Idempotent — returns false when a job is
 * already running. The timer is unref'd so it never keeps the process alive.
 */
export function startRuntimeStateSnapshotJob(
  options: RuntimeStateSnapshotJobOptions = {}
): boolean {
  if (snapshotTimer) return false;
  const intervalMs = options.intervalMs ?? RUNTIME_STATE_SNAPSHOT_INTERVAL_MS;
  snapshotTimer = setInterval(() => collectRuntimeStateSnapshots(), intervalMs);
  // Do not keep the process alive just for state sampling.
  snapshotTimer.unref?.();
  console.log(
    `[RuntimeStateSnapshots] Job started (every ${Math.round(intervalMs / 1000)}s, ` +
      `${RUNTIME_STATE_SNAPSHOT_KINDS.join("/")}).`
  );
  return true;
}

/** Stop the job (and its timer). Test/ops hook. */
export function stopRuntimeStateSnapshotJobForTests(): void {
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
}
