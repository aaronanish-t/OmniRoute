"use client";

import { useEffect, useState } from "react";

type Model = {
  fullModel: string;
  available?: boolean;
};
type CompressionEngine = {
  id: string;
  name: string;
  description: string;
};

type IntegrityGuidance = {
  level: "Near-lossless" | "Low risk" | "Moderate" | "High" | "Very high";
  detail: string;
  hint: string;
};

const ENGINE_INTEGRITY: Record<string, IntegrityGuidance> = {
  lite: {
    level: "Near-lossless",
    detail: "Formatting cleanup and conservative reductions; wording should remain intact.",
    hint: "Good default for ordinary prose. Check formatting-sensitive prompts after enabling.",
  },
  headroom: {
    level: "Near-lossless",
    detail: "Reshapes eligible homogeneous tables; it does not summarize ordinary prose.",
    hint: "Best suited to large, regular JSON arrays where the compact structure is understood.",
  },
  "codex-responses": {
    level: "Low risk",
    detail:
      "Targets supported structured Responses tool output and keeps unsupported content unchanged.",
    hint: "May do nothing on a chat-completions request or an unsupported output shape.",
  },
  rtk: {
    level: "Low risk",
    detail:
      "Command-aware cleanup removes recognized terminal noise while retaining actionable output.",
    hint: "Use for shell/build/test logs; inspect unusual output because matching filters can omit lines.",
  },
  caveman: {
    level: "Moderate",
    detail: "Rule-based prose condensation can change phrasing and remove nuance.",
    hint: "Review prompts where exact wording, caveats, or tone matter.",
  },
  aggressive: {
    level: "High",
    detail: "Summarizes and ages content; details may be omitted even when the gist remains.",
    hint: "Prefer only when shorter prompts matter more than preserving every detail.",
  },
  ultra: {
    level: "Very high",
    detail: "Heuristic pruning may remove sentences or truncate content.",
    hint: "Treat the result as lossy; verify any facts, constraints, or code the model must retain.",
  },
  llmlingua: {
    level: "High",
    detail: "Semantic token pruning can remove words that appear less important to its scorer.",
    hint: "Check names, numbers, negation, and exact instructions in the compressed prompt.",
  },
  relevance: {
    level: "High",
    detail: "Extractive scoring drops sentences judged less relevant to the current request.",
    hint: "Useful for focused questions; can discard context needed for a later follow-up.",
  },
  llm: {
    level: "High",
    detail: "A model-generated rewrite is not guaranteed to preserve every fact or qualification.",
    hint: "Validate exact identifiers, amounts, code, and requirements before relying on it.",
  },
  ionizer: {
    level: "Very high",
    detail:
      "Samples large arrays and omits rows from the inline prompt; omitted content may be needed later.",
    hint: "Use only for large homogeneous data when representative rows are sufficient.",
  },
  "read-lifecycle": {
    level: "High",
    detail: "Removes content classified as superseded by later reads; that judgment can be wrong.",
    hint: "Use only when newer content reliably replaces older content in the same prompt.",
  },
  omniglyph: {
    level: "Very high",
    detail:
      "Changes the prompt representation and may encode text as an image for supported routes.",
    hint: "Provider/model support and visual fidelity are required; verify the actual transmitted input.",
  },
};

export function getIntegrityGuidance(engineId: string): IntegrityGuidance {
  return (
    ENGINE_INTEGRITY[engineId] ?? {
      level: "High",
      detail:
        "This pass may rewrite or omit information; its exact preservation behavior is not classified.",
      hint: "Treat as lossy until you validate its output on representative prompts.",
    }
  );
}

interface GrevCachingSettings {
  enabled: boolean;
  excludedModelKeys: string[];
  excludedComboIds: string[];
  triggerPercent: number;
  preserveRecentPercent: number;
  minArchiveChars: number;
  minRetainedMessages: number;
  maxArchiveSectionChars: number;
  newBlockPipeline: string[];
}

const DEFAULTS: GrevCachingSettings = {
  enabled: false,
  excludedModelKeys: [],
  excludedComboIds: [],
  triggerPercent: 90,
  preserveRecentPercent: 10,
  minArchiveChars: 600,
  minRetainedMessages: 2,
  maxArchiveSectionChars: 32_000,
  newBlockPipeline: [],
};

function toggle(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function GrevCachingPage() {
  const [settings, setSettings] = useState<GrevCachingSettings>(DEFAULTS);
  const [models, setModels] = useState<Model[]>([]);
  const [engines, setEngines] = useState<CompressionEngine[]>([]);
  const [modelToExclude, setModelToExclude] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch("/api/settings/compression").then((response) => (response.ok ? response.json() : null)),
      fetch("/api/models").then((response) => (response.ok ? response.json() : null)),
      fetch("/api/compression/engines").then((response) => (response.ok ? response.json() : null)),
    ])
      .then(([compression, modelData, engineData]) => {
        if (cancelled) return;
        const stored = compression?.grevCaching;
        setSettings({
          ...DEFAULTS,
          ...(stored && typeof stored === "object" ? stored : {}),
          // Saving from this page intentionally migrates legacy opt-in lists to
          // the new exclusion model: compatible configured models are included by default.
          excludedModelKeys:
            stored && Array.isArray(stored.excludedModelKeys) ? stored.excludedModelKeys : [],
          // Combo-level exclusions are replaced by the unified model exclusion list.
          excludedComboIds: [],
          newBlockPipeline:
            stored && Array.isArray(stored.newBlockPipeline) ? stored.newBlockPipeline : [],
        });
        setModels(
          Array.isArray(modelData?.models)
            ? modelData.models.filter((model: Model) => model.available !== false)
            : []
        );
        // GrevCaching has its own pipeline; offer the full registered engine catalog
        // regardless of the normal stack's master or per-engine toggles. Only the
        // archival engine itself is excluded to prevent recursive execution.
        setEngines(
          Array.isArray(engineData?.engines)
            ? engineData.engines
                .filter((engine: CompressionEngine) => engine.id !== "append-preserving-ccr")
                .map((engine: CompressionEngine) => ({
                  id: engine.id,
                  name: engine.name,
                  description: engine.description,
                }))
            : []
        );
      })
      .catch(() => !cancelled && setError("Unable to load GrevCaching settings."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const updateNumber = (key: keyof GrevCachingSettings, value: string) => {
    const number = Number(value);
    if (Number.isFinite(number))
      setSettings((current) => ({ ...current, [key]: Math.floor(number) }));
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/settings/compression", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grevCaching: settings }),
      });
      if (!response.ok) throw new Error("save failed");
    } catch {
      setError("Unable to save GrevCaching settings.");
    } finally {
      setSaving(false);
    }
  };
  if (loading) return <div className="p-6 text-sm text-text-muted">Loading GrevCaching…</div>;

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-text">GrevCaching</h1>
        <p className="mt-1 text-sm text-text-muted">
          Preserves the existing prompt prefix for provider KV-cache reuse. Enable it from
          Compression Settings; models in the exclusion list stay on OmniRoute’s normal path.
        </p>
      </div>
      <a
        href="/dashboard/context/grevcaching/analytics"
        className="w-fit rounded border border-border bg-surface px-3 py-2 text-sm font-medium text-primary hover:underline"
      >
        View detailed GrevCaching analytics â†’
      </a>
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="font-medium text-text">Models to Exclude:</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <select
            aria-label="Add a model to exclude from GrevCaching"
            className="min-w-64 rounded border border-border bg-background px-3 py-2 text-sm text-text"
            value={modelToExclude}
            onChange={(event) => setModelToExclude(event.target.value)}
          >
            <option value="">Select a model…</option>
            {models
              .filter((model) => !settings.excludedModelKeys.includes(model.fullModel))
              .map((model) => (
                <option key={model.fullModel} value={model.fullModel}>
                  {model.fullModel}
                </option>
              ))}
          </select>
          <button
            type="button"
            className="rounded border border-border px-3 py-2 text-sm text-text disabled:opacity-50"
            disabled={!modelToExclude}
            onClick={() => {
              if (!modelToExclude) return;
              setSettings((current) => ({
                ...current,
                excludedModelKeys: [...current.excludedModelKeys, modelToExclude],
              }));
              setModelToExclude("");
            }}
          >
            Add model
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {settings.excludedModelKeys.map((model) => (
            <span
              key={model}
              className="flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-text"
            >
              {model}
              <button
                type="button"
                aria-label={`Remove ${model}`}
                className="text-text-muted hover:text-text"
                onClick={() =>
                  setSettings((current) => ({
                    ...current,
                    excludedModelKeys: current.excludedModelKeys.filter((item) => item !== model),
                  }))
                }
              >
                ×
              </button>
            </span>
          ))}
          {models.length === 0 && <p className="text-sm text-text-muted">No models available.</p>}
        </div>
        <p className="mt-3 text-xs text-text-muted">
          Excluded models use OmniRoute’s normal compression path. GrevCaching processes the current
          request’s new user message only; existing conversation history and CCR tags stay untouched
          between archive rollovers. Choose passes below independently from the normal stack; their
          scope is only this new message.
        </p>
      </section>
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="font-medium text-text">Current-message compression</h2>
        <p className="mt-1 text-xs text-text-muted">
          These options are independent of Global Defaults. GrevCaching selections are saved
          separately and applied only to the newest user message in the active request—not its
          history, tool results, or CCR tags. At rollover, GrevCaching archives old eligible
          conversation separately. Impact ratings are qualitative estimates, not fidelity
          guarantees.
        </p>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {engines.map((engine) => (
            <label
              key={engine.id}
              className="flex min-w-0 items-start gap-4 rounded-lg border border-border bg-background/50 p-4 text-sm text-text transition-colors hover:border-primary/50"
            >
              <input
                className="mt-1 size-4 shrink-0"
                type="checkbox"
                checked={settings.newBlockPipeline.includes(engine.id)}
                onChange={() =>
                  setSettings((current) => ({
                    ...current,
                    newBlockPipeline: toggle(current.newBlockPipeline, engine.id),
                  }))
                }
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{engine.name}</span>
                  <span className="text-[10px] text-text-muted">{engine.id}</span>
                  {(() => {
                    const integrity = getIntegrityGuidance(engine.id);
                    const tone =
                      integrity.level === "Near-lossless" || integrity.level === "Low risk"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                        : integrity.level === "Moderate"
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                          : "border-red-500/40 bg-red-500/10 text-red-400";
                    return (
                      <span
                        className={`rounded border px-2 py-0.5 text-[10px] font-medium ${tone}`}
                      >
                        Impact: {integrity.level}
                      </span>
                    );
                  })()}
                </span>
                <span className="mt-1 block text-xs text-text-muted">{engine.description}</span>
                <span className="mt-2 block text-xs leading-relaxed text-text-muted">
                  {getIntegrityGuidance(engine.id).detail}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-amber-400/90">
                  Hint: {getIntegrityGuidance(engine.id).hint}
                </span>
              </span>
            </label>
          ))}
          {engines.length === 0 && (
            <p className="text-sm text-text-muted">No compression engines are registered.</p>
          )}
        </div>
      </section>
      <section className="grid gap-4 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2">
        {[
          ["triggerPercent", "Archive trigger (%)", 1, 100],
          ["preserveRecentPercent", "Direct tail (%)", 1, 90],
          ["minArchiveChars", "Minimum archive characters", 1, 1000000],
          ["minRetainedMessages", "Minimum direct messages", 1, 100],
          ["maxArchiveSectionChars", "Archive section characters", 1000, 1000000],
        ].map(([key, label, min, max]) => (
          <label key={key} className="flex flex-col gap-1 text-sm text-text">
            {label}
            <input
              className="rounded border border-border bg-background px-2 py-1"
              type="number"
              min={min}
              max={max}
              value={settings[key as keyof GrevCachingSettings] as number}
              onChange={(event) =>
                updateNumber(key as keyof GrevCachingSettings, event.target.value)
              }
            />
          </label>
        ))}
      </section>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex gap-3">
        <button
          type="button"
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save GrevCaching"}
        </button>
        <a
          href="/dashboard/context/settings"
          className="rounded border border-border px-4 py-2 text-sm font-medium text-text"
        >
          Global compression settings
        </a>
      </div>
    </main>
  );
}
