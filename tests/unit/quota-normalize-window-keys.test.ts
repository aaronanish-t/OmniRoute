import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeUsageQuotaKey,
  isUsageQuotaKeyAllowed,
} from "../../src/lib/usage/providerLimits/quotaNormalize.ts";

describe("quotaNormalize: antigravity window-summary keys pass the allowlist", () => {
  // Regression guard (v3.8.52 regression): the family-window summary rows
  // (gemini_weekly / gemini_5h / claude_gpt_weekly / claude_gpt_5h) are aggregate
  // windows, not model ids — dropping them emptied the provider-limits cache of
  // every window row and the dashboard lost the Antigravity limits entirely.
  it("keeps the four window-summary keys untouched for antigravity and agy", () => {
    for (const key of ["gemini_weekly", "gemini_5h", "claude_gpt_weekly", "claude_gpt_5h"]) {
      assert.equal(normalizeUsageQuotaKey("antigravity", key), key);
      assert.equal(normalizeUsageQuotaKey("agy", key), key);
      assert.equal(isUsageQuotaKeyAllowed("antigravity", key), true);
    }
  });

  it("still passes through known model ids and drops unknown junk keys", () => {
    assert.equal(normalizeUsageQuotaKey("antigravity", "gemini-3.1-pro-low"), "gemini-3.1-pro-low");
    assert.equal(normalizeUsageQuotaKey("antigravity", "definitely-not-a-model"), null);
    assert.equal(normalizeUsageQuotaKey("codex", "session"), "session");
  });
});
