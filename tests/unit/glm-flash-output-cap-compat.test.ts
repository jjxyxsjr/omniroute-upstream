/**
 * Regression (2026-08-27 incident): a ZCode client sends max_tokens=131072
 * (its 128 Ki ceiling) at the `pro` combo whose only target is
 * `glm-cn/glm-5.3-flash`. The registry recorded maxOutputTokens: 128000 (a
 * decimal reading of Zhipu's "128K"), so the combo capability filter
 * hard-dropped the only target (output_tokens) and returned a 400
 * capability_mismatch whose message misleadingly said "structured output".
 *
 * Zhipu documents GLM-5.3 / GLM-5.3-Flash / GLM-5.2 with the same "128K" max
 * output, flash's text params are identical to GLM-5.3
 * (https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash), and the live
 * endpoint accepts max_tokens=131072 on glm-cn/glm-5.3 (19x HTTP 200 observed
 * 2026-08-27). The codebase's own convention for the GLM "128K" is 131072
 * (glm-5.2/5.3 registry+spec entries, and GlmExecutor's thinking-model
 * max_tokens default), so flash must match 131072.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Deterministic, isolated storage so capability resolution sees NO synced data
// and exercises the registry/spec path only.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-glm-flash-cap-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");
const { describeCapabilityFilterExhaustion, filterTargetsByRequestCompatibility } = await import(
  "../../open-sse/services/combo/comboStructure.ts"
);

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function target(modelStr: string) {
  return {
    kind: "model" as const,
    stepId: modelStr,
    executionKey: modelStr,
    modelStr,
    provider: modelStr.includes("/") ? modelStr.split("/")[0] : modelStr,
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  };
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

test("glm-5.3-flash advertises the same 131072 output ceiling as the rest of the GLM 128K family", () => {
  const flash = getResolvedModelCapabilities("glm-cn/glm-5.3-flash");
  const base = getResolvedModelCapabilities("glm-cn/glm-5.3");
  assert.equal(flash.maxOutputTokens, 131_072, "flash must match the GLM 128K convention");
  assert.equal(base.maxOutputTokens, 131_072);
});

test("a maxed-out agentic request (max_tokens=131072) is NOT hard-rejected for glm-5.3-flash", () => {
  // Shape of the 2026-08-27 incident requests: ZCode turn with tools and
  // max_tokens pinned to its 128 Ki ceiling, no response_format anywhere.
  const body = {
    model: "pro",
    max_tokens: 131_072,
    stream: true,
    messages: [{ role: "user", content: "hello" }],
    tools: [
      { type: "function", function: { name: "Task", description: "run a subagent", parameters: {} } },
    ],
  };

  const kept = filterTargetsByRequestCompatibility(
    [target("glm-cn/glm-5.3-flash")],
    body,
    noopLog
  );
  assert.deepEqual(
    kept.map((t) => t.modelStr),
    ["glm-cn/glm-5.3-flash"],
    "the only combo target must survive the capability filter"
  );
  assert.equal(
    describeCapabilityFilterExhaustion([target("glm-cn/glm-5.3-flash")], body, "pro"),
    null,
    "no capability exhaustion => no 400 capability_mismatch"
  );
});
