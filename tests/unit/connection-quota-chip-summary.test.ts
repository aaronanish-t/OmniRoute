import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeQuotaUsageSummary,
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
