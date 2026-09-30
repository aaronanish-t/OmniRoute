"use client";

// Compression Hub — the single place to understand and control compression.
//
// Phase 2: this Hub is now a thin overview. The master toggle, mode selector, and the
// reorderable per-layer pipeline live in the panel at /dashboard/context/settings and
// in the named-combo editor. Here we expose a single active-profile selector
// (Default-from-panel | a named combo) + a read-only preview.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

// ── Types ─────────────────────────────────────────────────────────────────────

type CompressionMode =
  "off" | "lite" | "standard" | "aggressive" | "ultra" | "rtk" | "codex-responses" | "stacked";

interface CompressionSettings {
  enabled: boolean;
  defaultMode: CompressionMode;
  activeComboId?: string | null;
  contextEditing?: { enabled: boolean };
  [key: string]: unknown;
}

interface NamedCombo {
  id: string;
  name: string;
  pipeline: { engine: string; intensity?: string }[];
}

// A settings PUT that has not answered by then counts as failed, so one stalled request cannot
// hold the saves queued behind it forever.
const SAVE_TIMEOUT_MS = 15_000;

const FALLBACK_SETTINGS: CompressionSettings = {
  enabled: false,
  defaultMode: "off",
  contextEditing: { enabled: false },
};

// ── Sub-components ──────────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      className={`relative w-10 h-5 rounded-full transition-colors ${
        checked ? "bg-green-500" : "bg-border"
      }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          checked ? "left-5" : "left-0.5"
        }`}
      />
    </button>
  );
}

// ── Main component ──────────────────────────────────────────────────────────────

export default function CompressionHub() {
  const t = useTranslations("contextCombos");
  const [settings, setSettings] = useState<CompressionSettings | null>(null);
  const [combos, setCombos] = useState<NamedCombo[]>([]);
  const [loading, setLoading] = useState(true);
  const [explainerOpen, setExplainerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Saves go out one at a time. The Hub shows the last saved settings plus the saves still
  // queued, so a failed save rolls back only its own fields and never undoes a newer save.
  const savedRef = useRef(FALLBACK_SETTINGS);
  const queuedRef = useRef<Partial<CompressionSettings>[]>([]);
  const saveQueueRef = useRef(Promise.resolve());

  // ── Initial load (parallel) ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const asJson = (r: Response) => (r.ok ? r.json() : null);
      const [settingsData, combosData] = await Promise.all([
        fetch("/api/settings/compression")
          .then(asJson)
          .catch(() => null),
        fetch("/api/context/combos")
          .then(asJson)
          .catch(() => null),
      ]);
      if (cancelled) return;
      savedRef.current = settingsData ? (settingsData as CompressionSettings) : FALLBACK_SETTINGS;
      setSettings(savedRef.current);
      if (Array.isArray(combosData?.combos)) {
        setCombos(combosData.combos as NamedCombo[]);
      }
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Settings mutations ───────────────────────────────────────────────────────
  const saveSettings = useCallback(
    (patch: Partial<CompressionSettings>) => {
      const showQueued = () =>
        setSettings(
          queuedRef.current.reduce<CompressionSettings>(
            (shown, queued) => ({ ...shown, ...queued }),
            savedRef.current
          )
        );
      queuedRef.current.push(patch);
      showQueued();
      setError(null);
      saveQueueRef.current = saveQueueRef.current.then(async () => {
        // A later queued save that carries every key of this one replaces it on the server.
        const replaced = queuedRef.current
          .slice(1)
          .some((later) => Object.keys(patch).every((key) => key in later));
        if (!replaced) {
          let ok = false;
          try {
            // Send only the changed fields (patch), not the full merged settings.
            // The API schema is designed for partial updates; sending the full
            // CompressionConfig round-trips fields unknown to the schema and causes
            // a 400 strict-validation failure (e.g. contextBudget, pipeline engines
            // added after the schema was written). CompressionPanel already does this.
            const res = await fetch("/api/settings/compression", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(patch),
              signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
            });
            ok = res.ok;
          } catch {
            // A network error or the timeout counts as a failed save.
          }
          if (ok) {
            savedRef.current = { ...savedRef.current, ...patch };
          } else {
            // The error stays up until the next edit, so a later queued save that succeeds
            // cannot hide the field this one just rolled back.
            setError(t("saveSettingsFailed"));
          }
        }
        queuedRef.current.shift();
        showQueued();
      });
    },
    [t]
  );

  // ── Derived state ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center p-10 text-sm text-text-muted">
        {t("loading")}
      </div>
    );
  }

  const activeCombo = combos.find((c) => c.id === settings?.activeComboId) ?? null;
  const activePipelineText = activeCombo
    ? activeCombo.pipeline.map((s) => s.engine).join(" → ")
    : "";

  return (
    <section className="flex flex-col gap-5 rounded-xl border border-primary/30 bg-surface p-5">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-[26px] text-primary" aria-hidden="true">
            hub
          </span>
          <div>
            <h1 className="text-xl font-bold text-text-main">{t("hubTitle")}</h1>
            <p className="text-sm text-text-muted">{t("hubDescription")}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExplainerOpen((v) => !v)}
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs text-text-main hover:bg-bg"
        >
          {explainerOpen ? t("hideExplanation") : t("howItWorks")}
        </button>
      </div>

      {error && (
        <p className="rounded border border-danger/40 px-3 py-2 text-xs text-danger">{error}</p>
      )}

      {/* ── Explainer ── */}
      {explainerOpen && (
        <div className="rounded-lg border border-border bg-bg p-4 text-sm text-text-muted">
          <p className="mb-2">
            {t.rich("explanationIntro", {
              strong: (chunks) => <strong className="text-text-main">{chunks}</strong>,
            })}
          </p>
          <ol className="ml-4 list-decimal space-y-1.5">
            <li>
              {t.rich("explanationActiveProfile", {
                strong: (chunks) => <strong className="text-text-main">{chunks}</strong>,
              })}
            </li>
            <li>
              {t.rich("explanationDefault", {
                strong: (chunks) => <strong className="text-text-main">{chunks}</strong>,
              })}
            </li>
            <li>
              {t.rich("explanationNamedCombos", {
                strong: (chunks) => <strong className="text-text-main">{chunks}</strong>,
              })}
            </li>
            <li>
              {t.rich("explanationPreview", {
                strong: (chunks) => <strong className="text-text-main">{chunks}</strong>,
              })}
            </li>
          </ol>
        </div>
      )}

      {/* ── Active profile ── */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg p-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="active-profile" className="text-sm font-semibold text-text-main">
            {t("activeProfile")}
          </label>
          <p className="text-xs text-text-muted">{t("activeProfileDescription")}</p>
        </div>
        <select
          id="active-profile"
          data-testid="active-profile-select"
          value={settings?.activeComboId ?? ""}
          onChange={(e) => saveSettings({ activeComboId: e.target.value || null })}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main"
        >
          <option value="">{t("defaultFromPanel")}</option>
          {combos.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div
          data-testid="active-profile-preview"
          className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-text-muted"
        >
          {activeCombo ? (
            <span>
              {t("runs")} <span className="font-mono text-text-main">{activePipelineText}</span>
            </span>
          ) : (
            <span>
              {t("defaultConfiguredPrefix")}{" "}
              <a href="/dashboard/context/settings" className="underline hover:text-text-main">
                {t("compressionSettings")}
              </a>
              .
            </span>
          )}
        </div>
      </div>

      {/* ── Provider-delegated compression ── */}
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-text-main">{t("providerDelegated")}</h2>
        <div className="flex items-center gap-3 rounded-lg border border-border bg-bg p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text-main">{t("contextEditingClaude")}</p>
            <p className="text-xs text-text-muted">{t("contextEditingDescription")}</p>
          </div>
          <Toggle
            checked={!!settings?.contextEditing?.enabled}
            onChange={() =>
              saveSettings({ contextEditing: { enabled: !settings?.contextEditing?.enabled } })
            }
            ariaLabel={t("contextEditingAria")}
          />
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-500">
          <span className="material-symbols-outlined text-[16px]">info</span>
          <span>{t("contextEditingNote")}</span>
        </div>
      </div>
    </section>
  );
}
