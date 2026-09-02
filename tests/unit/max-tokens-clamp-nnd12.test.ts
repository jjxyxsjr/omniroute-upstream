/**
 * 011 (nnd.12) — clamp oversized max_tokens to the model's output cap instead
 * of hard-dropping the target. Before: a request with max_tokens above the
 * registered ceiling (e.g. 200000 vs glm-5.3-flash's 131072) got its only
 * combo target filtered out (output_tokens hard-compat failure) and surfaced
 * a 400 capability_mismatch — the request could have been served with the
 * ceiling. Now: the capability filter keeps the target, and the request
 * translators clamp max_tokens to the resolved cap (same shape the Gemini and
 * Kiro translators already use). High-cap models (ark 1M non-thinking lanes)
 * are unaffected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mtclamp-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { filterTargetsByRequestCompatibility } = await import(
  "../../open-sse/services/combo/comboStructure.ts"
);
const { claudeToOpenAIRequest } = await import(
  "../../open-sse/translator/request/claude-to-openai.ts"
);
const { openaiToClaudeRequest } = await import(
  "../../open-sse/translator/request/openai-to-claude.ts"
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

test("011 an oversized max_tokens no longer hard-drops the only target", () => {
  const body = {
    model: "pro",
    max_tokens: 200_000,
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  };
  const kept = filterTargetsByRequestCompatibility(
    [target("glm-cn/glm-5.3-flash")],
    body,
    noopLog
  );
  assert.deepEqual(
    kept.map((t) => t.modelStr),
    ["glm-cn/glm-5.3-flash"],
    "the target survives — the translator clamps instead of the filter rejecting"
  );
});

test("011 claude→openai clamps max_tokens to the resolved cap", () => {
  const result = claudeToOpenAIRequest(
    "glm-5.3-flash",
    {
      model: "glm-5.3-flash",
      max_tokens: 200_000,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    },
    false
  );
  assert.equal(result.max_tokens, 131_072, "clamped to the registered 128K cap");
});

test("011 claude→openai keeps max_tokens untouched when no cap is known", () => {
  const result = claudeToOpenAIRequest(
    "totally-unknown-model-xyz",
    {
      model: "totally-unknown-model-xyz",
      max_tokens: 987_654,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    },
    false
  );
  assert.equal(result.max_tokens, 987_654, "no registered cap => passthrough (current behavior)");
});

test("011 openai→claude clamps max_tokens to the resolved cap", () => {
  const result = openaiToClaudeRequest(
    "glm-5.3-flash",
    {
      model: "glm-5.3-flash",
      max_tokens: 200_000,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    },
    false
  );
  assert.equal(result.max_tokens, 131_072, "clamped to the registered 128K cap");
});
