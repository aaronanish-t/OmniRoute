"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import { CardSkeleton } from "@/shared/components/Loading";
import { ConfirmModal } from "@/shared/components/Modal";
import { matchesSearch } from "@/shared/utils/turkishText";
import { useTeamCosts, useTeamList } from "./teams/useTeamCosts";
import { readJson, errorKey, type Team, type Period, type TeamKeyOption } from "./teams/helpers";
import TeamBudgetCard from "./teams/TeamBudgetCard";
import TeamReport from "./teams/TeamReport";
import TeamMembership from "./teams/TeamMembership";
import TeamForm, { type TeamPayload } from "./teams/TeamForm";

type Confirmation =
  | { kind: "archive"; team: Team }
  | { kind: "remove"; team: Team; keyId: string }
  | { kind: "transfer"; team: Team; key: TeamKeyOption };

function Loading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-4 motion-safe:animate-pulse">
      {[1, 2, 3].map((key) => (
        <CardSkeleton key={key} />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

export default function TeamCostsPage() {
  const t = useTranslations("teamCosts");
  const router = useRouter();
  const params = useSearchParams();
  const requestedId = params.get("team") ?? "";
  const [period, setPeriod] = useState<Period>("30d");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("active");
  const [pending, setPending] = useState(false);
  const [form, setForm] = useState<{ team: Team | null } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [mutationError, setMutationError] = useState("");
  const [missingId, setMissingId] = useState("");
  // The URL owns selection. A valid archived deep link is visible until the user filters.
  const preliminary = useTeamList();
  const refreshList = preliminary.refresh;
  const visible = (preliminary.list?.teams ?? []).filter(
    (team) =>
      team.id !== missingId &&
      (filter === "all" ||
        team.status === filter ||
        (requestedId === team.id && team.status === "archived" && filter === "active" && !query)) &&
      matchesSearch(team.name, query)
  );
  const selectedId = visible.some((team) => team.id === requestedId)
    ? requestedId
    : (visible[0]?.id ?? "");
  const data = useTeamCosts(selectedId, period);
  const select = useCallback(
    (id: string, replace = false) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set("team", id);
      else next.delete("team");
      const url = `/dashboard/costs/teams${next.size ? "?" + next.toString() : ""}`;
      if (replace) router.replace(url);
      else router.push(url);
    },
    [params, router]
  );
  useEffect(() => {
    if (preliminary.list && requestedId !== selectedId) select(selectedId, true);
    // URL normalization only; no React state updates inside the effect.
  }, [preliminary.list, requestedId, selectedId, select]);
  useEffect(() => {
    if (data.detailError === "notFound") {
      select("", true);
      void Promise.resolve().then(() => setMissingId(selectedId));
      void refreshList().catch(() => {});
    }
  }, [data.detailError, selectedId, select, refreshList]);
  const detail = data.data?.detail;
  const blocked = pending || Boolean(form || confirmation);
  async function refresh() {
    setMutationError("");
    // Each hook reports its own failure, so one failed read must not skip the other.
    await Promise.allSettled([preliminary.refresh(), data.reloadDetail()]);
  }
  async function perform(url: string, method: string, body?: unknown): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setMutationError("");
    try {
      await readJson(url, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      // The write already succeeded. Each read hook owns and displays its refresh error;
      // never leave a successful mutation ready to replay just because a read failed.
      await Promise.allSettled([preliminary.refresh(), data.reloadDetail()]);
      return true;
    } catch (error) {
      setMutationError(errorKey(error));
      return false;
    } finally {
      setPending(false);
    }
  }
  async function save(payload: TeamPayload) {
    if (!form || pending) return;
    const target = form.team;
    setPending(true);
    setMutationError("");
    try {
      const result = await readJson<{ team: Team }>(
        target ? `/api/teams/${target.id}` : "/api/teams",
        {
          method: target ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      // The write already succeeded. Each read hook owns and displays its refresh error;
      // never leave a successful mutation ready to replay just because a read failed.
      await Promise.allSettled([preliminary.refresh(), data.reloadDetail()]);
      select(result.team.id);
      setForm(null);
    } catch (error) {
      setMutationError(errorKey(error));
    } finally {
      setPending(false);
    }
  }
  async function assign(key: TeamKeyOption) {
    if (!detail || blocked || detail.team.status !== "active") return;
    const target = detail.team;
    if (key.teamId && key.teamId !== target.id) {
      setMutationError("");
      setConfirmation({ kind: "transfer", team: target, key });
      return;
    }
    await perform(`/api/teams/${target.id}/members`, "PUT", {
      apiKeyId: key.id,
      expectedTeamId: key.teamId,
    });
  }
  async function confirm() {
    if (!confirmation || pending) return;
    const operation = confirmation;
    const url = `/api/teams/${operation.team.id}`;
    const ok =
      operation.kind === "transfer"
        ? await perform(url + "/members", "PUT", {
            apiKeyId: operation.key.id,
            expectedTeamId: operation.key.teamId,
          })
        : operation.kind === "remove"
          ? await perform(
              url + `/members?apiKeyId=${encodeURIComponent(operation.keyId)}`,
              "DELETE"
            )
          : await perform(url, "DELETE");
    if (ok) {
      setConfirmation(null);
      if (operation.kind === "archive") select("", true);
    }
  }
  return (
    <div className="mx-auto max-w-[1440px] p-4 md:p-6 space-y-6 text-text-main">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="mt-1 text-sm text-text-muted">{t("subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            icon="refresh"
            disabled={blocked}
            onClick={() => void refresh()}
          >
            {t("refresh")}
          </Button>
          <Button
            icon="add"
            disabled={blocked || Boolean(preliminary.listError)}
            onClick={() => {
              setMutationError("");
              setForm({ team: null });
            }}
          >
            {t("create")}
          </Button>
        </div>
      </div>
      {(preliminary.listError || (!form && !confirmation && mutationError)) && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t(preliminary.listError || mutationError)}
        </p>
      )}
      {!preliminary.list && !preliminary.listError ? (
        <Loading label={t("loading")} />
      ) : (
        <div className="space-y-5">
          <Card padding="sm">
            <fieldset
              disabled={blocked}
              className="grid grid-cols-2 items-end gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_12rem]"
            >
              <Select
                label={t("selectTeam")}
                aria-label={t("selectTeam")}
                className="col-span-2 min-w-0 lg:col-span-1"
                value={selectedId}
                onChange={(e) => select(e.target.value)}
              >
                {!visible.length && <option value="">{t("noTeams")}</option>}
                {visible.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </Select>
              <div className="min-w-0">
                <Input
                  label={t("searchTeams")}
                  icon="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <Select
                label={t("statusFilter")}
                aria-label={t("statusFilter")}
                className="min-w-0"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  select("", true);
                }}
              >
                <option value="active">{t("active")}</option>
                <option value="archived">{t("archived")}</option>
                <option value="all">{t("allTeams")}</option>
              </Select>
            </fieldset>
            {!visible.length && <p className="mt-3 text-sm text-text-muted">{t("noTeams")}</p>}
          </Card>
          <main className="min-w-0 space-y-5">
            {data.detailError && (
              <p role="alert" className="text-red-600 dark:text-red-400">
                {t(data.detailError)}
              </p>
            )}
            {data.loading ? (
              <Loading label={t("loading")} />
            ) : detail && data.data ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-xl font-semibold break-words">{detail.team.name}</h2>
                    <p className="text-xs mt-1 text-text-muted">{t(detail.team.status)}</p>
                    {detail.team.description && (
                      <p className="mt-2 text-sm text-text-muted break-words whitespace-pre-wrap">
                        {detail.team.description}
                      </p>
                    )}
                  </div>
                  {detail.team.status === "active" && (
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={blocked}
                        onClick={() => {
                          setMutationError("");
                          setForm({ team: detail.team });
                        }}
                      >
                        {t("edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={blocked}
                        onClick={() => {
                          setMutationError("");
                          setConfirmation({ kind: "archive", team: detail.team });
                        }}
                      >
                        {t("archive")}
                      </Button>
                    </div>
                  )}
                </div>
                <TeamBudgetCard detail={detail} />
                <TeamReport
                  report={data.data.report}
                  memberCount={detail.members.length}
                  period={period}
                  pending={blocked}
                  onPeriod={setPeriod}
                />
                <TeamMembership
                  key={detail.team.id}
                  detail={detail}
                  options={preliminary.list?.keyOptions ?? []}
                  pending={blocked}
                  onAssign={(key) => void assign(key)}
                  onRemove={(keyId) => {
                    if (!blocked) {
                      setMutationError("");
                      setConfirmation({ kind: "remove", team: detail.team, keyId });
                    }
                  }}
                />
              </>
            ) : (
              !data.detailError &&
              !data.loading && (
                <Card>
                  <p className="text-text-muted">{t("selectHint")}</p>
                </Card>
              )
            )}
          </main>
        </div>
      )}
      {form && (
        <TeamForm
          team={form.team}
          pending={pending}
          error={mutationError}
          onClose={() => {
            if (!pending) setForm(null);
          }}
          onSave={save}
        />
      )}
      <ConfirmModal
        isOpen={Boolean(confirmation)}
        loading={pending}
        title={t(
          confirmation?.kind === "transfer"
            ? "transferTitle"
            : confirmation?.kind === "remove"
              ? "removeTitle"
              : "archiveTitle"
        )}
        confirmText={t("confirm")}
        cancelText={t("cancel")}
        onClose={() => {
          if (!pending) setConfirmation(null);
        }}
        onConfirm={confirm}
        message={
          <>
            {confirmation && (
              <span>
                {confirmation.kind === "transfer"
                  ? t("transferMessage", {
                      source: confirmation.key.teamName || t("unassigned"),
                      destination: confirmation.team.name,
                    })
                  : t(confirmation.kind === "remove" ? "removeMessage" : "archiveMessage", {
                      team: confirmation.team.name,
                    })}
              </span>
            )}
            {mutationError && (
              <span role="alert" className="block mt-3 text-red-600 dark:text-red-400">
                {t(mutationError)}
              </span>
            )}
          </>
        }
      />
    </div>
  );
}
