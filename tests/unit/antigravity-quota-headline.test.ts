import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeAntigravityHeadline,
  isAntigravityHeadlineProvider,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaParsing.ts";

describe("antigravity quota headline (LimitBar-style)", () => {
  // Shape mirrors the live providerLimitsCache entries for an Antigravity Pro
  // account (retrieveUserQuota + retrieveUserQuotaSummary buckets).
  const arefalapour = [
    {
      name: "gemini-3.1-pro-low",
      used: 1000,
      total: 1000,
      remainingPercentage: 0,
      resetAt: "2026-10-08T20:36:54.000Z",
    },
    {
      name: "claude-sonnet-4-6",
      used: 0,
      total: 1000,
      remainingPercentage: 100,
      resetAt: "2026-10-04T18:09:32.000Z",
    },
    {
      name: "gemini_weekly",
      used: 1000,
      total: 1000,
      remainingPercentage: 0,
      resetAt: "2026-10-08T20:36:54.000Z",
    },
    {
      name: "claude_gpt_weekly",
      used: 211,
      total: 1000,
      remainingPercentage: 78.85888,
      resetAt: "2026-10-10T10:00:43.000Z",
    },
    { name: "credits", isCredits: true, remaining: 42 },
  ];

  it("picks the tightest window and derives usedPct from it", () => {
    const headline = computeAntigravityHeadline(arefalapour);
    assert.ok(headline);
    assert.equal(headline.quota.name, "gemini_weekly");
    assert.equal(headline.remainingPct, 0);
    assert.equal(headline.usedPct, 100);
    assert.equal(headline.resetAt, "2026-10-08T20:36:54.000Z");
  });

  it("prefers summary window rows over per-model rows (LimitBar headline is window-based)", () => {
    const quotas = [
      { name: "gemini-3.1-pro-low", used: 950, total: 1000, remainingPercentage: 5 },
      { name: "gemini_weekly", used: 841, total: 1000, remainingPercentage: 15.91997 },
    ];
    const headline = computeAntigravityHeadline(quotas);
    assert.ok(headline);
    assert.equal(headline.quota.name, "gemini_weekly");
    assert.equal(headline.usedPct, 84.08003);
  });

  it("falls back to per-model rows when the weekly fetch reported no windows", () => {
    // Live case (connection f5098335): only per-model buckets, no *_weekly rows.
    const quotas = [
      { name: "gemini-3.1-pro-low", used: 841, total: 1000, remainingPercentage: 15.91997 },
      { name: "gpt-oss-120b-medium", used: 0, total: 1000, remainingPercentage: 100 },
    ];
    const headline = computeAntigravityHeadline(quotas);
    assert.ok(headline);
    assert.equal(headline.quota.name, "gemini-3.1-pro-low");
    assert.equal(headline.remainingPct, 15.91997);
  });

  it("derives the percentage from used/total when remainingPercentage is absent", () => {
    const quotas = [{ name: "gemini_weekly", used: 841, total: 1000, resetAt: null }];
    const headline = computeAntigravityHeadline(quotas);
    assert.ok(headline);
    assert.equal(Math.round(headline.remainingPct * 10) / 10, 15.9);
    assert.equal(headline.resetAt, null);
  });

  it("returns null for empty input or credits-only input", () => {
    assert.equal(computeAntigravityHeadline([]), null);
    assert.equal(computeAntigravityHeadline(null), null);
    assert.equal(
      computeAntigravityHeadline([
        { name: "credits", isCredits: true, remaining: 42 },
        { name: "banked_reset_credits", isResetCredits: true, remaining: 1 },
      ]),
      null
    );
  });

  it("treats unlimited rows as 100% remaining without throwing", () => {
    const headline = computeAntigravityHeadline([
      { name: "chat_20706", unlimited: true, used: 0, total: 0 },
    ]);
    assert.ok(headline);
    assert.equal(headline.remainingPct, 100);
    assert.equal(headline.usedPct, 0);
  });

  it("scopes the headline to antigravity/agy providers", () => {
    assert.equal(isAntigravityHeadlineProvider("antigravity"), true);
    assert.equal(isAntigravityHeadlineProvider("agy"), true);
    assert.equal(isAntigravityHeadlineProvider("AGY"), true);
    assert.equal(isAntigravityHeadlineProvider("codex"), false);
    assert.equal(isAntigravityHeadlineProvider(undefined), false);
  });
});
