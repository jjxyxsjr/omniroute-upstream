/**
 * nnd.21 候B — executeWithUpstreamStartTimeout 竞速输家 Promise 泄漏封堵。
 *
 * 2026-09-09 01:03:56Z 生产实录（155 §七候B）：DIRECT_RESPONSE_START_TIMEOUT
 * 的 TimeoutError 经 abort reason 流入外层 REQUEST_TIMEOUT(900s) 兜底竞速的
 * abortPromise（Promise.race 输家）——race 已由 execute() 的 reject 定局，
 * abortPromise 的监听器却在 finally 里从不摘除；外层 signal 一旦 abort（请求
 * 清理/客户端断开），该输家以同一 reason 再 reject 一次且无人接 →
 * unhandledRejection（Next 全局处理器兜住才没伤进程）。
 *
 * 修复三件：①abortPromise 监听器命名并在 finally 摘除；②race 定局后对两个
 * 输家 Promise 挂 catch 沉洞（迟到 rejection 一律吞掉）；③base.ts 的
 * TimeoutError 日志改打真实 err.message（旧文案写死 "Fetch timeout after
 * ${configured}ms"，45s 直连超时被误报成 900000ms）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeWithUpstreamStartTimeout } from "../../open-sse/handlers/chatCore/upstreamTimeouts.ts";

/** 捕获 unhandledRejection 的测试护栏：任何泄漏即测试失败。 */
function trackUnhandledRejections() {
  const seen: unknown[] = [];
  const handler = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", handler);
  return {
    seen,
    async drain(ms = 120) {
      await new Promise((r) => setTimeout(r, ms));
      return seen;
    },
    cleanup() {
      process.off("unhandledRejection", handler);
    },
  };
}

const fakeExecutor = { getTimeoutMs: () => 600_000 };

test("候B: loser abortPromise rejection after the race settled is swallowed (no unhandledRejection)", async () => {
  const tracker = trackUnhandledRejections();
  try {
    const controller = new AbortController();
    const directError = Object.assign(
      new Error("Direct response did not start within 45000ms — retrying on a fresh socket"),
      { name: "TimeoutError", code: "DIRECT_RESPONSE_START_TIMEOUT" }
    );

    // execute() 先以 45s 直连错误 reject —— race 定局，错误向上传播（合法路径）。
    const attempt = executeWithUpstreamStartTimeout({
      executor: fakeExecutor,
      provider: "anthropic-compatible-x",
      model: "ark-code-latest",
      connectionTimeoutMs: 600_000,
      signal: controller.signal,
      log: null,
      execute: () => Promise.reject(directError),
    });
    await assert.rejects(attempt, (e: unknown) => e === directError);

    // 事后外层 signal 才 abort（请求清理），abort reason = 同一个直连超时错误
    // ——修前这会点燃无人接的 abortPromise。
    controller.abort(directError);

    const leaked = await tracker.drain(150);
    assert.deepEqual(
      leaked,
      [],
      `expected no unhandledRejection, got: ${leaked.map(String).join(" | ")}`
    );
  } finally {
    tracker.cleanup();
  }
});

test("候B: loser timeoutPromise rejection after the race settled is swallowed", async () => {
  const tracker = trackUnhandledRejections();
  try {
    const controller = new AbortController();
    // execute() 先成功返回 —— race 定局；timeoutPromise 的 60ms 定时器随后仍会
    // reject（修前同样无人接）。
    const result = await executeWithUpstreamStartTimeout({
      executor: fakeExecutor,
      provider: "anthropic-compatible-x",
      model: "ark-code-latest",
      connectionTimeoutMs: 60,
      signal: controller.signal,
      log: null,
      execute: async () => "ok-fast",
    });
    assert.equal(result, "ok-fast");

    const leaked = await tracker.drain(200);
    assert.deepEqual(
      leaked,
      [],
      `expected no unhandledRejection, got: ${leaked.map(String).join(" | ")}`
    );
  } finally {
    tracker.cleanup();
  }
});

test("候B 回归: pre-aborted signal still fails fast with the abort reason", async () => {
  const controller = new AbortController();
  const reason = new Error("client went away");
  controller.abort(reason);
  await assert.rejects(
    executeWithUpstreamStartTimeout({
      executor: fakeExecutor,
      provider: "anthropic-compatible-x",
      model: "ark-code-latest",
      connectionTimeoutMs: 60,
      signal: controller.signal,
      log: null,
      execute: () => new Promise(() => {}),
    }),
    (e: unknown) => e === reason
  );
});

test("候B 回归: genuine timeout still surfaces the upstream-start timeout error", async () => {
  const tracker = trackUnhandledRejections();
  try {
    const controller = new AbortController();
    await assert.rejects(
      executeWithUpstreamStartTimeout({
        executor: fakeExecutor,
        provider: "anthropic-compatible-x",
        model: "ark-code-latest",
        connectionTimeoutMs: 50,
        signal: controller.signal,
        log: null,
        execute: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      }),
      (e: unknown) => {
        const err = e as { name?: string; message?: string };
        return err.name === "TimeoutError" && /did not return response headers/.test(err.message ?? "");
      }
    );
    const leaked = await tracker.drain(100);
    assert.deepEqual(leaked, []);
  } finally {
    tracker.cleanup();
  }
});
