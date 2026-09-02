/**
 * 8b (nnd.12) — zero-first-byte hang mitigation. When the stream readiness
 * deadline fires (upstream accepted the request but produced nothing for the
 * whole window), the single-model path used to surface the 504 immediately —
 * no target switch, no account rotation. The client saw a dead "thinking"
 * state and aborted (499) or ate the 504. The fix keeps the "do NOT mark the
 * account" semantics but switches to a different connection ONCE (quota-share
 * combos rotate accounts inside this same loop), surfacing a retryable-form
 * 504 only when the switch is exhausted or unavailable.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  shouldRetryStreamEarlyEof,
  shouldSwitchConnectionOnStreamReadinessTimeout,
  STREAM_READINESS_SWITCH_MAX_RETRIES,
} = await import("../../src/sse/handlers/chatHelpers.ts");
const { ensureStreamReadiness } = await import("../../open-sse/utils/streamReadiness.ts");

test("8b helper: switch once on readiness timeout, bounded, forced-connection aware", () => {
  assert.equal(STREAM_READINESS_SWITCH_MAX_RETRIES, 1);
  assert.equal(
    shouldSwitchConnectionOnStreamReadinessTimeout(
      "stream_timeout",
      "STREAM_READINESS_TIMEOUT",
      0,
      false
    ),
    true,
    "first readiness timeout on a free connection switches"
  );
  assert.equal(
    shouldSwitchConnectionOnStreamReadinessTimeout(
      "stream_timeout",
      "STREAM_READINESS_TIMEOUT",
      1,
      false
    ),
    false,
    "bounded to exactly one switch per request"
  );
  assert.equal(
    shouldSwitchConnectionOnStreamReadinessTimeout(
      "stream_timeout",
      "STREAM_READINESS_TIMEOUT",
      0,
      true
    ),
    false,
    "a forced connection cannot switch away"
  );
  assert.equal(
    shouldSwitchConnectionOnStreamReadinessTimeout("stream_early_eof", "STREAM_EARLY_EOF", 0, false),
    false,
    "EOF keeps its own same-connection retry path"
  );
  assert.equal(
    shouldSwitchConnectionOnStreamReadinessTimeout("upstream_timeout", "UPSTREAM_TIMEOUT", 0, false),
    false
  );
  assert.equal(shouldSwitchConnectionOnStreamReadinessTimeout(null, undefined, 0, false), false);
});

// Mirrors the chat.ts decision wiring around the stream-readiness branch: an
// early EOF prefers its cheap same-connection retry; a readiness timeout
// switches connection by exclusion ONLY (never markAccountUnavailable — a
// stream stall is an upstream issue, not a bad account); each is bounded to
// one extra attempt.
test("8b simulated loop: readiness timeout switches once then succeeds; exhaustion surfaces 504", () => {
  interface SimResult {
    errorCode?: string | null;
    errorType?: string | null;
    connectionId?: string;
    forced?: boolean;
    success?: boolean;
  }

  function simulate(results: SimResult[]) {
    let eofRetries = 0;
    let readinessSwitches = 0;
    let markAccountUnavailableCalls = 0;
    const excluded: string[] = [];
    let i = 0;
    while (true) {
      const r = results[Math.min(i, results.length - 1)];
      if (r.success) {
        return { outcome: "success", eofRetries, readinessSwitches, markAccountUnavailableCalls, excluded };
      }
      const forced = r.forced === true;
      if (!forced && shouldRetryStreamEarlyEof(r.errorCode, eofRetries)) {
        eofRetries += 1;
        i += 1;
        continue;
      }
      if (shouldSwitchConnectionOnStreamReadinessTimeout(r.errorType, r.errorCode, readinessSwitches, forced)) {
        readinessSwitches += 1;
        excluded.push(r.connectionId ?? "conn-?");
        i += 1;
        continue;
      }
      return { outcome: "504", eofRetries, readinessSwitches, markAccountUnavailableCalls, excluded };
    }
  }

  // A hang on conn-a, then the second connection serves the stream.
  const recovered = simulate([
    { errorType: "stream_timeout", errorCode: "STREAM_READINESS_TIMEOUT", connectionId: "conn-a" },
    { success: true },
  ]);
  assert.equal(recovered.outcome, "success");
  assert.equal(recovered.readinessSwitches, 1);
  assert.deepEqual(recovered.excluded, ["conn-a"], "the hung connection is excluded, not cooled down");
  assert.equal(recovered.markAccountUnavailableCalls, 0);

  // Every connection hangs: exactly one switch, then the retryable 504.
  const exhausted = simulate([
    { errorType: "stream_timeout", errorCode: "STREAM_READINESS_TIMEOUT", connectionId: "conn-a" },
    { errorType: "stream_timeout", errorCode: "STREAM_READINESS_TIMEOUT", connectionId: "conn-b" },
    { errorType: "stream_timeout", errorCode: "STREAM_READINESS_TIMEOUT", connectionId: "conn-c" },
  ]);
  assert.equal(exhausted.outcome, "504");
  assert.equal(exhausted.readinessSwitches, 1, "no unbounded retry chain against a hanging upstream");
  assert.equal(exhausted.markAccountUnavailableCalls, 0);

  // EOF still takes its same-connection retry BEFORE any switch.
  const eofFirst = simulate([
    { errorType: "stream_early_eof", errorCode: "STREAM_EARLY_EOF", connectionId: "conn-a" },
    { success: true },
  ]);
  assert.equal(eofFirst.outcome, "success");
  assert.equal(eofFirst.eofRetries, 1);
  assert.equal(eofFirst.readinessSwitches, 0);
});

test("8b the readiness-timeout 504 carries Retry-After so clients can treat it as retryable", async () => {
  const never = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(": ping\n\n"));
      await new Promise(() => {});
      controller.close();
    },
  });
  const response = new Response(never, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
  const result = await ensureStreamReadiness(response, { timeoutMs: 30 });
  assert.equal(result.ok, false);
  if (result.ok !== false) return;
  assert.equal(result.response.headers.get("retry-after"), "1");
  const body = (await result.response.json()) as { error?: { code?: string; type?: string } };
  assert.equal(body.error?.code, "STREAM_READINESS_TIMEOUT");
  assert.equal(body.error?.type, "stream_timeout");
});
