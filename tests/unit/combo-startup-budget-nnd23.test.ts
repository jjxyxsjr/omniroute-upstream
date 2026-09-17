/**
 * nnd.23 ① — 启动预算唤醒：让休眠的轮换截断机制对所有组合默认生效。
 *
 * 背景：上游已有完整机制——comboTimeoutMs 驱动"elapsed≥值则不再开新席位轮"
 * 与双路 loop safety，但默认 0=截断休眠、safety 落到 10 分钟钝刀；黄雄飞零点
 * 303 秒（3 席×~90s）就是"预算无人认领"的形态。本批：env 兜底默认 240s 唤醒
 * 截断（per-combo config 仍优先、显式 0 关闭），且 safety 地板保持 10 分钟
 * （Math.max）——预算只收缩"轮换"，绝不杀害在途的合法长生成。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleComboChat } from "../../open-sse/services/combo.ts";
import { resolveComboStartupBudgetMs } from "../../open-sse/services/combo/comboPredicates.ts";
import { resetAllCircuitBreakers } from "../../src/shared/utils/circuitBreaker.ts";

const textEncoder = new TextEncoder();

function createLog() {
  const entries: { level: string; tag: string; msg: string }[] = [];
  return {
    info: (tag: string, msg: string) => entries.push({ level: "info", tag, msg }),
    warn: (tag: string, msg: string) => entries.push({ level: "warn", tag, msg }),
    error: (tag: string, msg: string) => entries.push({ level: "error", tag, msg }),
    debug: (tag: string, msg: string) => entries.push({ level: "debug", tag, msg }),
    entries,
  };
}

function okStreamResponse(content: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        textEncoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content } }] })}\n\n`
        )
      );
      controller.enqueue(textEncoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function error504(): Response {
  return new Response(
    JSON.stringify({
      error: { message: "upstream unavailable", code: "UPSTREAM_ERROR", type: "server_error" },
    }),
    { status: 504, headers: { "Content-Type": "application/json" } }
  );
}

test("nnd.23 ① resolver: default 240s / env override / clamp / zero-off / invalid", () => {
  assert.equal(resolveComboStartupBudgetMs({}), 240_000);
  assert.equal(resolveComboStartupBudgetMs({ OMNIROUTE_COMBO_STARTUP_BUDGET_MS: "300000" }), 300_000);
  assert.equal(resolveComboStartupBudgetMs({ OMNIROUTE_COMBO_STARTUP_BUDGET_MS: "10" }), 60_000); // 下限
  assert.equal(
    resolveComboStartupBudgetMs({ OMNIROUTE_COMBO_STARTUP_BUDGET_MS: "9999999" }),
    600_000
  ); // 上限
  assert.equal(resolveComboStartupBudgetMs({ OMNIROUTE_COMBO_STARTUP_BUDGET_MS: "0" }), 0); // 显式关闭
  assert.equal(resolveComboStartupBudgetMs({ OMNIROUTE_COMBO_STARTUP_BUDGET_MS: "abc" }), 240_000);
});

test("nnd.23 ① combo: rotation cutoff stops new seat rounds once the budget elapses", async () => {
  await resetAllCircuitBreakers();
  const calls: string[] = [];
  const log = createLog();
  const result = await handleComboChat({
    body: { stream: true, messages: [{ role: "user", content: "hello" }] },
    combo: {
      name: "startup-budget-cutoff",
      strategy: "priority",
      models: [
        { model: "glm/slow-fail", weight: 0 },
        { model: "openai/never-reached", weight: 0 },
      ],
      config: {
        maxRetries: 0,
        retryDelayMs: 0,
        comboTimeoutMs: 120, // 预算 120ms：第一个席位 200ms 后才失败，届时不再开第二轮
      },
    },
    handleSingleModel: async (_body: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      if (modelStr === "glm/slow-fail") {
        await new Promise((r) => setTimeout(r, 200));
        return error504();
      }
      throw new Error("second seat must never dispatch — budget already exhausted");
    },
    isModelAvailable: async () => true,
    log,
  } as Parameters<typeof handleComboChat>[0]);
  assert.deepEqual(calls, ["glm/slow-fail"]);
  const text = await result.text();
  assert.match(text, /timeout|504|unavailable/i);
});

test("nnd.23 ① combo: budget does not touch a fast first seat (no regression)", async () => {
  await resetAllCircuitBreakers();
  const calls: string[] = [];
  const log = createLog();
  const result = await handleComboChat({
    body: { stream: true, messages: [{ role: "user", content: "hello" }] },
    combo: {
      name: "startup-budget-fast-path",
      strategy: "priority",
      models: [{ model: "glm/fast", weight: 0 }],
      config: { maxRetries: 0, retryDelayMs: 0, comboTimeoutMs: 240_000 },
    },
    handleSingleModel: async (_body: Record<string, unknown>, modelStr: string) => {
      calls.push(modelStr);
      return okStreamResponse("budget untouched on success");
    },
    isModelAvailable: async () => true,
    log,
  } as Parameters<typeof handleComboChat>[0]);
  assert.deepEqual(calls, ["glm/fast"]);
  const text = await result.text();
  assert.match(text, /budget untouched on success/);
});
