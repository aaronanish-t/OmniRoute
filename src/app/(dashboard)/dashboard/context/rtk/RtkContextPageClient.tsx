"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SegmentedControl, Collapsible } from "@/shared/components";
import RtkLearnDiscoverCard from "./RtkLearnDiscoverCard";
import RtkTomlImportCard from "./RtkTomlImportCard";

type RtkFilter = {
  id: string;
  name: string;
  description: string;
  commandTypes: string[];
  category: string;
  priority: number;
};

type RtkConfig = {
  enabled: boolean;
  intensity: "minimal" | "standard" | "aggressive";
  applyToToolResults: boolean;
  applyToAssistantMessages: boolean;
  applyToCodeBlocks: boolean;
  enabledFilters: string[];
  disabledFilters: string[];
  maxLinesPerResult: number;
  maxCharsPerResult: number;
  deduplicateThreshold: number;
  customFiltersEnabled: boolean;
  trustProjectFilters: boolean;
  rawOutputRetention: "never" | "failures" | "always";
  rawOutputMaxBytes: number;
};

type ConfigUpdate = (current: RtkConfig) => Partial<RtkConfig>;

type AnalyticsSummary = {
  totalRequests: number;
  totalTokensSaved: number;
  avgSavingsPct: number;
  byEngine?: Record<string, { count: number; tokensSaved: number; avgSavingsPct: number }>;
};

type PreviewResult = {
  text?: string;
  compressed?: boolean;
  originalTokens?: number;
  compressedTokens?: number;
  techniquesUsed?: string[];
  detection?: { type: string; confidence: number; category: string };
  error?: string;
};

const SAMPLE_OUTPUT = `$ npm run typecheck
src/lib/example.ts:10:15 - error TS2322: Type 'string' is not assignable to type 'number'.

10 const value: number = "bad";
                 ~~~~~

Found 1 error in src/lib/example.ts:10`;

function formatNumber(value: number | undefined): string {
  return new Intl.NumberFormat().format(value ?? 0);
}

// A save or read-back that gets no reply in this time counts as failed, so one stalled request
// cannot hold back the saves queued behind it.
const REQUEST_TIMEOUT_MS = 15_000;

// Config saves and loads from every copy of this page run one at a time, in order. A save still
// queued when the user leaves the page then goes out before the next visit loads, so it cannot
// overwrite a newer edit made there, and the reopened page starts from what it stored.
let configQueue = Promise.resolve();

function queueConfigTask(task: () => Promise<void>) {
  configQueue = configQueue.then(task);
}

// The stored config, or null when the request fails or gets no reply in time.
function requestConfig(init?: RequestInit): Promise<RtkConfig | null> {
  return fetch("/api/context/rtk/config", {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
}

// Keeps the typed text locally and saves once the edit is committed (blur or Enter), so typing a
// value sends one save and the schema only sees the finished value; it rejects the partial ones.
function NumberSetting({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = Number(draft) || min;
    setDraft(null);
    if (next !== value) onCommit(next);
  };
  return (
    <label className="flex flex-col gap-1 text-sm text-text-main">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={draft ?? value}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
        className="rounded border border-border bg-bg px-2 py-1 text-sm"
      />
    </label>
  );
}

export default function RtkContextPageClient() {
  const t = useTranslations("contextRtk");
  const tSettings = useTranslations("settings");
  const [filters, setFilters] = useState<RtkFilter[]>([]);
  const [config, setConfig] = useState<RtkConfig | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [sample, setSample] = useState(SAMPLE_OUTPUT);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  // The form shows the config the server last confirmed plus the edits still queued, so the
  // newest edit stays on screen and a failed save rolls back only its own change. A queued edit is
  // worked out again from the confirmed config when its save goes out, so it never carries an
  // earlier edit that failed.
  const savedRef = useRef<RtkConfig | null>(null);
  const queuedRef = useRef<ConfigUpdate[]>([]);
  const [viewMode, setViewMode] = useState<"simple" | "advanced">("simple");
  const [masterEnabled, setMasterEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/settings/compression")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setMasterEnabled(data?.enabled ?? false))
      .catch(() => {});
  }, []);

  const loadFilters = () =>
    fetch("/api/context/rtk/filters")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setFilters(Array.isArray(data?.filters) ? data.filters : []))
      .catch(() => {});

  useEffect(() => {
    void loadFilters();
    queueConfigTask(async () => {
      const data = await requestConfig();
      savedRef.current = data;
      setConfig(data);
    });
    fetch("/api/context/analytics?since=7d")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setAnalytics(data))
      .catch(() => {});
  }, []);

  const groupedFilters = useMemo(() => {
    return filters.reduce<Record<string, RtkFilter[]>>((groups, filter) => {
      groups[filter.category] = [...(groups[filter.category] ?? []), filter];
      return groups;
    }, {});
  }, [filters]);

  const activeFilterCount = useMemo(() => {
    if (!config) return 0;
    if (config.enabledFilters.length > 0) return config.enabledFilters.length;
    return filters.filter((filter) => !config.disabledFilters.includes(filter.id)).length;
  }, [config, filters]);

  const saveConfig = (patch: Partial<RtkConfig> | ConfigUpdate) => {
    if (!savedRef.current) return;
    const update = typeof patch === "function" ? patch : () => patch;
    const showQueued = () =>
      setConfig(
        queuedRef.current.reduce<RtkConfig>(
          (shown, queued) => ({ ...shown, ...queued(shown) }),
          savedRef.current
        )
      );
    queuedRef.current.push(update);
    showQueued();
    setSaveFailed(false);
    queueConfigTask(async () => {
      const body = update(savedRef.current);
      const reply = await requestConfig({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // Without a reply the server may still have stored the change, so read back what it holds;
      // the save failed only if the change is not there.
      const stored = reply ?? (await requestConfig());
      const kept =
        reply !== null ||
        (stored !== null &&
          Object.entries(body).every(
            ([key, value]) =>
              JSON.stringify(stored[key as keyof RtkConfig]) === JSON.stringify(value)
          ));
      queuedRef.current.shift();
      if (stored) savedRef.current = stored;
      if (!kept) setSaveFailed(true);
      showQueued();
    });
  };

  const toggleFilter = (filterId: string, enabled: boolean) =>
    saveConfig((current) => ({
      disabledFilters: enabled
        ? current.disabledFilters.filter((id) => id !== filterId)
        : [...new Set([...current.disabledFilters, filterId])],
    }));

  const runPreview = async () => {
    const res = await fetch("/api/context/rtk/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: sample, config: config ?? undefined }),
    });
    setPreview(res.ok ? await res.json() : { error: await res.text() });
  };

  const rtkStats = analytics?.byEngine?.rtk;
  const statCards = [
    [t("tokensFiltered"), formatNumber(rtkStats?.tokensSaved ?? analytics?.totalTokensSaved)],
    [t("filtersActive"), formatNumber(activeFilterCount)],
    [t("requests"), formatNumber(rtkStats?.count ?? analytics?.totalRequests)],
    [t("avgSavings"), `${rtkStats?.avgSavingsPct ?? analytics?.avgSavingsPct ?? 0}%`],
  ];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-[30px] text-primary">filter_alt</span>
            <div>
              <h1 className="text-2xl font-bold text-text-main">{t("title")}</h1>
              <p className="text-sm text-text-muted">{t("description")}</p>
            </div>
          </div>
          <SegmentedControl
            value={viewMode}
            onChange={(v) => setViewMode(v as "simple" | "advanced")}
            options={[
              { value: "simple", label: t("simpleMode") || "Simple" },
              { value: "advanced", label: t("advancedMode") || "Advanced" },
            ]}
          />
        </div>
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {statCards.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-surface p-4">
            <p className="text-xs uppercase text-text-muted">{label}</p>
            <p className="mt-1 text-xl font-semibold text-text-main">{value}</p>
          </div>
        ))}
      </section>

      {masterEnabled === false && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300 flex items-start gap-2">
          <span className="material-symbols-outlined text-[18px]">info</span>
          <p>{t("masterSwitchOffAlert")}</p>
        </div>
      )}

      {config && (
        <section className="rounded-lg border border-border bg-surface p-4">
          {/* On/off + intensity now live in the panel (/dashboard/context/settings). This
              page edits RTK's detailed configuration only. */}
          {saveFailed && (
            <p
              role="alert"
              className="mb-3 flex items-center gap-1 text-xs font-medium text-red-500"
            >
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                error
              </span>
              {tSettings("saveFailed")}
            </p>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {(
              [
                ["maxLinesPerResult", t("maxLines"), 0, undefined],
                ["maxCharsPerResult", t("maxChars"), 0, undefined],
                ["deduplicateThreshold", t("deduplicateThreshold"), 2, 100],
                ["rawOutputMaxBytes", t("rawOutputMaxBytes"), 1024, undefined],
              ] as const
            ).map(([key, label, min, max]) => (
              <NumberSetting
                key={key}
                label={label}
                value={config[key]}
                min={min}
                max={max}
                onCommit={(value) => saveConfig({ [key]: value } as Partial<RtkConfig>)}
              />
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-4 text-sm text-text-main">
            {[
              ["applyToToolResults", t("toolResults")],
              ["applyToAssistantMessages", t("assistantMessages")],
              ["applyToCodeBlocks", t("codeBlocks")],
              ["customFiltersEnabled", t("customFilters")],
              ["trustProjectFilters", t("trustProjectFilters")],
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={Boolean(config[key as keyof RtkConfig])}
                  onChange={(event) =>
                    saveConfig({ [key]: event.target.checked } as Partial<RtkConfig>)
                  }
                />
                {label}
              </label>
            ))}
          </div>
          <div className="mt-4 max-w-sm text-sm text-text-main">
            <label className="flex flex-col gap-1">
              {t("rawOutputRetention")}
              <select
                value={config.rawOutputRetention}
                onChange={(event) =>
                  saveConfig({
                    rawOutputRetention: event.target.value as RtkConfig["rawOutputRetention"],
                  })
                }
                className="rounded border border-border bg-bg px-2 py-1 text-sm"
              >
                <option value="never">{t("rawOutputNever")}</option>
                <option value="failures">{t("rawOutputFailures")}</option>
                <option value="always">{t("rawOutputAlways")}</option>
              </select>
            </label>
          </div>
        </section>
      )}

      {viewMode === "advanced" && (
        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1fr]">
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-main">{t("filterTesting")}</h2>
              <button
                onClick={runPreview}
                className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white"
              >
                {t("run")}
              </button>
            </div>
            <textarea
              value={sample}
              onChange={(event) => setSample(event.target.value)}
              placeholder={t("pasteOutput")}
              className="h-72 w-full rounded-lg border border-border bg-bg p-3 font-mono text-xs text-text-main"
            />
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-3 text-sm font-semibold text-text-main">{t("result")}</h2>
            {preview?.detection && (
              <p className="mb-2 text-xs text-text-muted">
                {t("detected")}: {preview.detection.type} (
                {Math.round(preview.detection.confidence * 100)}%)
              </p>
            )}
            <pre className="h-72 overflow-auto rounded-lg border border-border bg-bg p-3 text-xs text-text-main">
              {preview ? JSON.stringify(preview, null, 2) : t("previewEmpty")}
            </pre>
          </div>
        </section>
      )}

      <Collapsible
        title={t("filterCatalog") || "Filter Catalog"}
        subtitle={t("filterCatalogDesc") || "Available output filters by category"}
        icon="filter_list"
        trailing={
          <span className="text-xs text-text-muted">
            {Object.values(groupedFilters).flat().length} {t("filtersActive") || "filters"}
          </span>
        }
        defaultOpen={viewMode === "advanced"}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Object.entries(groupedFilters).map(([category, items]) => (
            <div key={category} className="rounded-lg border border-border bg-bg p-3">
              <h3 className="text-xs font-semibold capitalize text-text-main">{category}</h3>
              <div className="mt-2 space-y-2">
                {items.map((filter) => {
                  const enabled = config ? !config.disabledFilters.includes(filter.id) : true;
                  return (
                    <div
                      key={filter.id}
                      className="border-t border-border pt-2 first:border-t-0 first:pt-0"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-text-main">{filter.name}</p>
                          <p className="mt-0.5 text-[11px] text-text-muted">{filter.description}</p>
                        </div>
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={!config}
                          onChange={(event) => toggleFilter(filter.id, event.target.checked)}
                          className="mt-0.5"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Collapsible>

      {viewMode === "advanced" && <RtkTomlImportCard onInstalled={loadFilters} />}

      <RtkLearnDiscoverCard />
    </div>
  );
}
