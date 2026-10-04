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

describe("computeAntigravityWindowSummaries (four windows: gemini/api × weekly/5h)", () => {
  const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

  it("uses the four explicit summary rows when present (live v3.8.52+ payload)", () => {
    const rows = parseQuotaData("antigravity", {
      quotas: {
        gemini_weekly: {
          used: 53,
          total: 1000,
          remainingPercentage: 46.94,
          fractionReported: true,
          resetAt: inHours(80),
        },
        gemini_5h: {
          used: 99,
          total: 1000,
          remainingPercentage: 90.11,
          fractionReported: true,
          resetAt: inHours(4),
        },
        claude_gpt_weekly: {
          used: 3,
          total: 1000,
          remainingPercentage: 99.69,
          fractionReported: true,
          resetAt: inHours(160),
        },
        claude_gpt_5h: {
          used: 2,
          total: 1000,
          remainingPercentage: 99.98,
          fractionReported: true,
          resetAt: inHours(4),
        },
        // per-model rows must NOT override the explicit summary rows
        "gemini-3.1-pro-low": {
          used: 922,
          total: 1000,
          remainingPercentage: 7.78,
          fractionReported: true,
          resetAt: inHours(80),
        },
        credits: { remaining: 42 },
      },
    });
    const w = computeAntigravityWindowSummaries(rows);
    assert.ok(w.geminiWeekly);
    assert.ok(Math.abs(w.geminiWeekly.remainingPct - 46.94) < 0.01);
    assert.ok(w.geminiFiveHour);
    assert.ok(Math.abs(w.geminiFiveHour.remainingPct - 90.11) < 0.01);
    assert.ok(w.apiWeekly);
    assert.ok(Math.abs(w.apiWeekly.remainingPct - 99.69) < 0.01);
    assert.ok(w.apiFiveHour);
    assert.ok(Math.abs(w.apiFiveHour.remainingPct - 99.98) < 0.01);
  });

  it("falls back to per-model inference per family when explicit rows are missing (legacy cache)", () => {
    const rows = [
      {
        name: "gemini-3.1-pro-low",
        used: 922,
        total: 1000,
        remainingPercentage: 7.78,
        resetAt: inHours(80),
      },
      {
        name: "gemini-3.1-flash-lite",
        used: 500,
        total: 1000,
        remainingPercentage: 50,
        resetAt: inHours(80),
      },
      {
        name: "claude-sonnet-4-6",
        used: 400,
        total: 1000,
        remainingPercentage: 60,
        resetAt: inHours(4),
      },
      {
        name: "gpt-oss-120b-medium",
        used: 100,
        total: 1000,
        remainingPercentage: 90,
        resetAt: inHours(5),
      },
    ];
    const w = computeAntigravityWindowSummaries(rows);
    // gemini weekly = worst gemini model (7.78%)
    assert.ok(w.geminiWeekly);
    assert.equal(w.geminiWeekly.label, "gemini-3.1-pro-low");
    // gemini models have no 5h buckets here
    assert.equal(w.geminiFiveHour, null);
    // api 5h = worst of claude/gpt 5h buckets (60%)
    assert.ok(w.apiFiveHour);
    assert.equal(w.apiFiveHour.label, "claude-sonnet-4-6");
    // api weekly = null (no api-family weekly rows and no explicit summary row)
    assert.equal(w.apiWeekly, null);
  });

  it("classifies non-claude-named 5h models correctly (gpt-oss shares the api-family window)", () => {
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
    const w = computeAntigravityWindowSummaries(rows);
    assert.ok(w.apiFiveHour);
    assert.equal(w.apiFiveHour.label, "gpt-oss-120b-medium");
    assert.ok(w.geminiWeekly);
    assert.equal(w.geminiWeekly.label, "gemini-3.1-pro-low");
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
    const w = computeAntigravityWindowSummaries(rows);
    assert.ok(w.apiWeekly);
    assert.equal(w.apiWeekly.label, "claude_gpt_weekly");
    assert.ok(w.apiFiveHour);
    assert.equal(w.apiFiveHour.label, "claude-sonnet-4-6");
  });

  it("ignores credits, reset-credits and unlimited rows", () => {
    const w = computeAntigravityWindowSummaries([
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
    assert.equal(w.geminiWeekly, null);
    assert.equal(w.geminiFiveHour, null);
    assert.equal(w.apiWeekly, null);
    assert.equal(w.apiFiveHour, null);
  });
});
