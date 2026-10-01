"use client";
import { useLocale, useTranslations } from "next-intl";
import Card from "@/shared/components/Card";
import type { Detail } from "./helpers";
import { money } from "./helpers";

export default function TeamBudgetCard({ detail }: { detail: Detail }) {
  const t = useTranslations("teamCosts");
  const locale = useLocale();
  const status = detail.budgetStatus;
  const archived = detail.team.status === "archived";
  const incomplete = status?.hasUnpricedUsage || status?.hasPartialRetainedUsage;
  const used = status?.estimatedListCostUsd ?? 0;
  const percent = status ? Math.min(100, (used / status.maxBudgetUsd) * 100) : 0;
  return (
    <Card title={t("budgetTitle")} subtitle={t("budgetSubtitle")} icon="account_balance_wallet">
      {archived ? (
        <p className="text-text-muted">{t("archivedBudget")}</p>
      ) : !status ? (
        <p className="text-text-muted">
          {t(detail.team.maxBudgetUsd == null ? "unlimited" : "budgetUnavailable")}
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap justify-between gap-2 tabular-nums">
            <p>
              {t("used")}: <strong>{money(used, locale)}</strong>
            </p>
            <p>
              {t("maximum")}: {money(status.maxBudgetUsd, locale)}
            </p>
          </div>
          <div
            role="progressbar"
            aria-label={t("budgetTitle")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={incomplete ? undefined : percent}
            aria-valuetext={
              incomplete
                ? t(status.hasUnpricedUsage ? "unpricedBudget" : "partialBudget")
                : undefined
            }
            className="h-2 rounded-full bg-bg overflow-hidden"
          >
            <div
              className={`h-full rounded-full ${status.exceeded ? "bg-red-500" : incomplete ? "bg-amber-500" : "bg-primary"} motion-safe:transition-[width]`}
              style={{ width: `${percent}%` }}
            />
          </div>
          {status.hasUnpricedUsage && (!status.exceeded || used >= status.maxBudgetUsd) && (
            <p role="status" className="text-amber-700 dark:text-amber-400">
              {t("unpricedBudget")}
            </p>
          )}
          {status.hasPartialRetainedUsage && (
            <p role="status" className="text-amber-700 dark:text-amber-400">
              {t("partialBudget")}
            </p>
          )}
          {status.exceeded && (
            <p role="alert" className="text-red-600 dark:text-red-400">
              {used >= status.maxBudgetUsd
                ? t("overBudget", { amount: money(used - status.maxBudgetUsd, locale) })
                : t("unpricedBudget")}
            </p>
          )}
          <div className="flex flex-wrap justify-between gap-2 text-sm text-text-muted tabular-nums">
            <p>
              {t("remaining")}:{" "}
              {incomplete ? "—" : money(Math.max(0, status.maxBudgetUsd - used), locale)}
            </p>
            <p>
              {t("resets")}:{" "}
              {new Intl.DateTimeFormat(locale, {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: "UTC",
              }).format(new Date(status.resetAtIso))}{" "}
              (UTC)
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
