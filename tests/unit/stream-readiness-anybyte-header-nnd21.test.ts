/**
 * nnd.21 候C — glm executor 内层 60s 就绪门的 anyByteAt 信号接线（与 #47 对齐）。
 *
 * nnd.20 #47 让 chat.ts 的换连接门消费 anyByteAt（null=零字节挂死→终止；
 * 数字=有字节慢→保留单次换连接），但该信号只在 chatCore 外层门（chatCore.ts
 * 就绪失败 return）产生；glm executor 内层门（glm.ts executeTransport→
 * ensureStreamReadiness）的失败走合成 504 响应→providerFailure 通用分支，
 * anyByteAt 在边界上丢失（undefined=旧行为=永远换连接）。
 *
 * 接线通道：响应头 X-OmniRoute-Any-Byte-At（"none"=零字节；epoch-ms=有字节）。
 * 选头不选字段的理由：glm 三条转运路径（claude 直通原样返回 / anthropic JSON
 * 翻译 cloneHeaders 保留头 / openai 转运不动）全部保头，而 body 的 error.code
 * 会在 translateAnthropicJsonError 里被丢掉。chatCore providerFailure 读头穿进
 * result.anyByteAt，chat.ts 决策点即获得定义值。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureStreamReadiness,
  ANY_BYTE_AT_HEADER,
  parseAnyByteAtHeader,
} from "../../open-sse/utils/streamReadiness.ts";

const encoder = new TextEncoder();

function neverBytesStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start() {
      await new Promise(() => {});
    },
  });
}

function pingThenSilentStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(": keepalive\n\n"));
      await new Promise(() => {});
    },
  });
}

test("候C header parse: none → null, epoch → number, absent → undefined, garbage → undefined", () => {
  assert.equal(parseAnyByteAtHeader("none"), null);
  assert.equal(parseAnyByteAtHeader("1773261600000"), 1773261600000);
  assert.equal(parseAnyByteAtHeader(null), undefined);
  assert.equal(parseAnyByteAtHeader(""), undefined);
  assert.equal(parseAnyByteAtHeader("not-a-number"), undefined);
  assert.equal(parseAnyByteAtHeader("-1"), undefined);
});

test("候C: zero-byte readiness timeout response carries anyByteAt=none header", async () => {
  const result = await ensureStreamReadiness(
    new Response(neverBytesStream(), { status: 200 }),
    { timeoutMs: 80, provider: "glm-cn", model: "glm-5.3" }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "STREAM_READINESS_TIMEOUT");
  const header = result.response.headers.get(ANY_BYTE_AT_HEADER);
  assert.equal(header, "none");
  assert.equal(parseAnyByteAtHeader(header), null);
});

test("候C: ping-only timeout response carries the byte-arrival epoch in the header", async () => {
  const t0 = Date.now();
  const result = await ensureStreamReadiness(
    new Response(pingThenSilentStream(), { status: 200 }),
    { timeoutMs: 120, provider: "glm-cn", model: "glm-5.3" }
  );
  assert.equal(result.ok, false);
  const parsed = parseAnyByteAtHeader(result.response.headers.get(ANY_BYTE_AT_HEADER));
  assert.ok(typeof parsed === "number", `expected number, got ${parsed}`);
  assert.ok(parsed! >= t0 && parsed! <= Date.now() + 50);
});

test("候C: early-EOF failure also carries the header (uniform signal)", async () => {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(": ping\n\n"));
      controller.close();
    },
  });
  const result = await ensureStreamReadiness(new Response(stream, { status: 200 }), {
    timeoutMs: 200,
    provider: "glm-cn",
    model: "glm-5.3",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "STREAM_EARLY_EOF");
  assert.ok(result.response.headers.get(ANY_BYTE_AT_HEADER) !== null);
});

test("候C: successful readiness responses stay header-free", async () => {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`
        )
      );
      controller.close();
    },
  });
  const result = await ensureStreamReadiness(new Response(stream, { status: 200 }), {
    timeoutMs: 500,
    provider: "glm-cn",
    model: "glm-5.3",
  });
  assert.equal(result.ok, true);
  assert.equal(result.response.headers.get(ANY_BYTE_AT_HEADER), null);
});
