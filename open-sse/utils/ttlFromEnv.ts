/**
 * Shared TTL-from-env resolver — nnd.18 audit fix.
 *
 * sessionStickiness.ts and sessionManager.ts each had a verbatim copy of the
 * parseInt → isFinite → fallback IIFE. The two 60-minute defaults were held in
 * sync only by comments; upstream history already showed SESSION_TTL drifting
 * 15→30→15→60 three times. This shared helper is the single point of truth.
 *
 * Semantics (identical to the originals):
 *   unset / blank / NaN / ≤0 → defaultMinutes
 *   positive integer        → that many minutes
 *
 * Return value is MILLISECONDS (*60*1000) — the Ms suffix in the name is the
 * unit of the RETURN; the env value's unit is minutes; consumers name their
 * consts *_MS.
 */
export function resolveTtlMsFromEnv(
  envVarName: string,
  defaultMinutes: number
): number {
  const raw = process.env[envVarName];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 60 * 1000 : defaultMinutes * 60 * 1000;
}
