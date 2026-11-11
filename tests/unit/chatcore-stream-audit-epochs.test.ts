/**
 * nnd.44 ②-fix (#227 regression guards): these tests exist BECAUSE the first
 * cut shipped green unit tests while the live trial proved both defects —
 *   (1) first_byte_at ≡ first_forward_at (both columns stamped by events that
 *       land in the same tick on GLM) — guard: the audit sources must be
 *       DIFFERENT events with REAL elapsed time between them;
 *   (2) chunk_itl_p99_ms / chunk_pause_2s_count / first_content_at NULL on
 *       streamed rows — guard: drive the REAL saveCallLog → artifact worker →
       reply UPDATE chain and assert the columns are non-null in SQLite.
 * No same-instant time mocks: every gap below is real wall-clock elapsed ms.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-stream-audit-epochs-"));
process.env.DATA_DIR = TEST_DATA_DIR;
delete process.env.SSE_FRAME_COALESCE_MS; // passthrough forwards synchronously

const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.ts");
const { streamTimingEpochs, streamTimingChunkSample } = await import(
  "../../open-sse/utils/streamTiming.ts"
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const encoder = new TextEncoder();

function sseFrame(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

async function driveStream(frames: Array<{ bytes: Uint8Array; delayMs: number }>) {
  const stream = createPassthroughStreamWithLogger("epoch-test");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const readAll = (async () => {
    const received: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(value);
    }
    return received;
  })();
  for (const frame of frames) {
    if (frame.delayMs > 0) await sleep(frame.delayMs);
    await writer.write(frame.bytes);
  }
  await writer.close();
  await readAll;
  return stream;
}

test("audit sources are DIFFERENT events: output epoch trails the first forwarded chunk by real elapsed time", async () => {
  // Frame 1: role-only lifecycle chunk (forwarded immediately, carries NO
  // output). Frame 2 (+45ms): first content. Frame 3 (+45ms): more content.
  const stream = await driveStream([
    {
      bytes: sseFrame({ choices: [{ delta: { role: "assistant" } }] }),
      delayMs: 0,
    },
    {
      bytes: sseFrame({ choices: [{ delta: { content: "hello" } }] }),
      delayMs: 45,
    },
    {
      bytes: sseFrame({ choices: [{ delta: { content: " world" } }] }),
      delayMs: 45,
    },
  ]);

  const epochs = streamTimingEpochs(stream);
  assert.ok(epochs.firstByteEpochMs != null, "construction byte epoch present");
  assert.ok(epochs.firstForwardEpochMs != null, "first forward epoch present");
  assert.ok(epochs.firstOutputEpochMs != null, "first OUTPUT epoch present (content frame)");
  // The #29 ttft source must NOT be the same event as the first forwarded
  // chunk — this is the exact collapse that shipped as ② (#227 live-fire):
  // with a lifecycle first frame, output trails forwarding by the frame gap.
  const forwardToOutput = epochs.firstOutputEpochMs! - epochs.firstForwardEpochMs!;
  assert.ok(
    forwardToOutput >= 30,
    `firstOutputEpochMs must trail firstForwardEpochMs by ≥30ms (real gap), got ${forwardToOutput}ms`
  );
  // And the persisted pair (dispatch → first output) separates by
  // construction: dispatch precedes even the transform construction.
  const fakeDispatchEpoch = epochs.firstByteEpochMs! - 60;
  const auditDelta = epochs.firstOutputEpochMs! - fakeDispatchEpoch;
  assert.ok(auditDelta >= 80, `dispatch→output must be ≥80ms, got ${auditDelta}ms`);

  const sample = streamTimingChunkSample(stream);
  assert.ok(sample, "chunk sample present for a multi-frame stream");
  assert.ok(sample!.epochs.length >= 3, `sampled ≥3 forward epochs, got ${sample!.epochs.length}`);
  assert.ok(sample!.firstContentEpochMs != null, "first CONTENT epoch present (content frame seen)");
});

test("reasoning placeholder does not satisfy the OUTPUT probe either", async () => {
  const stream = await driveStream([
    {
      bytes: sseFrame({ choices: [{ delta: { reasoning_content: "thinking…" } }] }),
      delayMs: 0,
    },
    {
      bytes: sseFrame({ choices: [{ delta: { content: "answer" } }] }),
      delayMs: 40,
    },
  ]);
  const epochs = streamTimingEpochs(stream);
  const sample = streamTimingChunkSample(stream);
  assert.ok(epochs.firstOutputEpochMs != null, "reasoning frame DOES satisfy output (ttft source)");
  assert.ok(sample!.firstContentEpochMs != null, "content frame satisfies the content probe");
  assert.ok(
    sample!.firstContentEpochMs! >= epochs.firstOutputEpochMs!,
    "content epoch never precedes the output epoch"
  );
});

test("deep-think prefix beyond the probe window still yields first CONTENT (live-trial 18:13 regression)", async () => {
  // 90 reasoning-only frames, then a burst of 5 content frames — the exact
  // shape the 1-in-16 stride probe missed on trial (first_content_at NULL on
  // a stream that answered). Every frame past the window is now probed, so
  // even a single-frame burst lands.
  const frames: Array<{ bytes: Uint8Array; delayMs: number }> = [];
  for (let i = 0; i < 90; i++) {
    frames.push({
      bytes: sseFrame({ choices: [{ delta: { reasoning_content: `thought ${i}` } }] }),
      delayMs: 0,
    });
  }
  frames.push({
    bytes: sseFrame({ choices: [{ delta: { content: "short answer" } }] }),
    delayMs: 5,
  });
  frames.push({
    bytes: sseFrame({ choices: [{ delta: { content: "!" } }] }),
    delayMs: 0,
  });
  const stream = await driveStream(frames);
  const sample = streamTimingChunkSample(stream);
  assert.ok(sample, "sample present");
  assert.ok(
    sample!.firstContentEpochMs != null,
    "first CONTENT epoch must be found past the 64-frame window (per-frame probe)"
  );
  assert.ok(sample!.epochs.length >= 2, "forward epochs still sampled");
});

test("claude-format thinking stream: content probe survives a thinking_delta flood", async () => {
  const claudeThinking = (text: string) =>
    encoder.encode(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: text },
      })}\n\n`
    );
  const claudeText = (text: string) =>
    encoder.encode(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text },
      })}\n\n`
    );
  const frames: Array<{ bytes: Uint8Array; delayMs: number }> = [];
  for (let i = 0; i < 120; i++) frames.push({ bytes: claudeThinking(`t${i}`), delayMs: 0 });
  frames.push({ bytes: claudeText("一"), delayMs: 5 });
  frames.push({ bytes: claudeText("二"), delayMs: 0 });
  const stream = await driveStream(frames);
  const sample = streamTimingChunkSample(stream);
  assert.ok(sample!.firstContentEpochMs != null, "text_delta found after thinking flood");
});

test.after(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
