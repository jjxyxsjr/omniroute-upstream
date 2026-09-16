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
    [{ OMNIROUTE_FORCE_UPSTREAM_STREAM: "yes" }, false, "non-canonical → off (strict)"],
  ];
  for (const [env, expected, name] of cases) {
    test(name, () => {
      assert.equal(resolveForceUpstreamStreaming(env), expected);
    });
  }
});

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
    assert.match(
      source,
      /readNonStreamingResponseBody\(\s*rawResult\.response,\s*contentType,\s*upstreamStream\s*\)/
    );
  });
});
