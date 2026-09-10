/**
 * nnd.22 ② — max_tokens 上限学习与钳制。
 *
 * 2026-09-09 谭婧琳 17 笔 400 的根因形态（存档实证）：客户端发 max_tokens=178586
 * （ZCode/agent 计算型预算），Ark anthropic 口天花板 131072 直接拒，GLM OpenAI
 * 口容忍同 body。操作员定调"用户感知到就是我们的问题，网关替用户兜住"：400
 * 文案里自带天花板 → 解析、钳制、重试一次、进程级记忆（后续请求预钳制零往返）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __test_resetLearnedMaxTokensCaps,
  clampTopLevelMaxTokens,
  getLearnedMaxTokensCap,
  parseMaxTokensCeiling,
  recordLearnedMaxTokensCap,
} from "../../open-sse/services/learnedMaxTokensCaps.ts";
import { resolveNonStreamTotalBudgetMs } from "../../open-sse/utils/directResponseStartTimeout.ts";

const ARK_INCLUSIVE =
  "[400]: The parameter `max_tokens` specified in the request is not valid: integer above maximum value, expected a value <= 131072, but got 178586 instead. Request id: 0217889426...";
const ARK_EXCLUSIVE =
  "[400]: The parameter `max_tokens` specified in the request are not valid: integer, expected a value < 8192";

test("nnd.22 ② parser: inclusive `<= N` form yields N (Ark live shape)", () => {
  assert.equal(parseMaxTokensCeiling(ARK_INCLUSIVE), 131072);
});

test("nnd.22 ② parser: exclusive `< N` form yields N-1", () => {
  assert.equal(parseMaxTokensCeiling(ARK_EXCLUSIVE), 8191);
});

test("nnd.22 ② parser: non-max_tokens errors and garbage yield null", () => {
  assert.equal(
    parseMaxTokensCeiling(
      "thinking_budget must be in the range [-1, 65535]"
    ),
    null
  );
  assert.equal(parseMaxTokensCeiling("The parameter `tools` is not valid"), null);
  assert.equal(parseMaxTokensCeiling(""), null);
  assert.equal(parseMaxTokensCeiling(null), null);
  assert.equal(parseMaxTokensCeiling(42), null);
});

test("nnd.22 ② clamp: oversized top-level max_tokens clamped, under-cap untouched", () => {
  const body = { model: "x", max_tokens: 178586, stream: true };
  assert.equal(clampTopLevelMaxTokens(body, 131072), true);
  assert.equal(body.max_tokens, 131072);
  const ok = { model: "x", max_tokens: 4096 };
  assert.equal(clampTopLevelMaxTokens(ok, 131072), false);
  assert.equal(ok.max_tokens, 4096);
  const strTok = { model: "x", max_tokens: "16384" };
  assert.equal(clampTopLevelMaxTokens(strTok, 8191), true);
  assert.equal(strTok.max_tokens, 8191);
  assert.equal(clampTopLevelMaxTokens(null, 100), false);
  assert.equal(clampTopLevelMaxTokens([1, 2], 100), false);
  assert.equal(clampTopLevelMaxTokens({}, 100), false);
});

test("nnd.22 ② learned cap: record once, equal-or-lower ceiling wins", () => {
  __test_resetLearnedMaxTokensCaps();
  assert.equal(getLearnedMaxTokensCap("Ark", "Code-Latest"), null);
  recordLearnedMaxTokensCap("Ark", "Code-Latest", 131072);
  assert.equal(getLearnedMaxTokensCap("ark", "code-latest"), 131072);
  recordLearnedMaxTokensCap("ark", "code-latest", 262144);
  assert.equal(getLearnedMaxTokensCap("ARK", "CODE-LATEST"), 131072);
});

test("nnd.22 ① non-stream total budget covers the inner two-segment worst case", () => {
  // 生产形态：45s 池段 + 120s 流预算上限 + 5s 裕量 = 170s。
  assert.equal(resolveNonStreamTotalBudgetMs(45_000, 120_000), 170_000);
  // 流预算小于池段时：fresh=池段，总=2×池段+5s。
  assert.equal(resolveNonStreamTotalBudgetMs(45_000, 30_000), 95_000);
  // 禁用（<=0）跟随关闭。
  assert.equal(resolveNonStreamTotalBudgetMs(0, 120_000), 0);
  assert.equal(resolveNonStreamTotalBudgetMs(-1, 120_000), -1);
  // 流预算非法 → 退回 pooled+pooled+5s（不放大到无界）。
  assert.equal(resolveNonStreamTotalBudgetMs(45_000, Number.NaN), 95_000);
});

test("nnd.22 ② clamp: thinking budget squeezed to keep the anthropic pair valid", () => {
  // 实测形态：客户端 8192 + 网关自适应注入 budget 170394 → 合成 178586 被钳。
  const body = {
    model: "ark/ark-code-latest",
    max_tokens: 178586,
    thinking: { type: "enabled", budget_tokens: 170394 },
  };
  assert.equal(clampTopLevelMaxTokens(body, 131072), true);
  assert.equal(body.max_tokens, 131072);
  assert.equal(body.thinking.budget_tokens, 131072 - 1024);
  // 预算本来就小于钳后上限时不动。
  const small = { max_tokens: 9000, thinking: { type: "enabled", budget_tokens: 4096 } };
  clampTopLevelMaxTokens(small, 8191);
  assert.equal(small.max_tokens, 8191);
  assert.equal(small.thinking.budget_tokens, 4096);
});
