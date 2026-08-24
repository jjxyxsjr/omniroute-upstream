// 008 (2026-08-25): requiresVision must be STRUCTURAL — a data:image URI that
// survives inside a tool argument (or any bare string) is text to the upstream,
// not an image. The legacy deep string scan permanently poisoned such sessions
// into capability_mismatch against every text-only target (deploy docs/060,
// 2026-08-24 16:20 entry). Guards both derive paths: the shared capability
// filter and the comboStructure twin.
import test from "node:test";
import assert from "node:assert/strict";

const { deriveRequestCapabilityRequirements } = await import(
  "../../src/shared/constants/capabilities/capabilityFilter.ts"
);
const { deriveRequestCompatibilityRequirements } = await import(
  "../../open-sse/services/combo/comboStructure.ts"
);

const DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

test("data:image URI inside a tool argument does NOT require vision (008)", () => {
  const body = {
    messages: [{ role: "user", content: "read this" }],
    tools: [
      {
        type: "function",
        function: {
          name: "render",
          parameters: { properties: { img: { type: "string" } } },
        },
        description: `previously rendered ${DATA_URI}#w=8`,
      },
    ],
  };
  assert.equal(deriveRequestCapabilityRequirements(body).requiresVision, false);
  assert.equal(deriveRequestCompatibilityRequirements(body).requiresVision, false);
});

test("structured image part DOES require vision (both engines, 008)", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: DATA_URI } },
          { type: "text", text: "what is this" },
        ],
      },
    ],
  };
  assert.equal(deriveRequestCapabilityRequirements(body).requiresVision, true);
  assert.equal(deriveRequestCompatibilityRequirements(body).requiresVision, true);
});

test("anthropic-style source block DOES require vision (008)", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        ],
      },
    ],
  };
  assert.equal(deriveRequestCapabilityRequirements(body).requiresVision, true);
  assert.equal(deriveRequestCompatibilityRequirements(body).requiresVision, true);
});

test("plain text mentioning data:image is not vision (008)", () => {
  const body = { messages: [{ role: "user", content: `how do I embed ${DATA_URI} in html` }] };
  assert.equal(deriveRequestCapabilityRequirements(body).requiresVision, false);
  assert.equal(deriveRequestCompatibilityRequirements(body).requiresVision, false);
});
