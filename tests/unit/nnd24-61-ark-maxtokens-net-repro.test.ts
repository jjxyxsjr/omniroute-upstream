/**
 * nnd.24 ④ — max_tokens 兜网失效复现（2026-09-11 谭婧琳 10:00/10:03 两笔复发）。
 *
 * 生产形态（proxy_logs 实证）：出站 max_tokens=178586（= 客户端 8192 + 注入预算
 * 170394），Ark anthropic 口回 400 "expected a value <= 131072"。nnd.22 #54 的
 * clamp-and-retry 反应块零开火（无 MAX_TOKENS 日志、0.2-0.3s 即终、无重试）。
 *
 * 旧测试（maxtokens-clamp-nnd22.test.ts）只覆盖叶子函数（parser/clamp/learned），
 * 从未驱动 executor 级接线——本文件补上这一层：
 *   - 接线层：claude 形态 body（chatCore 翻译后、executor 收到的形态）× 真实
 *     provider UUID × 真实 400 文案 → 必须重试且第二笔出站钳到 131072。
 *   - 合成层：openai 形态原始 body（8192 + thinking disabled）→ 观察出站值，
 *     确定 178586 的合成点是否在 executor transformRequest 内部。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import {
  __test_resetLearnedMaxTokensCaps,
  parseMaxTokensCeiling,
  recordLearnedMaxTokensCap,
} from "../../open-sse/services/learnedMaxTokensCaps.ts";
import { fitThinkingToMaxTokens } from "../../open-sse/translator/request/openai-to-claude/thinkingBudget.ts";

// nnd.24 ④ 定案样本(2026-09-11 16:05 mitm 抓真 ark 原始响应字节,未 JSON.parse):
// 注意 <= 在原始文本里是 \u003c= ——这正是生产零钳制的根因。
const ARK_RAW_ESCAPED_BODY =
  '{"error":{"code":"InvalidParameter","message":"The parameter `max_tokens` specified in the request is not valid: integer above maximum value, expected a value \\u003c= 131072, but got 139264 instead. Request id: 021789142702058234941bcf51f16e2fd5d0b33793bdac06aa75b","param":"max_tokens","type":"BadRequest"}}';

const PROVIDER = "anthropic-compatible-d70a9997-f802-49b6-92fc-92a60a018fc2";
const MODEL = "ark-code-latest";
const CREDENTIALS = {
  apiKey: "ark-test-key",
  providerSpecificData: {
    prefix: "ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
    nodeName: "火山引擎",
    autoSync: true,
    chatPath: "/v1/messages",
    extraApiKeys: [],
    customUserAgent: "",
    apiKeyHealth: {},
    modelsPath: "/v1/models",
  },
};

const ARK_400 = new Response(
  JSON.stringify({
    error: {
      type: "invalid_request_error",
      message:
        "The parameter `max_tokens` specified in the request is not valid: integer above maximum value, expected a value <= 131072, but got 178586 instead. Request id: 0217889426rz7a2b3f4c5d6e7",
    },
  }),
  { status: 400, headers: { "Content-Type": "application/json" } }
);

const OK_200 = () =>
  new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

/** chatCore 翻译后交给 executor 的 claude 形态 body（9-09/9-11 出站实证形态）。 */
function claudeShapedBody() {
  return {
    model: MODEL,
    system: "You are a helpful assistant.",
    messages: [{ role: "user", content: "回复 OK" }],
    max_tokens: 178586,
    thinking: { type: "enabled", budget_tokens: 170394 },
    stream: true,
  };
}

function withFetchMock(mock: (callIndex: number, url: string, init: RequestInit) => Response) {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body || "{}"));
    calls.push({ url: String(url), body });
    return mock(calls.length - 1, String(url), init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("nnd.24 ④ wiring: claude-shaped 178586 hit by ark 400 must clamp to 131072 and retry once", async () => {
  __test_resetLearnedMaxTokensCaps();
  const mock = withFetchMock((i) => (i === 0 ? ARK_400 : OK_200()));
  try {
    const executor = new DefaultExecutor(PROVIDER);
    await executor.execute({
      model: MODEL,
      body: claudeShapedBody(),
      stream: true,
      credentials: CREDENTIALS,
    });
  } catch {
    // post-retry 解析失败不影响本断言——只看派发行为
  } finally {
    mock.restore();
  }

  assert.equal(mock.calls.length, 2, `expect clamp-and-retry to fire (2 dispatches), got ${mock.calls.length}`);
  assert.equal(mock.calls[0].body.max_tokens, 178586, "first outbound should carry the composed 178586");
  assert.equal(mock.calls[1].body.max_tokens, 131072, "retry outbound must be clamped to the advertised ceiling");
});

test("nnd.24 ④ suppression root cause: raw ark body escapes `<=` as \\u003c= — parser must still find the ceiling", () => {
  // 生产 9-11 两笔穿透的确切形态:反应块拿 clone().text() 原始字节,正则
  // 匹配字面 <=,对 \u003c= 永不命中 → 零钳制零学习静默穿透。
  assert.equal(
    parseMaxTokensCeiling(ARK_RAW_ESCAPED_BODY),
    131072,
    "escaped \\u003c= form must parse (this was the production suppression)"
  );
  // 大写转义变体同样要吃。
  assert.equal(
    parseMaxTokensCeiling(
      "max_tokens not valid, expected a value \\u003C 8192"
    ),
    8191,
    "escaped exclusive form must parse as N-1"
  );
  // 非转义的原有形态不回归。
  assert.equal(
    parseMaxTokensCeiling(
      "The parameter `max_tokens` ... expected a value <= 131072, but got 178586"
    ),
    131072
  );
});

test("nnd.24 ④ wiring (raw escaped 400): executor clamps and retries on the true ark byte shape", async () => {
  __test_resetLearnedMaxTokensCaps();
  const raw400 = () =>
    new Response(ARK_RAW_ESCAPED_BODY, {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  const mock = withFetchMock((i) => (i === 0 ? raw400() : OK_200()));
  try {
    const executor = new DefaultExecutor(PROVIDER);
    await executor.execute({
      model: MODEL,
      body: claudeShapedBody(),
      stream: true,
      credentials: CREDENTIALS,
    });
  } catch {
    // 同上,只看派发行为
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.length, 2, "raw escaped ark 400 must trigger clamp-and-retry");
  assert.equal(mock.calls[1].body.max_tokens, 131072);
});

test("nnd.24 ④ root-fix: learned cap bounds the room+budget composition for cap-less custom nodes", () => {
  __test_resetLearnedMaxTokensCaps();
  // 生产 2026-09-11 10:00 形态：ark 自定义节点无 registry cap，adaptive(high)×1.3
  // 合成 room(8192)+budget(170394)=178586 > ark 131072 → 400。
  const before = fitThinkingToMaxTokens(MODEL, 8192, { type: "enabled", budget_tokens: 170394 }, PROVIDER);
  assert.equal(before.maxTokens, 178586, "without any cap the composition is unbounded (production shape)");

  // 首笔 400 学习到天花板后（#54 recordLearnedMaxTokensCap），合成层必须自己钳住。
  recordLearnedMaxTokensCap(PROVIDER, MODEL, 131072);
  const after = fitThinkingToMaxTokens(MODEL, 8192, { type: "enabled", budget_tokens: 170394 }, PROVIDER);
  assert.ok(
    after.maxTokens <= 131072,
    `composed max_tokens must respect the learned ceiling (got ${after.maxTokens})`
  );
  assert.ok(
    (after.thinking?.budget_tokens ?? 0) >= 1024,
    "thinking budget must stay above the Anthropic floor after fitting"
  );
  __test_resetLearnedMaxTokensCaps();
});
