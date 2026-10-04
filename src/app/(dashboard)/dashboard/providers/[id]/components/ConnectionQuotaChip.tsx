"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  parseQuotaData,
  computeQuotaUsageSummary,
  computeAntigravityWindowSummaries,
  isAntigravityHeadlineProvider,
  type QuotaUsageSummary,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaParsing";
import {
  getBarColor,
  formatCountdown,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils";
import { translateUsageOrFallback } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/i18nFallback";

// Module-level cache: every ConnectionRow on the page shares one provider-limits
// fetch instead of one request per account row.
let limitsPromise: Promise<Record<string, unknown>> | null = null;

function loadLimitsCaches(): Promise<Record<string, unknown>> {
  if (!limitsPromise) {
    limitsPromise = fetch("/api/usage/provider-limits", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { caches: {} }))
      .then((d: { caches?: Record<string, unknown> }) => d?.caches ?? {})
      .catch(() => ({}) as Record<string, unknown>);
  }
  return limitsPromise;
}

type ChipSlot = {
  summary: QuotaUsageSummary | null;
  labelKey: string;
  fallbackSuffix: string;
};

/**
 * Compact per-connection quota chip for the Providers page rows. Antigravity/agy
 * accounts show all FOUR windows Google enforces — "X% used gemini weekly",
 * "Y% used gemini 5h", "Z% used api weekly", "W% used api 5h" (Gemini family vs
 * the Claude/GPT "api" family); every other provider shows the single worst
 * ("X% used"). Percentage-based — Antigravity reports no absolute limit
 * upstream, only fractions.
 */
export default function ConnectionQuotaChip({
  connectionId,
  provider,
}: {
  connectionId: string;
  provider: string;
}) {
  const t = useTranslations("usage");
  const [slots, setSlots] = useState<ChipSlot[]>([]);

  useEffect(() => {
    let alive = true;
    loadLimitsCaches().then((caches) => {
      if (!alive) return;
      const entry = caches[connectionId];
      if (!entry || typeof entry !== "object") return;
      const rows = parseQuotaData(provider, entry);
      if (isAntigravityHeadlineProvider(provider)) {
        const w = computeAntigravityWindowSummaries(rows);
        setSlots([
          {
            summary: w.geminiWeekly,
            labelKey: "percentUsedGeminiWeekly",
            fallbackSuffix: "gemini weekly",
          },
          {
            summary: w.geminiFiveHour,
            labelKey: "percentUsedGeminiFiveHour",
            fallbackSuffix: "gemini 5h",
          },
          { summary: w.apiWeekly, labelKey: "percentUsedApiWeekly", fallbackSuffix: "api weekly" },
          { summary: w.apiFiveHour, labelKey: "percentUsedApiFiveHour", fallbackSuffix: "api 5h" },
        ]);
      } else {
        setSlots([
          { summary: computeQuotaUsageSummary(rows), labelKey: "percentUsed", fallbackSuffix: "" },
        ]);
      }
    });
    return () => {
      alive = false;
    };
  }, [connectionId, provider]);

  const chips = slots
    .filter((slot) => slot.summary)
    .map(({ summary, labelKey, fallbackSuffix }) => {
      const colors = getBarColor(summary!.remainingPct);
      const cd = formatCountdown(summary!.resetAt);
      const usedText = summary!.usedPct.toFixed(0);
      const fallback = `${usedText}% used${fallbackSuffix ? ` ${fallbackSuffix}` : ""}`;
      return (
        <span
          key={labelKey}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium tabular-nums"
          style={{ background: colors.bg, color: colors.text }}
          title={
            cd
              ? `${summary!.label} — ${translateUsageOrFallback(t, "resetsIn", "Resets in")} ${cd}`
              : summary!.label
          }
        >
          <span className="material-symbols-outlined text-[11px]">data_usage</span>
          {translateUsageOrFallback(t, labelKey, fallback, { pct: usedText })}
        </span>
      );
    });

  return chips.length > 0 ? <>{chips}</> : null;
}
