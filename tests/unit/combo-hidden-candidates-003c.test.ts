// 003c (2026-08-25): with OMNIROUTE_KEEP_HIDDEN_COMBO_CANDIDATES=1, hiding a
// model in the dashboard must NOT remove it as a NAMED combo target — hidden
// becomes pure catalog visibility (kills the /v1/models tail-item trap while
// keeping the fallback serving, deploy docs/060 2026-08-25). Default behavior
// (flag unset) is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-003c-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { filterVisibleComboTargets } = await import(
  "../../open-sse/services/combo/comboStructure.ts"
);
const modelsDb = await import("../../src/lib/db/models.ts");
const core = await import("../../src/lib/db/core.ts");

const PROVIDER = "anthropic-compatible-test-003c";
await modelsDb.replaceCustomModels(PROVIDER, [
  { id: "hidden-model", name: "hidden-model", source: "manual", isHidden: true },
  { id: "visible-model", name: "visible-model", source: "manual", isHidden: false },
]);

const mk = (model: string) =>
  ({
    executionKey: `${PROVIDER}/${model}`,
    provider: PROVIDER,
    providerId: PROVIDER,
    model,
    modelStr: `${PROVIDER}/${model}`,
  }) as never;

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  delete process.env.OMNIROUTE_KEEP_HIDDEN_COMBO_CANDIDATES;
});

test("default: hidden model is filtered out of combo targets (upstream behavior)", () => {
  delete process.env.OMNIROUTE_KEEP_HIDDEN_COMBO_CANDIDATES;
  const out = filterVisibleComboTargets([mk("hidden-model"), mk("visible-model")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].modelStr, `${PROVIDER}/visible-model`);
});

test("003c flag: hidden model STAYS a combo target", () => {
  process.env.OMNIROUTE_KEEP_HIDDEN_COMBO_CANDIDATES = "1";
  try {
    const out = filterVisibleComboTargets([mk("hidden-model"), mk("visible-model")]);
    assert.equal(out.length, 2, "both targets survive with the decouple flag");
  } finally {
    delete process.env.OMNIROUTE_KEEP_HIDDEN_COMBO_CANDIDATES;
  }
});
