import test from "node:test";
import assert from "node:assert/strict";
import {
  defersQuotaCutoff,
  hasCodexCreditOptIn,
} from "../../src/lib/providers/quotaCutoffOptIns.ts";

test("Claude extra usage defers the subscription cutoff only when explicitly allowed", () => {
  assert.equal(defersQuotaCutoff("claude", { blockExtraUsage: false }), true);
  assert.equal(defersQuotaCutoff("claude", { blockExtraUsage: true }), false);
  assert.equal(defersQuotaCutoff("claude", {}), false);
});

test("Codex paid credits defer the subscription cutoff except for Spark", () => {
  const optedIn = { allowPaidCredits: true };
  assert.equal(defersQuotaCutoff("codex", optedIn, "codex/gpt-5.5"), true);
  assert.equal(defersQuotaCutoff("codex", optedIn, "codex/gpt-5.3-codex-spark"), false);
  assert.equal(defersQuotaCutoff("codex", { allowPaidCredits: false }, "codex/gpt-5.5"), false);
  assert.equal(defersQuotaCutoff("openai", optedIn, "gpt-5.5"), false);
});

test("the Codex credit opt-in is read from runtime credentials without trusting their shape", () => {
  const credentials = { providerSpecificData: { allowPaidCredits: true } };
  assert.equal(hasCodexCreditOptIn("codex", credentials, "codex/gpt-5.5"), true);
  assert.equal(hasCodexCreditOptIn("claude", credentials, "claude-opus-5"), false);
  assert.equal(hasCodexCreditOptIn("codex", null, "codex/gpt-5.5"), false);
  assert.equal(hasCodexCreditOptIn("codex", "not-an-object", "codex/gpt-5.5"), false);
  assert.equal(hasCodexCreditOptIn("codex", {}, "codex/gpt-5.5"), false);
});
