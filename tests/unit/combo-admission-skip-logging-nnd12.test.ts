/**
 * nnd.12 — admission skips inside the combo loops must log as structured
 * warns, not bare info strings. When a per-target admission lane is full the
 * skip is the gateway actively shedding load (#9654); a bare info line with no
 * combo/model/queue context made 503 storms invisible in log triage (the
 * original nnd.12 backlog item pointed at the combo admission paths).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("open-sse/services/combo.ts", "utf8");

test("strategy-path admission skip logs a structured warn with reason and code", () => {
  const idx = source.indexOf("Skipping ${modelStr} — admission lane full");
  assert.ok(idx > 0, "admission skip message present");
  const before = source.lastIndexOf("log.", idx);
  assert.equal(
    source.slice(before, before + 9),
    "log.warn(",
    "skip must be a warn, not info"
  );
  // The warn call carries a structured object after the message.
  const callEnd = source.indexOf(");", idx);
  const callBody = source.slice(before, callEnd);
  assert.ok(callBody.includes("reason: \"admission_lane\""), "carries the reason key");
  assert.ok(
    /code:\s*"chat_admission_busy"|code:\s*"admission_lane"/.test(callBody),
    "carries a machine-readable code"
  );
});

test("round-robin admission skip logs the same structured warn", () => {
  const first = source.indexOf("Skipping ${modelStr} — admission lane full");
  const second = source.indexOf("Skipping ${modelStr} — admission lane full", first + 1);
  assert.ok(second > 0, "RR twin present");
  const before = source.lastIndexOf("log.", second);
  assert.equal(source.slice(before, before + 9), "log.warn(", "RR skip must be a warn");
  const callEnd = source.indexOf(");", second);
  const callBody = source.slice(before, callEnd);
  assert.ok(callBody.includes("reason: \"admission_lane\""), "carries the reason key");
});
