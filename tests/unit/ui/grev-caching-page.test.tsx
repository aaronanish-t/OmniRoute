// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrevCachingPage } from "../../../src/shared/components/compression/GrevCachingPage";
import { GrevCachingAnalytics } from "../../../src/shared/components/compression/GrevCachingAnalytics";
import { getSectionItems, SIDEBAR_SECTIONS } from "../../../src/shared/constants/sidebarVisibility";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const data = url.includes("/api/settings/compression")
        ? { grevCaching: { enabled: true } }
        : url.includes("/api/models")
          ? { models: [] }
          : url.includes("/api/compression/engines")
            ? { engines: [] }
            : {
                totalRuns: 0,
                totalConversations: 2,
                originalTokens: 0,
                compressedTokens: 0,
                tokensSaved: 0,
                averageSavingsPercent: 0,
                requestsWithUsage: 0,
                promptReportingRequests: 1,
                cacheReadReportingRequests: 1,
                actualPromptTokens: 0,
                cacheReadTokens: 0,
                estimatedCacheHitTokens: 0,
                engines: [],
                recentRuns: [],
                conversations: [
                  {
                    conversationId: "chat-with-cache",
                    model: "test-model",
                    exchanges: 3,
                    promptEstimatedTokens: 900,
                    actualPromptTokens: 500,
                    promptRequestsReported: 1,
                    cacheReadRequestsReported: 1,
                    compressionTokensSaved: 10,
                    compressionSavingsPercent: 1,
                    engineTokensSaved: 200,
                    engineSavingsPercent: 40,
                    estimatedPrefixTokensReused: 850,
                    lastActivity: new Date().toISOString(),
                  },
                  {
                    conversationId: "chat-without-cache-usage",
                    model: "test-model",
                    exchanges: 1,
                    promptEstimatedTokens: 100,
                    actualPromptTokens: 0,
                    promptRequestsReported: 0,
                    cacheReadRequestsReported: 0,
                    compressionTokensSaved: 0,
                    compressionSavingsPercent: 0,
                    engineTokensSaved: 0,
                    engineSavingsPercent: 0,
                    estimatedPrefixTokensReused: 0,
                    lastActivity: new Date().toISOString(),
                  },
                ],
              };
      return { ok: true, json: async () => data } as Response;
    })
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("GrevCaching settings page", () => {
  it("uses the provided portrait asset for its sidebar icon", () => {
    const contextSection = SIDEBAR_SECTIONS.find((section) => section.id === "omni-proxy");
    expect(contextSection).toBeDefined();
    const grevCaching = getSectionItems(contextSection!).find(
      (item) => item.id === "context-grev-caching"
    );

    expect(grevCaching?.iconImageSrc).toBe("/images/grevcaching-icon.webp");
    expect(existsSync(resolve(process.cwd(), "public/images/grevcaching-icon.webp"))).toBe(true);
  });

  it("keeps verification controls and legacy exclusion cards out of the end-user page", async () => {
    await act(async () => {
      root.render(<GrevCachingPage />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Models to Exclude:");
    expect(container.textContent).not.toContain("64k rollover test");
    expect(container.textContent).not.toContain("Test 64k rollover");
    expect(container.textContent).not.toContain("Excluded compatible models");
    expect(container.textContent).not.toContain("Excluded routing combos");
    expect(container.textContent).not.toContain("GrevCaching engine cache performance");
    expect(container.textContent).toContain("View detailed GrevCaching analytics");
  });

  it("shows provider-confirmed engine savings separately from prefix estimates", async () => {
    await act(async () => {
      root.render(<GrevCachingAnalytics />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Engine cache savings (actual)");
    expect(container.textContent).toContain("Reusable prefix (estimated)");
    expect(container.textContent).toContain("200");
    expect(container.textContent).toContain("850");
    expect(container.textContent).toContain("Not reported");
  });
});
