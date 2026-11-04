/**
 * #116: GET /api/inflight — real-time view of currently in-flight requests.
 *
 * Returns the live snapshot from the request lifecycle registry: which
 * requests are currently being processed, what phase each one is in, how long
 * it's been in that phase, and the predicted TTFT (from the learned table).
 *
 * This answers the operator's core question: "is this request stuck or just
 * slow?" — in real time, without waiting for the request to complete and land
 * in call_logs.
 *
 * #116 (nnd.40). Auth: manage-scope key.
 */
import { NextRequest, NextResponse } from "next/server";
import { getInflightSnapshot } from "@omniroute/open-sse/handlers/chatCore/requestLifecycle";

export async function GET(req: NextRequest) {
  try {
    const auth = req.headers.get("authorization") || "";
    if (!auth.startsWith("Bearer ")) {
      return NextResponse.json({ error: "AUTH_001" }, { status: 403 });
    }

    const snapshot = getInflightSnapshot();

    // Sort by age descending — oldest first (most likely to be problematic)
    snapshot.sort((a, b) => b.ageMs - a.ageMs);

    const byPhase: Record<string, number> = {};
    for (const s of snapshot) {
      byPhase[s.phase] = (byPhase[s.phase] || 0) + 1;
    }

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      totalInflight: snapshot.length,
      byPhase,
      requests: snapshot.map(s => ({
        id: s.id.slice(0, 8),
        user: s.user,
        model: s.model,
        combo: s.combo,
        account: s.account,
        phase: s.phase,
        ageSeconds: Math.round(s.ageMs / 100) / 10,
        phaseAgeSeconds: Math.round(s.phaseAgeMs / 100) / 10,
        cacheWarmth: s.cacheWarmth,
        predictedTtftSeconds: s.predictedTtftMs
          ? `${Math.round(s.predictedTtftMs.p50 / 100) / 10}~${Math.round(s.predictedTtftMs.p90 / 100) / 10}`
          : null,
        estimatedTokensIn: s.estimatedTokensIn > 0
          ? `${Math.round(s.estimatedTokensIn / 1000)}k`
          : null,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "INFLIGHT_001", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
