import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeQuotaUsageSummary,
  computeAntigravityWindowSummaries,
  parseQuotaData,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaParsing.ts";

describe("computeQuotaUsageSummary (providers-page quota chip)", () => {
  it("returns the worst row across mixed windows (antigravity payload shape)", () => {
    // Shape mirrors the live providerLimitsCache for an Antigravity Pro account.
    const rows = parseQuotaData("antigravity", {
      quotas: {
        "gemini-3.1-pro-low": {
          used: 922,
          total: 1000,
          remainingPercentage: 7.777995,
          fractionReported: true,
          resetAt: "2026-10-07T07:51:37.000Z",
        },
        "gpt-oss-120b-medium": {
          used: 0,
          total: 1000,
          remainingPercentage: 100,
          fractionReported: true,
          resetAt: "2026-10-04T23:40:58.000Z",
        },
        gemini_weekly: {
          used: 922,
          total: 1000,
          remainingPercentage: 7.777995,
          fractionReported: true,
          resetAt: "2026-10-07T07:51:37.000Z",
        },
        claude_gpt_weekly: {
          used: 0,
          total: 1000,
          remainingPercentage: 100,
          fractionReported: true,
          resetAt: "2026-10-11T13:34:41.000Z",
        },
        credits: { remaining: 42 },
      },
    });
    const summary = computeQuotaUsageSummary(rows);
    assert.ok(summary);
    // ~7.78% remaining on the gemini weekly window (parse may round to 2dp).
    assert.ok(Math.abs(summary.remainingPct - 7.78) < 0.01, `remainingPct=${summary.remainingPct}`);
    assert.ok(Math.abs(summary.usedPct - 92.22) < 0.01, `usedPct=${summary.usedPct}`);
    assert.ok(["gemini_weekly", "gemini-3.1-pro-low"].includes(summary.label));
    assert.equal(summary.resetAt, "2026-10-07T07:51:37.000Z");
  });

  it("works for window-style providers (codex-like session/weekly)", () => {
    const rows = parseQuotaData("codex", {
      quotas: {
        session: { used: 10, total: 100, resetAt: "2026-10-04T23:00:00.000Z" },
        weekly: { used: 80, total: 100, resetAt: "2026-10-08T00:00:00.000Z" },
      },
    });
    const summary = computeQuotaUsageSummary(rows);
    assert.ok(summary);
    assert.equal(summary.remainingPct, 20);
    assert.equal(summary.usedPct, 80);
  });

  it("ignores credits/reset-credits rows and unlimited rows", () => {
    const summary = computeQuotaUsageSummary([
      { name: "credits", isCredits: true, remaining: 42, remainingPercentage: 42 },
      { name: "banked", isResetCredits: true, remaining: 2, remainingPercentage: 2 },
      { name: "chat", unlimited: true, used: 0, total: 0 },
    ]);
    assert.equal(summary, null);
  });

  it("derives percentage from used/total when remainingPercentage is absent", () => {
    const summary = computeQuotaUsageSummary([
      { name: "session", used: 75, total: 100, resetAt: null },
    ]);
    assert.ok(summary);
    assert.equal(summary.remainingPct, 25);
    assert.equal(summary.usedPct, 75);
    assert.equal(summary.resetAt, null);
  });

  it("returns null for empty input", () => {
    assert.equal(computeQuotaUsageSummary([]), null);
    assert.equal(computeQuotaUsageSummary(null), null);
  });
});

describe("computeAntigravityWindowSummaries (dual weekly / five-hour windows)", () => {
  const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

  it("splits per-model buckets into five-hour vs weekly by reset horizon", () => {
    const rows = parseQuotaData("antigravity", {
      quotas: {
        // gemini models: weekly window (resets in days)
        "gemini-3.1-pro-low": {
          used: 922,
          total: 1000,
          remainingPercentage: 7.78,
          fractionReported: true,
          resetAt: inHours(80),
        },
        // claude + gpt-oss models: ~5h rolling window (resets within hours)
        "claude-sonnet-4-6": {
          used: 400,
          total: 1000,
          remainingPercentage: 60,
          fractionReported: true,
          resetAt: inHours(4),
        },
        "gpt-oss-120b-medium": {
          used: 100,
          total: 1000,
          remainingPercentage: 90,
          fractionReported: true,
          resetAt: inHours(5),
        },
        // explicit summary windows
        gemini_weekly: {
          used: 922,
          total: 1000,
          remainingPercentage: 7.78,
          fractionReported: true,
          resetAt: inHours(80),
        },
        claude_gpt_weekly: {
          used: 0,
          total: 1000,
          remainingPercentage: 100,
          fractionReported: true,
          resetAt: inHours(160),
        },
        credits: { remaining: 42 },
      },
    });
    const { weekly, fiveHour } = computeAntigravityWindowSummaries(rows);
    assert.ok(weekly, "weekly summary exists");
    assert.ok(fiveHour, "five-hour summary exists");
    assert.ok(Math.abs(weekly.remainingPct - 7.78) < 0.01, `weekly=${weekly.remainingPct}`);
    // worst 5h bucket = claude-sonnet (60% remaining)
    assert.ok(Math.abs(fiveHour.remainingPct - 60) < 0.01, `fiveHour=${fiveHour.remainingPct}`);
    assert.equal(fiveHour.label, "claude-sonnet-4-6");
  });

  it("classifies non-claude-named 5h models correctly (gpt-oss shares the claude-family window)", () => {
    const rows = [
      {
        name: "gpt-oss-120b-medium",
        used: 500,
        total: 1000,
        remainingPercentage: 50,
        resetAt: inHours(3),
      },
      {
        name: "gemini-3.1-pro-low",
        used: 100,
        total: 1000,
        remainingPercentage: 90,
        resetAt: inHours(100),
      },
    ];
    const { weekly, fiveHour } = computeAntigravityWindowSummaries(rows);
    assert.ok(fiveHour);
    assert.equal(fiveHour.label, "gpt-oss-120b-medium");
    assert.ok(weekly);
    assert.equal(weekly.label, "gemini-3.1-pro-low");
  });

  it("returns null fiveHour when only weekly rows exist", () => {
    const rows = [
      {
        name: "gemini_weekly",
        used: 922,
        total: 1000,
        remainingPercentage: 7.78,
        resetAt: inHours(80),
      },
      {
        name: "gemini-3.1-pro-low",
        used: 922,
        total: 1000,
        remainingPercentage: 7.78,
        resetAt: inHours(80),
      },
    ];
    const { weekly, fiveHour } = computeAntigravityWindowSummaries(rows);
    assert.ok(weekly);
    assert.equal(fiveHour, null);
  });

  it("keeps an explicit weekly summary row weekly even when its reset is < 6h away", () => {
    const rows = [
      {
        name: "claude_gpt_weekly",
        used: 10,
        total: 1000,
        remainingPercentage: 99,
        resetAt: inHours(2),
      },
      {
        name: "claude-sonnet-4-6",
        used: 300,
        total: 1000,
        remainingPercentage: 70,
        resetAt: inHours(2),
      },
    ];
    const { weekly, fiveHour } = computeAntigravityWindowSummaries(rows);
    assert.ok(weekly);
    assert.equal(weekly.label, "claude_gpt_weekly");
    assert.ok(fiveHour);
    assert.equal(fiveHour.label, "claude-sonnet-4-6");
  });

  it("ignores credits, reset-credits and unlimited rows", () => {
    const { weekly, fiveHour } = computeAntigravityWindowSummaries([
      {
        name: "credits",
        isCredits: true,
        remaining: 42,
        remainingPercentage: 42,
        resetAt: inHours(1),
      },
      {
        name: "banked",
        isResetCredits: true,
        remaining: 2,
        remainingPercentage: 2,
        resetAt: inHours(1),
      },
      { name: "chat_20706", unlimited: true, used: 0, total: 0, resetAt: null },
    ]);
    assert.equal(weekly, null);
    assert.equal(fiveHour, null);
  });
});
