"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  parseQuotaData,
  computeQuotaUsageSummary,
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

/**
 * Compact per-connection quota chip for the Providers page rows: shows the
 * worst (lowest remaining %) quota window of the account, colored by the
 * standard green/yellow/red thresholds. Percentage-based for fraction-only
 * providers (Antigravity/agy report no absolute limit upstream).
 */
export default function ConnectionQuotaChip({
  connectionId,
  provider,
}: {
  connectionId: string;
  provider: string;
}) {
  const t = useTranslations("usage");
  const [summary, setSummary] = useState<QuotaUsageSummary | null>(null);

  useEffect(() => {
    let alive = true;
    loadLimitsCaches().then((caches) => {
      if (!alive) return;
      const entry = caches[connectionId];
      if (!entry || typeof entry !== "object") {
        setSummary(null);
        return;
      }
      const rows = parseQuotaData(provider, entry);
      setSummary(computeQuotaUsageSummary(rows));
    });
    return () => {
      alive = false;
    };
  }, [connectionId, provider]);

  if (!summary) return null;

  const colors = getBarColor(summary.remainingPct);
  const usedText = summary.usedPct.toFixed(0);
  const cd = formatCountdown(summary.resetAt);

  return (
    <span
      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium tabular-nums"
      style={{ background: colors.bg, color: colors.text }}
      title={
        cd
          ? `${summary.label} — ${translateUsageOrFallback(t, "resetsIn", "Resets in")} ${cd}`
          : summary.label
      }
    >
      <span className="material-symbols-outlined text-[11px]">data_usage</span>
      {translateUsageOrFallback(t, "percentUsed", `${usedText}% used`, { pct: usedText })}
    </span>
  );
}
