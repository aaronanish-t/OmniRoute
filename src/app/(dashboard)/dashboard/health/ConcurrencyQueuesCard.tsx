"use client";

import { Card } from "@/shared/components";
import { useLocale, useTranslations } from "next-intl";

interface QueueStats {
  running?: number;
  queued?: number;
  max?: number;
  maxConcurrency?: number;
  rateLimitedUntil?: string | null;
  blockedUntil?: string | null;
}

interface ConcurrencySnapshot {
  timestamp?: string;
  comboQueues?: Record<string, QueueStats>;
  semaphores?: Record<string, QueueStats>;
}

interface Props {
  data: ConcurrencySnapshot | null;
  error: string | null;
}

function shortKey(value: string): string {
  return value.length > 28 ? `${value.slice(0, 24)}…` : value;
}

function parseComboKey(key: string): { combo: string; target: string } {
  const remainder = key.slice("combo:".length);
  const separator = remainder.indexOf(":");
  if (separator < 0) return { combo: remainder, target: "" };
  return {
    combo: remainder.slice(0, separator),
    target: remainder.slice(separator + 1),
  };
}

function parseAccountKey(key: string): { provider: string; account: string } {
  const separator = key.indexOf(":");
  if (separator < 0) return { provider: key, account: "" };
  return {
    provider: key.slice(0, separator),
    account: key.slice(separator + 1),
  };
}

function gateLimit(status: QueueStats): number | null {
  if (typeof status.max === "number") return status.max;
  if (typeof status.maxConcurrency === "number") return status.maxConcurrency;
  return null;
}

function gateState(status: QueueStats): string | null {
  const until = status.rateLimitedUntil || status.blockedUntil;
  if (!until) return null;
  const timestamp = Date.parse(until);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return null;
  return new Date(timestamp).toLocaleTimeString();
}

function QueueEntry({
  label,
  detail,
  status,
  t,
}: {
  label: string;
  detail?: string;
  status: QueueStats;
  t: ReturnType<typeof useTranslations>;
}) {
  const queued = status.queued || 0;
  const running = status.running || 0;
  const limit = gateLimit(status);
  const blockedUntil = gateState(status);
  const active = queued > 0 || running > 0 || blockedUntil;

  return (
    <div
      className={`rounded-lg border p-3 ${
        queued > 0
          ? "border-amber-500/25 bg-amber-500/5"
          : active
            ? "border-blue-500/20 bg-blue-500/5"
            : "border-white/5 bg-surface/30"
      }`}
      title={detail || label}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-main">{label}</p>
          {detail && <p className="truncate font-mono text-[10px] text-text-muted">{detail}</p>}
        </div>
        {queued > 0 && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">
            {t("queued")}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
        <span>{t("queuedCount", { count: queued })}</span>
        <span>{t("runningCount", { count: running })}</span>
        <span>{limit == null ? t("notAvailable") : `max ${limit}`}</span>
      </div>
      {blockedUntil && (
        <p className="mt-1 text-[10px] text-amber-400">
          {t("cooldown")} · {t("until", { time: blockedUntil })}
        </p>
      )}
    </div>
  );
}

export default function ConcurrencyQueuesCard({ data, error }: Props) {
  const locale = useLocale();
  const t = useTranslations("health");
  const comboEntries = Object.entries(data?.comboQueues || {}).map(([key, status]) => {
    const parsed = parseComboKey(key);
    return { key, status, ...parsed };
  });
  const accountEntries = Object.entries(data?.semaphores || {}).map(([key, status]) => {
    const parsed = parseAccountKey(key);
    return { key, status, ...parsed };
  });
  const queueCount = comboEntries.length + accountEntries.length;
  const queuedCount = [...comboEntries, ...accountEntries].reduce(
    (total, entry) => total + (entry.status.queued || 0),
    0
  );
  const runningCount = [...comboEntries, ...accountEntries].reduce(
    (total, entry) => total + (entry.status.running || 0),
    0
  );

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-text-main">
            <span className="material-symbols-outlined text-[20px] text-primary">account_tree</span>
            {t("rateLimitStatus")}
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            {queueCount > 0
              ? `${queueCount > 1 ? t("activeLimitersPlural", { count: queueCount }) : t("activeLimiters", { count: queueCount })} · ${t("queuedCount", { count: queuedCount })} · ${t("runningCount", { count: runningCount })}`
              : t("noDataYet")}
          </p>
        </div>
        <span className="text-xs text-text-muted">
          {data?.timestamp
            ? t("updatedAt", { time: new Date(data.timestamp).toLocaleTimeString(locale) })
            : t("notAvailable")}
        </span>
      </div>

      {error && <p className="mt-3 text-sm text-red-400">{t("failedToLoad", { error })}</p>}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section aria-label={`${t("models")} combo queues`}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t("models")} · combo queues
          </h3>
          {comboEntries.length > 0 ? (
            <div className="space-y-2">
              {comboEntries
                .sort((a, b) => (b.status.queued || 0) - (a.status.queued || 0))
                .map(({ key, combo, target, status }) => (
                  <QueueEntry
                    key={key}
                    label={combo || t("notAvailable")}
                    detail={target ? shortKey(target) : undefined}
                    status={status}
                    t={t}
                  />
                ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border/50 p-3 text-sm text-text-muted">
              {t("noDataYet")}
            </p>
          )}
        </section>

        <section aria-label={`${t("accounts")} account queues`}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t("accounts")} · account queues
          </h3>
          {accountEntries.length > 0 ? (
            <div className="space-y-2">
              {accountEntries
                .sort((a, b) => (b.status.queued || 0) - (a.status.queued || 0))
                .map(({ key, provider, account, status }) => (
                  <QueueEntry
                    key={key}
                    label={provider}
                    detail={account ? shortKey(account) : undefined}
                    status={status}
                    t={t}
                  />
                ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border/50 p-3 text-sm text-text-muted">
              {t("noDataYet")}
            </p>
          )}
        </section>
      </div>
    </Card>
  );
}
