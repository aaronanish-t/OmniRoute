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

function ChipText({
  summary,
  labelKey,
  fallbackSuffix,
  t,
}: {
  summary: QuotaUsageSummary;
  labelKey: string;
  fallbackSuffix: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const usedText = summary.usedPct.toFixed(0);
  const fallback = `${usedText}% used${fallbackSuffix ? ` ${fallbackSuffix}` : ""}`;
  return (
    <>
      <span className="material-symbols-outlined text-[11px]">data_usage</span>
      {translateUsageOrFallback(t, labelKey, fallback, { pct: usedText })}
    </>
  );
}

/**
 * Compact per-connection quota chip for the Providers page rows. Antigravity/agy
 * accounts show BOTH windows Google enforces ("X% used weekly" + "Y% used five
 * hour"); every other provider shows the single worst ("X% used"). Percentage-
 * based — Antigravity reports no absolute limit upstream, only fractions.
 */
export default function ConnectionQuotaChip({
  connectionId,
  provider,
}: {
  connectionId: string;
  provider: string;
}) {
  const t = useTranslations("usage");
  const [state, setState] = useState<{
    weekly: QuotaUsageSummary | null;
    fiveHour: QuotaUsageSummary | null;
    generic: QuotaUsageSummary | null;
  }>({ weekly: null, fiveHour: null, generic: null });

  useEffect(() => {
    let alive = true;
    loadLimitsCaches().then((caches) => {
      if (!alive) return;
      const entry = caches[connectionId];
      if (!entry || typeof entry !== "object") return;
      const rows = parseQuotaData(provider, entry);
      if (isAntigravityHeadlineProvider(provider)) {
        const windows = computeAntigravityWindowSummaries(rows);
        setState({ weekly: windows.weekly, fiveHour: windows.fiveHour, generic: null });
      } else {
        setState({ weekly: null, fiveHour: null, generic: computeQuotaUsageSummary(rows) });
      }
    });
    return () => {
      alive = false;
    };
  }, [connectionId, provider]);

  const renderChip = (
    summary: QuotaUsageSummary | null,
    labelKey: string,
    fallbackSuffix: string,
    key: string
  ) => {
    if (!summary) return null;
    const colors = getBarColor(summary.remainingPct);
    const cd = formatCountdown(summary.resetAt);
    return (
      <span
        key={key}
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium tabular-nums"
        style={{ background: colors.bg, color: colors.text }}
        title={
          cd
            ? `${summary.label} — ${translateUsageOrFallback(t, "resetsIn", "Resets in")} ${cd}`
            : summary.label
        }
      >
        <ChipText summary={summary} labelKey={labelKey} fallbackSuffix={fallbackSuffix} t={t} />
      </span>
    );
  };

  if (isAntigravityHeadlineProvider(provider)) {
    const chips = [
      renderChip(state.weekly, "percentUsedWeekly", "weekly", "weekly"),
      renderChip(state.fiveHour, "percentUsedFiveHour", "five hour", "fiveHour"),
    ].filter(Boolean);
    return chips.length > 0 ? <>{chips}</> : null;
  }

  return renderChip(state.generic, "percentUsed", "", "generic");
}
