"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Card,
  Button,
  Input,
  Modal,
  ConfirmModal,
  EmptyState,
  SegmentedControl,
} from "@/shared/components";
import { matchesSearch } from "@/shared/utils/turkishText";

type Team = {
  id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  maxBudgetUsd: number | null;
  budgetDuration: "1d" | "7d" | "30d" | null;
  budgetResetAt: string | null;
};
type Member = { apiKeyId: string; apiKeyName: string; assignedAt: string };
type Report = {
  summary: {
    requests: number;
    successfulRequests: number;
    inputTokens: number;
    outputTokens: number;
    estimatedListCostUsd: number;
    hasUnpricedUsage: boolean;
  };
  byApiKey: Array<{
    apiKeyId: string;
    apiKeyName: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    estimatedListCostUsd: number;
    hasUnpricedUsage: boolean;
  }>;
};
type KeyChoice = { id: string; name: string; status?: string };

const money = (n: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n < 0.01 && n > 0 ? 6 : 2,
  }).format(n);
const periodDays = (period: string) => (period === "7d" ? 7 : period === "30d" ? 30 : null);
const dateRange = (period: string) => {
  const days = periodDays(period);
  if (!days) return {};
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
};

export default function TeamCostsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedId, setSelectedId] = useState(params.get("team") || "");
  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [keys, setKeys] = useState<KeyChoice[]>([]);
  const [period, setPeriod] = useState("30d");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [transfer, setTransfer] = useState<KeyChoice | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", budget: "", duration: "30d" });
  const [formError, setFormError] = useState("");
  const filteredTeams = useMemo(
    () =>
      teams.filter(
        (t) =>
          (statusFilter === "all" || t.status === statusFilter) &&
          matchesSearch(t.name, query)
      ),
    [teams, statusFilter, query]
  );
  const loadTeams = useCallback(async () => {
    const r = await fetch("/api/teams?includeArchived=true");
    if (!r.ok)
      throw new Error(
        r.status === 401
          ? "请先登录管理后台"
          : r.status === 403
            ? "当前账号没有团队管理权限"
            : "团队列表加载失败"
      );
    const d = await r.json();
    setTeams(d.teams || []);
    return d.teams || [];
  }, []);
  const loadDetail = useCallback(
    async (id: string) => {
      if (!id) {
        setTeam(null);
        setMembers([]);
        setReport(null);
        return;
      }
      const current = id;
      setLoading(true);
      setError("");
      try {
        const [a, b] = await Promise.all([
          fetch(`/api/teams/${id}`),
          fetch(
            `/api/teams/${id}/usage?${new URLSearchParams(dateRange(period) as Record<string, string>)}`
          ),
        ]);
        if (current !== selectedId) return;
        if (!a.ok) throw new Error(a.status === 404 ? "团队不存在或已被删除" : "团队详情加载失败");
        if (!b.ok) throw new Error("报告加载失败");
        const ad = await a.json();
        const bd = await b.json();
        setTeam(ad.team);
        setMembers(ad.members || []);
        setReport(bd.report || null);
      } catch (e) {
        if (current === selectedId) setError(e instanceof Error ? e.message : "加载失败");
      } finally {
        if (current === selectedId) setLoading(false);
      }
    },
    [period, selectedId]
  );
  useEffect(() => {
    loadTeams().catch((e) => setError(e.message));
    fetch("/api/keys?limit=200")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) =>
        setKeys((d?.keys || []).map((k: any) => ({ id: k.id, name: k.name, status: k.status })))
      );
  }, [loadTeams]);
  useEffect(() => {
    const id = params.get("team") || selectedId;
    if (id !== selectedId) setSelectedId(id);
  }, [params, selectedId]);
  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
  }, [selectedId, period, loadDetail]);
  const select = (id: string) => {
    setSelectedId(id);
    router.replace(`/dashboard/costs/teams?team=${encodeURIComponent(id)}`);
  };
  const openCreate = () => {
    setForm({ name: "", description: "", budget: "", duration: "30d" });
    setFormError("");
    setModal("create");
  };
  const openEdit = () => {
    if (!team) return;
    setForm({
      name: team.name,
      description: team.description,
      budget: team.maxBudgetUsd?.toString() || "",
      duration: team.budgetDuration || "30d",
    });
    setFormError("");
    setModal("edit");
  };
  const save = async () => {
    if (!form.name.trim()) {
      setFormError("请输入团队名称");
      return;
    }
    if (form.budget && (!Number.isFinite(Number(form.budget)) || Number(form.budget) <= 0)) {
      setFormError("预算必须是大于 0 的金额");
      return;
    }
    if (form.budget && !form.duration) {
      setFormError("请选择预算周期");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim(),
        maxBudgetUsd: form.budget ? Number(form.budget) : null,
        budgetDuration: form.budget ? form.duration : null,
      };
      const r = await fetch(modal === "create" ? "/api/teams" : `/api/teams/${team?.id}`, {
        method: modal === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || d?.error || "保存失败");
      setModal(null);
      await loadTeams();
      const id = d.team?.id || team?.id;
      if (id) {
        setSelectedId(id);
        select(id);
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };
  const archive = async () => {
    if (!team) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/teams/${team.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("归档失败");
      setArchiveOpen(false);
      await loadTeams();
      setSelectedId("");
      router.replace("/dashboard/costs/teams");
    } catch (e) {
      setError(e instanceof Error ? e.message : "归档失败");
    } finally {
      setSaving(false);
    }
  };
  const assign = async (k: KeyChoice) => {
    if (!team) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/teams/${team.id}/members`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKeyId: k.id }),
      });
      if (r.status === 409) {
        setTransfer(k);
        return;
      }
      if (!r.ok) throw new Error("分配失败");
      await loadDetail(team.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "分配失败");
    } finally {
      setSaving(false);
    }
  };
  const unassign = async (id: string) => {
    if (!team) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/teams/${team.id}/members?apiKeyId=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error("移除失败");
      await loadDetail(team.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "移除失败");
    } finally {
      setSaving(false);
    }
  };
  const total = report?.summary.estimatedListCostUsd || 0;
  const budget = team?.maxBudgetUsd;
  const shareMax = Math.max(...(report?.byApiKey || []).map((x) => x.estimatedListCostUsd), 1);
  return (
    <div className="p-6 md:p-8 max-w-[1500px] mx-auto space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs text-text-muted mb-2">
            <span>Costs</span>
            <span>/</span>
            <span>Teams</span>
          </div>
          <h1 className="text-2xl font-semibold text-text-main">Team cost centers</h1>
          <p className="text-sm text-text-muted mt-1">管理团队归属、报告费用与当前预算窗口。</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            icon="refresh"
            onClick={() => {
              loadTeams();
              selectedId && loadDetail(selectedId);
            }}
          >
            刷新
          </Button>
          <Button icon="add" onClick={openCreate}>
            新建团队
          </Button>
        </div>
      </div>
      {error && (
        <div
          className="rounded-control border border-red-300/50 bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300 px-4 py-3 text-sm"
          role="alert"
        >
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] gap-6 items-start">
        <Card padding="sm" className="lg:sticky lg:top-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">团队</h2>
            <span className="text-xs text-text-muted">{filteredTeams.length}</span>
          </div>
          <Input
            icon="search"
            placeholder="搜索团队"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="mt-3">
            <SegmentedControl
              options={[
                { value: "active", label: "活跃" },
                { value: "archived", label: "已归档" },
                { value: "all", label: "全部" },
              ]}
              value={statusFilter}
              onChange={setStatusFilter}
            />
          </div>
          <div className="mt-3 space-y-1 max-h-[55vh] overflow-auto">
            {filteredTeams.map((t) => (
              <button
                key={t.id}
                onClick={() => select(t.id)}
                className={`w-full text-left rounded-control px-3 py-3 transition-colors ${selectedId === t.id ? "bg-accent/10 ring-1 ring-accent/30" : "hover:bg-black/[.04] dark:hover:bg-white/[.05]"}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`size-2 rounded-full ${t.status === "active" ? "bg-emerald-500" : "bg-slate-400"}`}
                  />
                  <span className="font-medium truncate">{t.name}</span>
                </div>
                <p className="text-xs text-text-muted mt-1 truncate">
                  {t.description || "未添加描述"}
                </p>
              </button>
            ))}
            {!filteredTeams.length && (
              <EmptyState
                icon="groups"
                title="没有匹配的团队"
                description="创建一个团队成本中心开始管理。"
                action={
                  <Button size="sm" onClick={openCreate}>
                    新建团队
                  </Button>
                }
              />
            )}
          </div>
        </Card>
        {!selectedId ? (
          <Card className="min-h-[440px] flex items-center justify-center">
            <EmptyState
              icon="monitoring"
              title="选择一个团队"
              description="从左侧选择团队，查看报告、预算与 API Key 归属。"
            />
          </Card>
        ) : loading ? (
          <Card className="min-h-[440px] flex items-center justify-center">
            <div className="text-sm text-text-muted">加载团队数据…</div>
          </Card>
        ) : team ? (
          <div className="space-y-6">
            <Card>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-semibold truncate max-w-[min(70vw,700px)]">
                      {team.name}
                    </h2>
                    <span
                      className={`text-xs px-2 py-1 rounded-full ${team.status === "active" ? "bg-emerald-500/10 text-emerald-600" : "bg-slate-500/10 text-slate-500"}`}
                    >
                      {team.status === "active" ? "活跃" : "已归档"}
                    </span>
                  </div>
                  <p className="text-sm text-text-muted mt-2 max-w-2xl">
                    {team.description || "暂无描述"}
                  </p>
                </div>
                <div className="flex gap-2">
                  {team.status === "active" && (
                    <>
                      <Button variant="secondary" size="sm" icon="edit" onClick={openEdit}>
                        编辑
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        icon="archive"
                        onClick={() => setArchiveOpen(true)}
                      >
                        归档
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </Card>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Card padding="sm">
                <p className="text-xs text-text-muted">报告估算费用（{period}）</p>
                <p className="text-2xl font-semibold mt-2">{money(total)}</p>
                <p className="text-xs text-text-muted mt-1">目录价估算，不是发票金额</p>
              </Card>
              <Card padding="sm">
                <p className="text-xs text-text-muted">请求数</p>
                <p className="text-2xl font-semibold mt-2">
                  {(report?.summary.requests || 0).toLocaleString()}
                </p>
                <p className="text-xs text-text-muted mt-1">
                  成功 {(report?.summary.successfulRequests || 0).toLocaleString()}
                </p>
              </Card>
              <Card padding="sm">
                <p className="text-xs text-text-muted">已分配 API Key</p>
                <p className="text-2xl font-semibold mt-2">{members.length}</p>
                <p className="text-xs text-text-muted mt-1">仅显示名称，不显示密钥</p>
              </Card>
            </div>
            <Card
              title="预算窗口"
              subtitle="预算内成功用量 · UTC 窗口"
              action={
                <SegmentedControl
                  options={[
                    { value: "7d", label: "7 天" },
                    { value: "30d", label: "30 天" },
                    { value: "all", label: "全部" },
                  ]}
                  value={period}
                  onChange={setPeriod}
                />
              }
            >
              <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
                <div>
                  <p className="text-sm text-text-muted">
                    {budget ? `软预算 ${money(budget)} / ${team.budgetDuration}` : "未设置软预算"}
                  </p>
                  <p className="text-3xl font-semibold mt-1">
                    {budget ? "待后端预算状态" : "无限制"}
                  </p>
                  {budget && (
                    <p className="text-xs text-amber-600 mt-2">
                      当前窗口成功用量由预算服务计算；报告费用不会用于判断是否超额。
                    </p>
                  )}
                </div>
                {team.budgetResetAt && (
                  <div className="text-sm text-text-muted">
                    重置于 {new Date(team.budgetResetAt).toLocaleString()}
                  </div>
                )}
              </div>
              {budget && (
                <div className="h-2 bg-black/10 dark:bg-white/10 rounded-full mt-5">
                  <div className="h-full bg-amber-500 rounded-full" style={{ width: "0%" }} />
                </div>
              )}
            </Card>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <Card title="按 API Key 的报告费用" subtitle="当前报告周期内所有尝试的目录价估算">
                <div className="flex justify-end mb-3">
                  <SegmentedControl
                    options={[
                      { value: "7d", label: "7 天" },
                      { value: "30d", label: "30 天" },
                      { value: "all", label: "全部" },
                    ]}
                    value={period}
                    onChange={setPeriod}
                  />
                </div>
                {report?.byApiKey.length ? (
                  <div className="space-y-4">
                    {report.byApiKey.map((row) => (
                      <div key={row.apiKeyId}>
                        <div className="flex justify-between gap-3 text-sm">
                          <span className="truncate">{row.apiKeyName}</span>
                          <span className="tabular-nums">{money(row.estimatedListCostUsd)}</span>
                        </div>
                        <div className="h-2 bg-black/10 dark:bg-white/10 rounded-full mt-2">
                          <div
                            className="h-full bg-accent rounded-full"
                            style={{
                              width: `${Math.max(2, (row.estimatedListCostUsd / shareMax) * 100)}%`,
                            }}
                          />
                        </div>
                        <p className="text-xs text-text-muted mt-1">
                          {row.requests.toLocaleString()} 次请求 ·{" "}
                          {(row.inputTokens + row.outputTokens).toLocaleString()} tokens{" "}
                          {row.hasUnpricedUsage && (
                            <span className="text-amber-600">· 未知定价</span>
                          )}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon="bar_chart"
                    title="暂无报告数据"
                    description="该周期内还没有可展示的请求。"
                  />
                )}
              </Card>
              <Card title="成员与归属" subtitle="转移会保留历史费用记录">
                <div className="flex gap-2 mb-4">
                  <select
                    aria-label="选择 API Key"
                    className="flex-1 rounded-control border border-border bg-transparent px-3 py-2 text-sm"
                    onChange={(e) => {
                      const k = keys.find((x) => x.id === e.target.value);
                      if (k) assign(k);
                    }}
                    value=""
                  >
                    <option value="">选择要分配的 API Key…</option>
                    {keys
                      .filter((k) => !members.some((m) => m.apiKeyId === k.id))
                      .map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.name}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="space-y-2">
                  {members.map((m) => (
                    <div
                      key={m.apiKeyId}
                      className="flex items-center justify-between gap-3 rounded-control border border-border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{m.apiKeyName}</p>
                        <p className="text-xs text-text-muted">
                          加入于 {new Date(m.assignedAt).toLocaleDateString()}
                        </p>
                      </div>
                      {team.status === "active" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="remove_circle"
                          aria-label={`移除 ${m.apiKeyName}`}
                          onClick={() => unassign(m.apiKeyId)}
                        >
                          移除
                        </Button>
                      )}
                    </div>
                  ))}
                  {!members.length && (
                    <p className="text-sm text-text-muted py-4">
                      暂无成员。选择 API Key 后即可分配。
                    </p>
                  )}
                </div>
              </Card>
            </div>
          </div>
        ) : (
          <Card>
            <EmptyState icon="error" title="团队不可用" description={error || "请重新选择团队。"} />
          </Card>
        )}
      </div>
      <Modal
        isOpen={modal !== null}
        onClose={() => !saving && setModal(null)}
        title={modal === "create" ? "新建团队" : "编辑团队"}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setModal(null)} disabled={saving}>
              取消
            </Button>
            <Button onClick={save} loading={saving}>
              保存
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Input
            label="团队名称"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            error={formError}
          />
          <Input
            label="描述"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <div className="rounded-control border border-border p-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(form.budget)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    budget: e.target.checked ? team?.maxBudgetUsd?.toString() || "10" : "",
                  })
                }
              />
              启用软预算
            </label>
            {form.budget && (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <Input
                  label="金额（USD）"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={form.budget}
                  onChange={(e) => setForm({ ...form, budget: e.target.value })}
                />
                <label className="text-sm font-medium">
                  周期
                  <select
                    className="mt-1 w-full rounded-control border border-border bg-transparent px-3 py-2"
                    value={form.duration}
                    onChange={(e) => setForm({ ...form, duration: e.target.value })}
                  >
                    <option value="1d">每天</option>
                    <option value="7d">每 7 天</option>
                    <option value="30d">每 30 天</option>
                  </select>
                </label>
              </div>
            )}
            <p className="text-xs text-text-muted mt-2">关闭预算会同时清空金额与周期。</p>
          </div>
        </div>
      </Modal>
      <ConfirmModal
        isOpen={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        onConfirm={archive}
        loading={saving}
        title="归档团队？"
        message="归档会停止新的 API Key 分配，并保留历史报告与成员归属记录。"
        confirmText="归档团队"
        variant="danger"
      />
      <ConfirmModal
        isOpen={Boolean(transfer)}
        onClose={() => setTransfer(null)}
        onConfirm={async () => {
          if (transfer) {
            setTransfer(null);
            await assign(transfer);
          }
        }}
        loading={saving}
        title="转移 API Key？"
        message={`${transfer?.name || "该 API Key"} 已属于其他团队。确认转移后，历史费用仍保留在原团队的有效归属期间。`}
        confirmText="确认转移"
      />
    </div>
  );
}
