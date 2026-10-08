/**
 * Crash-storm breaker（nnd.25 —— 9-8 停摆悬案的源码面根治）。
 *
 * 病理实证：2026-09-08 BJ 12-13 时 undefined.bind ×445 笔/35 分钟全道快败，
 * provider 熔断因 #12233（本机执行错误排除）+ pre-#12360（已成形 5xx 不计）
 * 两处刻意留白而全程未动——本件按 provider×归一化签名兜住该类风暴。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  recordCrashFailure,
  isCrashStorming,
  crashStormStatus,
  resetCrashStormBreaker,
  normalizeCrashSignature,
} from "../../open-sse/services/crashStormBreaker.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("normalizeCrashSignature collapses volatile hex/digit runs so id drift keeps one key", () => {
  const a =
    "[502]: [anthropic-compatible-f1f61e6c-6da9-4676-96f6-1d025476a37c/tc-code-latest] upstream failed after 12345ms";
  const b =
    "[502]: [anthropic-compatible-9c2b7d31aa-1111-2222-3333-444455556666/tc-code-latest] upstream failed after 999ms";
  assert.equal(normalizeCrashSignature(a), normalizeCrashSignature(b));
  // 9-8 主伤形态：无 id 纯文本，原样成键
  const bomb = "Cannot read properties of undefined (reading 'bind')";
  assert.equal(normalizeCrashSignature(bomb), bomb);
  assert.equal(normalizeCrashSignature(null), "");
  assert.equal(normalizeCrashSignature("   "), "");
});

test("threshold trip: 10 same-signature 5xx in window storms, 9 does not", () => {
  resetCrashStormBreaker();
  for (let i = 0; i < 9; i++)
    recordCrashFailure("glm", "Cannot read properties of undefined (reading 'bind')", 502);
  assert.equal(isCrashStorming("glm"), false);
  recordCrashFailure("glm", "Cannot read properties of undefined (reading 'bind')", 502);
  assert.equal(isCrashStorming("glm"), true);
});

test("per-provider isolation: storming glm does not trip ark", () => {
  resetCrashStormBreaker();
  for (let i = 0; i < 12; i++) recordCrashFailure("glm", "boom", 502);
  assert.equal(isCrashStorming("glm"), true);
  assert.equal(isCrashStorming("ark"), false);
});

test("only 5xx count — 429/403/400 never feed the breaker", () => {
  resetCrashStormBreaker();
  for (let i = 0; i < 50; i++) recordCrashFailure("glm", "rate limited", 429);
  for (let i = 0; i < 50; i++) recordCrashFailure("glm", "forbidden", 403);
  assert.equal(isCrashStorming("glm"), false);
});

test("window decay: storm clears after the window drains", async () => {
  resetCrashStormBreaker();
  process.env.OMNIROUTE_CRASH_STORM_WINDOW_MS = "120";
  try {
    for (let i = 0; i < 10; i++) recordCrashFailure("glm", "boom", 502);
    assert.equal(isCrashStorming("glm"), true);
    await new Promise((r) => setTimeout(r, 180));
    assert.equal(isCrashStorming("glm"), false, "窗口衰减后应自愈");
  } finally {
    delete process.env.OMNIROUTE_CRASH_STORM_WINDOW_MS;
  }
});

test("env threshold 0 disables recording entirely", () => {
  resetCrashStormBreaker();
  process.env.OMNIROUTE_CRASH_STORM_THRESHOLD = "0";
  try {
    for (let i = 0; i < 100; i++) recordCrashFailure("glm", "boom", 502);
    assert.equal(isCrashStorming("glm"), false);
  } finally {
    delete process.env.OMNIROUTE_CRASH_STORM_THRESHOLD;
  }
});

test("crashStormStatus surfaces active entries for diagnostics", () => {
  resetCrashStormBreaker();
  for (let i = 0; i < 10; i++)
    recordCrashFailure("glm", "Cannot read properties of undefined (reading 'bind')", 502);
  const status = crashStormStatus();
  const entry = status.find((s) => s.provider === "glm");
  assert.ok(entry, JSON.stringify(status));
  assert.equal(entry!.count, 10);
  assert.match(entry!.signature, /reading 'bind'/);
});

// 50 线回迁注记：51 起 #12746 把 executeTarget 拆成 executeTargetGates.ts（可直调单测）；
// 50 线闸体是 combo.ts executeTarget 闭包，无导出缝——接线行为由本守卫 + 旁路容器实弹覆盖
// （trial 内低阈值 env + 死上游打穿 skip 日志），模块行为由上方 8 个直测全覆盖。
test("source guard: 50-line wiring — chatCore hook + combo.ts executeTarget gate + decisionTrace reason", () => {
  const src = readFileSync(join(root, "open-sse", "handlers", "chatCore.ts"), "utf8");
  const pfStart = src.indexOf("providerFailure: if (!providerResponse.ok)");
  assert.ok(pfStart >= 0, "providerFailure block not found");
  const pfEnd = src.indexOf("break providerFailure", pfStart);
  assert.ok(pfEnd > pfStart);
  const block = src.slice(pfStart, pfEnd);
  assert.match(block, /recordCrashFailure\(/);

  const combo = readFileSync(
    join(root, "open-sse", "services", "combo", "executeTargetGates.ts"),
    "utf8"
  );
  const gateStart = combo.indexOf("isCrashStorming(provider)");
  assert.ok(gateStart >= 0, "crash-storm gate not found in executeTargetGates");
  const gateRegion = combo.slice(Math.max(0, gateStart - 400), gateStart + 600);
  assert.match(gateRegion, /isCrashStorming\(/);
  assert.match(gateRegion, /"crash_storm"/);
  assert.match(gateRegion, /stopProtectedPriorityTarget\(/);

  // 喂点（主河道）：51 拆分后 crash 失败在 chatCore 的 providerFailure 块里
  // recordCrashFailure(provider,...) 收口。验证该调用存在且位于 providerFailure
  // 块（4695 起）到其结束标记之间。
  const pfBlockStart = src.indexOf("providerFailure: if (!providerResponse.ok)");
  const feedCall = src.indexOf("recordCrashFailure(provider,", pfBlockStart);
  assert.ok(feedCall > pfBlockStart, "feed hook call not found inside providerFailure block");
  const afterFeed = src.indexOf("break providerFailure", feedCall);
  assert.ok(afterFeed > feedCall, "providerFailure block must close after feed hook");

  const trace = readFileSync(
    join(root, "open-sse", "services", "combo", "decisionTrace.ts"),
    "utf8"
  );
  assert.match(trace, /"crash_storm"/);
});
