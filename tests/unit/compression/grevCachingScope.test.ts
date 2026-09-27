import test from "node:test";
import assert from "node:assert/strict";

import { isGrevCachingTarget } from "../../../open-sse/services/compression/grevCaching.ts";
import { getIntegrityGuidance } from "../../../src/shared/components/compression/GrevCachingPage.tsx";

const config = {
  enabled: true,
  excludedModelKeys: ["openai/gpt-4o"],
  excludedComboIds: ["excluded-combo"],
};

test("GrevCaching applies to all models except its explicit model exclusions", () => {
  assert.equal(
    isGrevCachingTarget(config, { provider: "openai", model: "gpt-4.1", routingComboIds: [] }),
    true
  );
  assert.equal(
    isGrevCachingTarget(config, { provider: "openai", model: "gpt-4o", routingComboIds: [] }),
    false
  );
});

test("GrevCaching exclusion is model-based, including execution legs in routing combos", () => {
  assert.equal(
    isGrevCachingTarget(config, {
      provider: "anthropic",
      model: "claude-sonnet-4",
      routingComboIds: ["excluded-combo"],
    }),
    true
  );
  assert.equal(
    isGrevCachingTarget(config, {
      provider: "anthropic",
      model: "claude-sonnet-4",
      routingComboIds: [],
      compatible: false,
    }),
    true
  );
});

test("disabled GrevCaching never bypasses normal compression", () => {
  assert.equal(
    isGrevCachingTarget(
      { ...config, enabled: false },
      {
        provider: "openai",
        model: "gpt-4.1",
        routingComboIds: [],
      }
    ),
    false
  );
});

test("Grev new-block engine options expose preservation risk guidance", () => {
  assert.equal(getIntegrityGuidance("lite").level, "Near-lossless");
  assert.equal(getIntegrityGuidance("caveman").level, "Moderate");
  assert.equal(getIntegrityGuidance("ultra").level, "Very high");
  assert.match(getIntegrityGuidance("ionizer").hint, /homogeneous data/i);
  assert.equal(getIntegrityGuidance("future-engine").level, "High");
});
