/**
 * nnd.45 (#239) — three regression tests for the 2026-11-12 event-loop freeze:
 *  ②a getGlobalModel memo (negative results cached — the codex sweep re-scanned
 *     the full 272×2240 registry per lookup)
 *  ②b vision executor eligibility (unconfigured noAuth providers must not be
 *     describe candidates)
 *  ③ whole-scan cache (getFallbackModels must not re-walk the registry per retry)
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resetRegistryLookupCache,
  getGlobalModelMemoSizeForTests,
  findModelName,
  isValidModel,
} from "../../../open-sse/config/providerModels.ts";
import {
  getBestVisionModel,
  getFallbackModels,
  clearSelectionCache,
  getVisionScanCacheSizeForTests,
} from "../../../src/lib/guardrails/visionBridgeRouter.ts";

beforeEach(() => {
  resetRegistryLookupCache();
  clearSelectionCache();
});

test("②a: getGlobalModel memoizes unresolved ids (negative-result caching)", () => {
  assert.equal(getGlobalModelMemoSizeForTests(), 0);
  // An id that exists in NO provider registry — the codex-sweep shape.
  const unknown = "codex-app-server/gpt-9.9-does-not-exist";
  const name1 = findModelName("codex-app-server", unknown);
  const sizeAfterFirst = getGlobalModelMemoSizeForTests();
  assert.ok(sizeAfterFirst >= 1, "first lookup must land in the memo");
  // Repeated lookups of the SAME id must NOT add memo entries.
  for (let i = 0; i < 50; i++) {
    assert.equal(findModelName("codex-app-server", unknown), name1);
    assert.equal(isValidModel("codex-app-server", unknown), false);
  }
  assert.equal(getGlobalModelMemoSizeForTests(), sizeAfterFirst, "repeat lookups hit the memo");
  // Reset drops everything.
  resetRegistryLookupCache();
  assert.equal(getGlobalModelMemoSizeForTests(), 0);
});

test("②b: executor filter restricts candidates to configured providers", async () => {
  const permissiveDeps = {
    hasUsableCredentials: async () => true,
    getActiveSyncedCatalog: async () => ({ authoritative: false, models: [] }),
    isModelLocked: () => false,
  };
  // Filter OFF (test context, no getExecutorProviders injected): the walk may
  // include any registry provider.
  // glm-cn's registry key is the dashless alias "glmcn", so accept any form as in-family.
  const glmFamily = (id: string) => {
    const provider = id.split("/")[0];
    return provider === "glmcn" || provider === "glm" || provider === "glm-cn";
  };
  const unfiltered = await getFallbackModels("glm-cn/glm-5.3", {}, permissiveDeps);
  assert.ok(unfiltered.length > 0, "permissive walk must produce candidates");
  assert.ok(
    unfiltered.some((c) => !glmFamily(c)),
    "unfiltered walk includes non-glm providers"
  );
  // Filter ON with only glm configured: every candidate must be glm-family.
  const filtered = await getFallbackModels(
    "glm-cn/glm-5.3",
    {},
    { ...permissiveDeps, getExecutorProviders: async () => new Set(["glm-cn"]) }
  );
  assert.ok(filtered.length > 0, "glm-cn is configured, candidates must exist");
  assert.ok(
    filtered.every((c) => glmFamily(c)),
    "all candidates must come from the configured provider"
  );
  // Best-model selection honors the same filter even though openai/anthropic
  // carry better priority (50) in the router's sort.
  const best = await getBestVisionModel(
    {},
    { ...permissiveDeps, getExecutorProviders: async () => new Set(["glm-cn"]) }
  );
  assert.ok(!best || glmFamily(best), "best pick must respect the filter");
});

test("③: production path caches the scan; injected deps bypass it", async () => {
  // Test context (deps injected) must NOT populate the scan cache.
  await getFallbackModels(
    "glm-cn/glm-5.3",
    {},
    {
      hasUsableCredentials: async () => false,
      getActiveSyncedCatalog: async () => ({ authoritative: false, models: [] }),
      isModelLocked: () => false,
    }
  );
  assert.equal(getVisionScanCacheSizeForTests(), 0, "injected deps bypass the scan cache");
  // Production path (no deps) populates it exactly once regardless of call count.
  await getBestVisionModel({});
  const sizeAfterFirst = getVisionScanCacheSizeForTests();
  assert.equal(sizeAfterFirst, 1, "production path caches the scan");
  await getBestVisionModel({});
  await getFallbackModels("glm-cn/glm-5.3", {});
  assert.equal(getVisionScanCacheSizeForTests(), 1, "repeat scans hit the cache");
  // clearSelectionCache drops it with the rest.
  clearSelectionCache();
  assert.equal(getVisionScanCacheSizeForTests(), 0);
});
