/**
 * nnd.12 — admission skips inside the combo loops must log as structured
 * warns, not bare info strings. When a per-target admission lane is full the
 * skip is the gateway actively shedding load (#9654); a bare info line with no
 * combo/model/queue context made 503 storms invisible in log triage (the
 * original nnd.12 backlog item pointed at the combo admission paths).
 *
 * ⚠️ source-guard 式测试（grep 实现文本）：豁免理由——断言对象是日志调用的
 * 接线形态（warn 级别 + 结构化字段），combo 循环内无导出缝可直测；上游重构
 * 搬动该代码块时需同步跟进本文件。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// nnd.31: the 51 decomposition moved the two admission-skip blocks out of the
// combo.ts monolith into executeTargetGates.ts (strategy path) and
// roundRobinCombo.ts (RR path). Guard both new homes.
const sources = [
  "open-sse/services/combo/executeTargetGates.ts",
  "open-sse/services/combo/roundRobinCombo.ts",
];

test("strategy-path admission skip logs a structured warn with reason and code", () => {
  const source = fs.readFileSync(sources[0], "utf8");
  const idx = source.indexOf("Skipping ${modelStr} — admission lane full");
  assert.ok(idx > 0, "admission skip message present");
  const before = source.lastIndexOf("log.", idx);
  assert.ok(source.slice(before, before + 9).endsWith("warn("), "skip must be a warn, not info");
  // The warn call carries a structured object after the message.
  const callEnd = source.indexOf(");", idx);
  const callBody = source.slice(before, callEnd);
  assert.ok(callBody.includes('reason: "admission_lane"'), "carries the reason key");
  assert.ok(
    /code:\s*"chat_admission_busy"|code:\s*"admission_lane"/.test(callBody),
    "carries a machine-readable code"
  );
});

test("round-robin admission skip logs the same structured warn", () => {
  const source = fs.readFileSync(sources[1], "utf8");
  const idx = source.indexOf("Skipping ${modelStr} — admission lane full");
  assert.ok(idx > 0, "RR skip present");
  const before = source.lastIndexOf("log.", idx);
  assert.ok(source.slice(before, before + 9).endsWith("warn("), "RR skip must be a warn");
  const callEnd = source.indexOf(");", idx);
  const callBody = source.slice(before, callEnd);
  assert.ok(callBody.includes('reason: "admission_lane"'), "carries the reason key");
});
