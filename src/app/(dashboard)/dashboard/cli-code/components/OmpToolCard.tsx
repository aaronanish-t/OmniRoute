"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Card, Button } from "@/shared/components";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";

/** omp 18.4 chat roles, in the order omp's /model picker shows them. */
const OMP_ROLES: Array<{ id: string; labelKey: string; descriptionKey: string }> = [
  { id: "default", labelKey: "ompRoleDefault", descriptionKey: "ompRoleDefaultDesc" },
  { id: "smol", labelKey: "ompRoleSmol", descriptionKey: "ompRoleSmolDesc" },
  { id: "slow", labelKey: "ompRoleSlow", descriptionKey: "ompRoleSlowDesc" },
  { id: "plan", labelKey: "ompRolePlan", descriptionKey: "ompRolePlanDesc" },
  { id: "vision", labelKey: "ompRoleVision", descriptionKey: "ompRoleVisionDesc" },
  { id: "task", labelKey: "ompRoleTask", descriptionKey: "ompRoleTaskDesc" },
  { id: "advisor", labelKey: "ompRoleAdvisor", descriptionKey: "ompRoleAdvisorDesc" },
  { id: "commit", labelKey: "ompRoleCommit", descriptionKey: "ompRoleCommitDesc" },
  { id: "tiny", labelKey: "ompRoleTiny", descriptionKey: "ompRoleTinyDesc" },
  { id: "memory", labelKey: "ompRoleMemory", descriptionKey: "ompRoleMemoryDesc" },
];

interface OmpModel {
  id: string;
  name: string;
  input: string[];
  contextWindow: number | null;
  reasoning: boolean;
}

interface OmpRolesState {
  installed: boolean;
  configPath: string;
  modelsPath: string;
  roles: Record<string, string>;
  models: OmpModel[];
}

const PREFIX = "omniroute/";

export default function OmpToolCard({
  tool,
  isExpanded = false,
  onToggle = () => {},
  activeProviders = [],
}: any) {
  const t = useTranslations("cliTools");
  const [state, setState] = useState<OmpRolesState | null>(null);
  // Pending choices made in this session only: role -> "omniroute/<id>" or "" (unset).
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [previewYaml, setPreviewYaml] = useState<string | null>(null);
  const [verifiedRoles, setVerifiedRoles] = useState<Set<string>>(new Set());

  const loadCurrentConfig = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/cli-tools/omp-roles");
      const data = await res.json();
      if (res.ok && data.success) {
        setState({
          installed: !!data.installed,
          configPath: data.configPath,
          modelsPath: data.modelsPath,
          roles: data.roles || {},
          models: data.models || [],
        });
      } else {
        setMessage({ ok: false, text: data.error || t("failedToSave") });
      }
    } catch {
      setMessage({ ok: false, text: t("networkError") });
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!isExpanded) return;
    void (async () => {
      await loadCurrentConfig();
    })();
  }, [isExpanded, loadCurrentConfig]);

  // Models grouped by OmniRoute prefix (cc/, cx/, gc/, …) for the native <select>.
  const modelGroups = useMemo(() => {
    const groups = new Map<string, OmpModel[]>();
    for (const m of state?.models || []) {
      const slash = m.id.indexOf("/");
      const group = slash > 0 ? m.id.slice(0, slash) : "combos";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(m);
    }
    return Array.from(groups.entries());
  }, [state]);

  // OmniRoute prefixes (cc, cx, gc, …) whose provider connection is active. Models under
  // any other prefix are listed but disabled: omp would resolve them, but the router
  // has no active credentials to serve them.
  const activeAliases = useMemo(() => {
    const set = new Set<string>(["combos"]);
    for (const conn of activeProviders as any[]) {
      if (!conn?.provider) continue;
      set.add(PROVIDER_ID_TO_ALIAS[conn.provider] || conn.provider);
      const prefix = conn.providerSpecificData?.prefix;
      if (typeof prefix === "string" && prefix.trim()) set.add(prefix.trim());
    }
    return set;
  }, [activeProviders]);
  const routerKnowsProviders = (activeProviders as any[]).length > 0;

  const knownIds = useMemo(() => new Set((state?.models || []).map((m) => m.id)), [state]);
  const pendingCount = Object.keys(selections).length;

  const setRole = (roleId: string, value: string) => {
    setMessage(null);
    setPreviewYaml(null);
    setSelections((prev) => {
      const onDisk = state?.roles[roleId] || "";
      const next = { ...prev };
      if (value === onDisk.split(":")[0] || value === onDisk) delete next[roleId];
      else next[roleId] = value;
      return next;
    });
  };

  const post = async (preview: boolean) =>
    fetch("/api/cli-tools/omp-roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preview,
        selections: Object.entries(selections).map(([role, model]) => ({ role, model })),
      }),
    });

  const handlePreview = async () => {
    if (previewYaml) {
      setPreviewYaml(null);
      return;
    }
    try {
      const res = await post(true);
      const data = await res.json();
      if (res.ok && data.success) setPreviewYaml(data.yaml);
      else setMessage({ ok: false, text: data.error || t("failedToSave") });
    } catch {
      setMessage({ ok: false, text: t("networkError") });
    }
  };

  const handleApply = async () => {
    if (!state || pendingCount === 0) return;
    if (!window.confirm(t("ompConfirmApply", { count: pendingCount, path: state.configPath }))) {
      return;
    }
    setIsSaving(true);
    setMessage(null);
    try {
      const res = await post(false);
      const data = await res.json();
      if (res.ok && data.success) {
        const changed = new Set(Object.keys(selections));
        setVerifiedRoles(data.verified ? changed : new Set());
        setSelections({});
        setPreviewYaml(null);
        setState((prev) => (prev ? { ...prev, roles: data.roles || {} } : prev));
        setMessage({
          ok: !!data.verified,
          text: data.verified
            ? t("ompSavedVerified", { path: data.configPath, count: changed.size })
            : t("ompSavedUnverified", { path: data.configPath }),
        });
      } else {
        setMessage({ ok: false, text: data.error || t("failedToSave") });
      }
    } catch {
      setMessage({ ok: false, text: t("networkError") });
    } finally {
      setIsSaving(false);
    }
  };

  const configuredCount = OMP_ROLES.filter((r) => state?.roles[r.id]).length;
  const busy = isLoading || isSaving;

  return (
    <Card padding="sm" className="overflow-hidden">
      <div className="flex items-center justify-between hover:cursor-pointer" onClick={onToggle}>
        <div className="flex items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[22px] text-text-muted">terminal</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-sm">{tool?.name || "Oh My Pi"}</h3>
              {state && (
                <span className="text-[10px] px-1.5 py-px rounded bg-emerald-500/10 text-emerald-600">
                  {t("hermesConfiguredRoles", {
                    configured: configuredCount,
                    total: OMP_ROLES.length,
                  })}
                </span>
              )}
            </div>
            <p className="text-xs text-text-muted truncate">{t("toolDescriptions.omp")}</p>
          </div>
        </div>
        <span
          className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}
        >
          expand_more
        </span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={loadCurrentConfig}
              disabled={busy}
              loading={isLoading}
            >
              <span className="material-symbols-outlined text-[14px] mr-1">refresh</span>
              {t("refreshAll")}
            </Button>
          </div>

          {state && !state.installed && (
            <p className="text-xs text-amber-600">
              {t("ompNotInstalled", { path: state.configPath })}
            </p>
          )}
          {state && state.installed && state.models.length === 0 && (
            <p className="text-xs text-amber-600">{t("ompNoModels", { path: state.modelsPath })}</p>
          )}

          <div className="flex flex-col divide-y divide-border">
            {OMP_ROLES.map((role) => {
              const onDisk = state?.roles[role.id] || "";
              const pending = Object.prototype.hasOwnProperty.call(selections, role.id);
              const value = pending ? selections[role.id] : onDisk.split(":")[0];
              const onDiskId = onDisk.startsWith(PREFIX)
                ? onDisk.slice(PREFIX.length).split(":")[0]
                : "";
              const unknownOnDisk =
                onDisk && (!onDisk.startsWith(PREFIX) || !knownIds.has(onDiskId));
              return (
                <div
                  key={role.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-sm text-text-main flex items-center gap-2">
                      {t(role.labelKey)}
                      <code className="text-[10px] text-text-muted">{role.id}</code>
                      {pending && (
                        <span className="text-[10px] px-1.5 py-px rounded bg-amber-500/10 text-amber-600">
                          {t("ompPending")}
                        </span>
                      )}
                      {!pending && verifiedRoles.has(role.id) && (
                        <span className="text-[10px] px-1.5 py-px rounded bg-emerald-500/10 text-emerald-600">
                          {t("ompVerified")}
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] leading-tight text-text-muted">
                      {t(role.descriptionKey)}
                    </div>
                    <div className="text-[10px] text-text-muted mt-0.5">
                      {t("ompOnDisk")}:{" "}
                      <code className={unknownOnDisk ? "text-amber-600" : "text-text-main"}>
                        {onDisk || t("ompUnset")}
                      </code>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <select
                      aria-label={role.id}
                      className="h-9 max-w-[240px] rounded border border-border bg-surface px-2 text-xs text-text-main"
                      value={value}
                      disabled={busy || !state}
                      onChange={(e) => setRole(role.id, e.target.value)}
                    >
                      <option value="">{t("ompUnset")}</option>
                      {unknownOnDisk && !pending && <option value={value}>{value}</option>}
                      {modelGroups.map(([group, models]) => {
                        const inactive = routerKnowsProviders && !activeAliases.has(group);
                        return (
                          <optgroup
                            key={group}
                            label={inactive ? `${group} — ${t("ompInactive")}` : group}
                          >
                            {models.map((m) => (
                              <option
                                key={m.id}
                                value={`${PREFIX}${m.id}`}
                                disabled={inactive && value !== `${PREFIX}${m.id}`}
                              >
                                {inactive ? `${m.id} (${t("ompInactive")})` : m.id}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </select>
                    {pending && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          setSelections((prev) => {
                            const next = { ...prev };
                            delete next[role.id];
                            return next;
                          })
                        }
                      >
                        {t("clear")}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {message && (
            <div
              className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${
                message.ok ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"
              }`}
            >
              <span className="material-symbols-outlined text-[14px]">
                {message.ok ? "check_circle" : "error"}
              </span>
              <span>{message.text}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={handleApply}
              disabled={busy || pendingCount === 0}
              variant="primary"
              size="sm"
              loading={isSaving}
            >
              <span className="material-symbols-outlined text-[14px] mr-1">save</span>
              {t("ompApply")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handlePreview}
              disabled={busy || pendingCount === 0}
            >
              <span className="material-symbols-outlined text-[14px] mr-1">visibility</span>
              {t("preview")}
            </Button>
            {pendingCount > 0 && (
              <span className="text-xs text-text-muted">
                {t("ompRolesWillUpdate", { count: pendingCount })}
              </span>
            )}
          </div>

          {previewYaml && (
            <pre className="p-4 bg-bg-secondary rounded-lg border border-border overflow-auto max-h-80 text-xs">
              <code className="font-mono whitespace-pre text-text-main">{previewYaml}</code>
            </pre>
          )}

          <p className="text-xs text-text-muted">{t("ompSaveDescription")}</p>
        </div>
      )}
    </Card>
  );
}
