// #80 (nnd.27): default-on upstream streaming for non-stream client requests.
// Design doc: deploy/docs/159-nonstream-upstream-streaming-design.md.
// Env truth table for the resolver + source guards that the chatCore wiring
// (upstreamStream OR-chain, codex-compact exemption, SSE-drain anchor) stays
// in place — the drain-and-convert behavior itself is covered by the upstream
// cline forceStream test family.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveForceUpstreamStreaming } from "../../open-sse/handlers/chatCore/forceUpstreamStreaming.ts";

describe("#80 resolveForceUpstreamStreaming env truth table", () => {
  const cases: Array<[Record<string, string | undefined>, boolean, string]> = [
    [{}, true, "unset → on (default)"],
    [{ OMNIROUTE_FORCE_UPSTREAM_STREAM: "" }, true, "empty → on"],
    [{ OMNIROUTE_FORCE_UPSTREAM_STREAM: "   " }, true, "blank → on"],
    [{ OMNIROUTE_FORCE_UPSTREAM_STREAM: "1" }, true, "1 → on"],
    [{ OMNIROUTE_FORCE_UPSTREAM_STREAM: "true" }, true, "true → on"],
    [{ OMNIROUTE_FORCE_UPSTREAM_STREAM: "TRUE" }, true, "case-insensitive"],
    [{ OMNIROUTE_FORCE_UPSTREAM_STREAM: "0" }, false, "0 → off (kill switch)"],
    [{ OMNIROUTE_FORCE_UPSTREAM_STREAM: "false" }, false, "false → off"],
    [{ OMNIROUTE_FORCE_UPSTREAM_STREAM: "off" }, false, "off → off"],
    [{ OMNIROUTE_FORCE_UPSTREAM_STREAM: "yes" }, true, "non-canonical → 回落默认 ON（nnd.18 非法值回落+告警）"],
  ];
  for (const [env, expected, name] of cases) {
    test(name, () => {
      assert.equal(resolveForceUpstreamStreaming(env), expected);
    });
  }
});

// ⚠️ source-guard 式测试（grep 实现文本）：豁免理由——#80 的接线点是 chatCore 内
// 的布尔 OR 表达式，无导出缝；crash-storm 模式（拆模块后转直测）是它的退役路径。
describe("#80 chatCore wiring source guards", () => {
  const source = readFileSync(
    new URL("../../open-sse/handlers/chatCore.ts", import.meta.url),
    "utf8"
  );

  test("upstreamStream OR-chain carries the #80 condition", () => {
    assert.match(
      source,
      /const upstreamStream =\s*stream \|\| isClaudeCodeCompatible \|\| providerRequiresStreaming \|\|\s*forceUpstreamStreaming;/
    );
  });

  test("force flag resolves from env and exempts codex compact passthrough", () => {
    assert.match(
      source,
      /const forceUpstreamStreaming =\s*resolveForceUpstreamStreaming\(\) &&\s*!\(nativeCodexPassthrough && isCompactResponsesEndpoint\(endpointPath\)\);/
    );
  });

  test("helper imported from its module", () => {
    assert.match(
      source,
      /import \{ resolveForceUpstreamStreaming \} from "\.\/chatCore\/forceUpstreamStreaming\.ts";/
    );
  });

  test("non-stream drain still keys off upstreamStream (cline mechanism anchor)", () => {
    // The client non-stream branch must keep passing upstreamStream into the
    // SSE-draining body reader — forcing stream without this anchor would leak
    // raw SSE to JSON clients.
    // nnd.36 (52 merge): the drain call moved from the chatCore barrel into
    // chatCore/executeProviderRequest.ts (upstream decomposition) — guard the
    // leaf instead; the semantic anchor (upstreamStream as the 3rd arg) is
    // unchanged.
    const leaf = readFileSync(
      new URL("../../open-sse/handlers/chatCore/executeProviderRequest.ts", import.meta.url),
      "utf8"
    );
    assert.match(
      leaf,
      /readNonStreamingResponseBody\(\s*rawResult\.response,\s*contentType,\s*upstreamStream\s*\)/
    );
  });
});

describe("#80b claude-body stream alignment (DefaultExecutor)", () => {
  const source = readFileSync(
    new URL("../../open-sse/executors/default.ts", import.meta.url),
    "utf8"
  );

  test("transformRequest stamps executor stream on claude-format bodies", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
    const exec = new DefaultExecutor("anthropic-compatible-test");
    const claudeBody = {
      model: "m",
      max_tokens: 128,
      stream: false, // client flag carried by translation — the 2026-09-16 trial catch
      messages: [{ role: "user", content: "hi" }],
    };
    const out = exec.transformRequest("m", claudeBody, true, null) as Record<string, unknown>;
    assert.equal(out.stream, true, "executor stream=true must overwrite the stale client flag");
    const outOff = exec.transformRequest("m", claudeBody, false, null) as Record<string, unknown>;
    assert.equal(outOff.stream, false, "stream=false stays false (kill-switch parity)");
  });

  test("source guard: claude stamp keyed on requestFormat", () => {
    assert.match(source, /requestFormat === "claude"[\s\S]{0,400}withDefaults = \{ \.\.\.\(withDefaults as Record<string, unknown>\), stream \};/);
  });
});
