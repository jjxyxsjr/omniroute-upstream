/**
 * nnd.44 ②b (#232): chunk-epoch aggregation pure logic + the CONTENT-vs-
 * reasoning SSE predicates that back first_content_at.
 */
import assert from "node:assert/strict";
import test from "node:test";

const { aggregateChunkTiming } = await import("../../src/lib/usage/chunkTimingStats.ts");
const { sseChunkCarriesContent, sseChunkCarriesOutput } = await import(
  "../../open-sse/utils/sseOutputSignal.ts"
);

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

test("aggregation is null-honest for empty or single-epoch samples", () => {
  const empty = aggregateChunkTiming({ epochs: [], truncated: false, firstContentEpochMs: null });
  assert.equal(empty.itlP50Ms, null);
  assert.equal(empty.itlP99Ms, null);
  assert.equal(empty.pause2sCount, null);

  const single = aggregateChunkTiming({ epochs: [1_000], truncated: false, firstContentEpochMs: null });
  assert.equal(single.itlP50Ms, null);
  assert.equal(single.itlP99Ms, null);
  assert.equal(single.pause2sCount, null);

  const nullSample = aggregateChunkTiming(null);
  assert.equal(nullSample.itlP99Ms, null);
});

test("aggregation computes p50/p99, counts >2s stalls, passes through first content", () => {
  const base = 1_000_000;
  // 1..98 gaps of 10ms, one 3s stall, one 20ms gap → 100 gaps total
  const epochs: number[] = [base];
  for (let i = 0; i < 98; i++) epochs.push(epochs[epochs.length - 1] + 10);
  epochs.push(epochs[epochs.length - 1] + 3_000);
  epochs.push(epochs[epochs.length - 1] + 20);
  const stats = aggregateChunkTiming({
    epochs,
    truncated: false,
    firstContentEpochMs: base + 55.6,
  });
  assert.equal(stats.pause2sCount, 1);
  assert.equal(stats.firstContentAt, base + 56); // rounded
  // 100 gaps sorted: 98×10, 20, 3000 → p50 (rank 50) = 10, p99 (rank 99) = 20
  assert.equal(stats.itlP50Ms, 10);
  assert.equal(stats.itlP99Ms, 20);
});

test("negative gaps from clock skew are skipped, not counted as pauses", () => {
  const stats = aggregateChunkTiming({
    epochs: [1_000, 2_000, 1_500, 2_500],
    truncated: false,
    firstContentEpochMs: null,
  });
  // gaps: +1000, -500 (skipped), +1000
  assert.equal(stats.pause2sCount, 0);
  assert.equal(stats.itlP50Ms, 1000);
});

test("content predicate accepts text/tool/refusal but rejects reasoning placeholders", () => {
  assert.equal(sseChunkCarriesContent(sse({ choices: [{ delta: { content: "hi" } }] })), true);
  const toolCallChunk = sse({ choices: [{ delta: { tool_calls: [{ id: "t1" }] } }] });
  assert.equal(sseChunkCarriesContent(toolCallChunk), true);
  assert.equal(
    sseChunkCarriesContent(sse({ choices: [{ delta: { reasoning_content: "thinking…" } }] })),
    false
  );
  assert.equal(sseChunkCarriesContent(sse({ choices: [{ delta: { reasoning: "…" } }] })), false);

  // Output predicate still counts reasoning (TTFT semantics unchanged).
  assert.equal(
    sseChunkCarriesOutput(sse({ choices: [{ delta: { reasoning_content: "thinking…" } }] })),
    true
  );
});

test("content predicate: Claude thinking delta rejected, text/partial_json accepted", () => {
  assert.equal(
    sseChunkCarriesContent(sse({ type: "content_block_delta", delta: { thinking: "…" } })),
    false
  );
  assert.equal(
    sseChunkCarriesContent(sse({ type: "content_block_delta", delta: { text: "answer" } })),
    true
  );
  assert.equal(
    sseChunkCarriesContent(sse({ type: "content_block_delta", delta: { partial_json: "{" } })),
    true
  );
});

test("content predicate: Responses reasoning-summary delta rejected, output text accepted", () => {
  assert.equal(
    sseChunkCarriesContent(sse({ type: "response.reasoning_summary_text.delta", delta: "…" })),
    false
  );
  assert.equal(sseChunkCarriesContent(sse({ type: "response.output_text.delta", delta: "A" })), true);
});
