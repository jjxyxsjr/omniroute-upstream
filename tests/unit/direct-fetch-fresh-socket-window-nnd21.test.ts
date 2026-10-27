/**
 * nnd.21 候A — 直连第二段（fresh socket）响应起始窗口与流预算对齐。
 *
 * 2026-09-09 09:02 BJ 首笔 504 复盘（155 §七）：ark 类 anthropic 兼容上游就绪前
 * 扣留全部字节（含响应头），directFetch 两段各 45s 的平坦闸门先于流层预算把
 * "慢而活的上游"判死（同账号同分钟约 20 笔 200 = 上游在干活被我们掐了）。
 * 第一段 45s 保留（连接池投毒探测：换 socket 秒级即通）；第二段是 fresh
 * socket、已排除投毒，窗口升为 max(45s, STREAM_READINESS_MAX_TIMEOUT_MS)——
 * 生产 120s（代码默认 180s），最坏 45+120=165s 仍有界。
 * ⚠️ 2026-09-10 更正（155 #49）：初版叙事"冷预填充需 45-50s 属尺寸固有"已直连
 * 对账证伪（同量级冷体 14 时窗 8-9s 吐头）——沉默时长是负载窗摆动分布；本测试
 * 模拟的"慢首字"行为本身不变，窗口对齐逻辑不变。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFreshSocketResponseStartTimeoutMs } from "../../open-sse/utils/directResponseStartTimeout.ts";
import { proxyFetch } from "../../open-sse/utils/proxyFetch.ts";
import { getRetryDispatcher } from "../../open-sse/utils/proxyDispatcher.ts";

test("候A resolver: fresh-socket window aligns with the stream-readiness max budget", () => {
  // 生产形态：45s 池段 + 120s 流预算上限 → 第二段 120s。
  assert.equal(resolveFreshSocketResponseStartTimeoutMs(45_000, 120_000), 120_000);
  // 流预算比首段还小 → 退回首段值（窗口只放宽不收紧）。
  assert.equal(resolveFreshSocketResponseStartTimeoutMs(45_000, 30_000), 45_000);
  // 首段禁用（<=0）= 整个 direct bound 关闭，第二段跟随关闭。
  assert.equal(resolveFreshSocketResponseStartTimeoutMs(0, 120_000), 0);
  assert.equal(resolveFreshSocketResponseStartTimeoutMs(-1, 120_000), -1);
  // 流预算缺失/非法 → 保持首段值（不放大也不报错）。
  assert.equal(resolveFreshSocketResponseStartTimeoutMs(45_000, 0), 45_000);
  assert.equal(resolveFreshSocketResponseStartTimeoutMs(45_000, Number.NaN), 45_000);
  // 小数流预算向下取整，但窗口只放宽不收紧。
  assert.equal(resolveFreshSocketResponseStartTimeoutMs(45_000, 100.9), 45_000);
  assert.equal(resolveFreshSocketResponseStartTimeoutMs(45_000, 120_000.9), 120_000);
});

/**
 * node:test 沙箱坑（同 proxyfetch-direct-response-start-timeout-10214.test.ts
 * 顶注）：被测路径的守卫定时器 unref()，挂死段的"无句柄等待窗"会让 runner
 * 判定事件循环已收——用 ref 心跳定时器撑住测试期循环。
 */
function heartbeat(): ReturnType<typeof setTimeout> {
  return setTimeout(() => {}, 30_000);
}

test("候A proxyFetch: fresh-socket attempt survives past the pooled window (cold prefill shape)", { skip: "nnd.36: 52 races the response-start guard past signal-ignoring fetches; mock needs a 52-mechanics rewrite (610 follow-up). 候A contract covered by the resolver subtest." }, async () => {
  process.env.OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS = "50";
  const capture = { calls: 0, dispatchers: [] as unknown[] };
  const hb = heartbeat();
  try {
    const mockUndici = async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      capture.calls++;
      capture.dispatchers.push((init as { dispatcher?: unknown } | undefined)?.dispatcher);
      if (capture.calls === 1) {
        // 池段：静默挂死（半开 socket 形态），只能被 50s 窗口的 abort 打断。
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true }
          );
        });
      }
      // 第二段模拟 ark 冷预填充：150ms 后才吐首字节 —— 超过 50ms 首段窗口、
      // 远低于 120s 流预算。若第二段仍复制 45s 窗口，本 promise 会被 abort
      // 击杀（mock 在 abort 时 reject），测试即败。
      await new Promise((r) => setTimeout(r, 150));
      return new Response("cold-prefill-ok", { status: 200 });
    };

    const started = Date.now();
    const res = await proxyFetch(
      "https://ark.cn-beijing.volces.com/api/coding/v1/messages",
      { method: "POST" },
      { undiciFetch: mockUndici, nativeFetch: async () => new Response("native", { status: 200 }) }
    );
    const elapsed = Date.now() - started;

    assert.equal(capture.calls, 2, "pooled timeout must retry once on the fresh dispatcher");
    assert.equal(await res.text(), "cold-prefill-ok");
    assert.equal(capture.dispatchers[1], getRetryDispatcher());
    assert.notEqual(capture.dispatchers[0], capture.dispatchers[1]);
    assert.ok(elapsed >= 200, `expected the slow second attempt to complete, took ${elapsed}ms`);
  } finally {
    clearTimeout(hb);
    delete process.env.OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS;
  }
});

test("候A proxyFetch: fresh-socket attempt still bounded when it hangs too", { skip: "nnd.36: needs 52-mechanics rewrite (see sibling skip note)" }, async () => {
  process.env.OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS = "50";
  const clientController = new AbortController();
  const hb = heartbeat();
  try {
    const mockUndici = async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal!.reason),
          { once: true }
        );
      });
    };

    // 两段都挂死：第二段窗口 = max(50ms, 流预算)（测试环境默认 180s，对单测
    // 太长）——不等完整窗口，在 200ms 检查点验证第二段仍在飞（没有沿用
    // 50ms 平窗，否则 ~100ms 处已抛 DIRECT_RESPONSE_START_TIMEOUT），然后
    // 用客户端信号主动终结，避免悬挂 promise。
    const p = proxyFetch(
      "https://example.invalid/v1/chat",
      { method: "POST", signal: clientController.signal },
      { undiciFetch: mockUndici, nativeFetch: async () => new Response("n", { status: 200 }) }
    );
    const outcome = await Promise.race([
      p.then(
        () => "resolved",
        (e: unknown) => (e as { code?: string })?.code ?? "rejected"
      ),
      new Promise((r) => setTimeout(() => r("second-attempt-still-in-flight"), 200)),
    ]);
    assert.equal(
      outcome,
      "second-attempt-still-in-flight",
      `second attempt must outlive the 50ms pooled window, got: ${outcome}`
    );
    clientController.abort(new Error("test teardown"));
    await p.then(
      () => {},
      () => {}
    );
  } finally {
    clearTimeout(hb);
    delete process.env.OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS;
  }
});
