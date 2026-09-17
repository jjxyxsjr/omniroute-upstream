/**
 * #80 (nnd.27): default-on upstream streaming for non-streaming client requests.
 *
 * Response headers only mean "connection alive" on a streaming upstream; on a
 * non-streaming upstream they arrive when generation COMPLETES, so the bounded
 * response-start window (dead pooled-socket probe, upstream #10214) degenerates
 * into a completion-time cap that kills any generation longer than the window
 * (2026-09-16 review-bot 504 storm class). Forcing `stream: true` upstream lets
 * headers arrive in seconds — the probe keeps its liveness meaning, and the
 * non-streaming branch drains the SSE back into JSON (cline forceStream
 * mechanism, upstream #2081/#6126).
 *
 * Kill switch: OMNIROUTE_FORCE_UPSTREAM_STREAM=0/false/off restores the legacy
 * request-shape passthrough (unset = on). Unrecognized values warn and fall
 * back to the default (on) — nnd.18 convention: a typo'd env must never
 * silently flip behavior.
 */
export function resolveForceUpstreamStreaming(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env.OMNIROUTE_FORCE_UPSTREAM_STREAM;
  if (raw == null || raw.trim() === "") return true;
  const value = raw.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "off") return false;
  if (value === "1" || value === "true") return true;
  console.warn(
    `[forceUpstreamStreaming] OMNIROUTE_FORCE_UPSTREAM_STREAM="${raw.trim()}" not recognized (use 1/true or 0/false/off) — defaulting to ON`
  );
  return true;
}
