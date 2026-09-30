"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Modal from "@/shared/components/Modal";
import type { Team } from "./helpers";
export interface TeamPayload {
  name: string;
  description: string;
  maxBudgetUsd: number | null;
  budgetDuration: "1d" | "7d" | "30d" | null;
}
export default function TeamForm({
  team,
  pending,
  error,
  onClose,
  onSave,
}: {
  team: Team | null;
  pending: boolean;
  error: string;
  onClose: () => void;
  onSave: (payload: TeamPayload) => Promise<void>;
}) {
  const t = useTranslations("teamCosts");
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [enabled, setEnabled] = useState(team?.maxBudgetUsd != null);
  const [amount, setAmount] = useState(team?.maxBudgetUsd?.toString() ?? "");
  const [duration, setDuration] = useState<"1d" | "7d" | "30d">(team?.budgetDuration ?? "30d");
  const [validation, setValidation] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (!name.trim() || name.trim().length > 200 || description.length > 2000) {
      setValidation("invalidName");
      return;
    }
    if (enabled && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
      setValidation("invalidAmount");
      return;
    }
    setValidation("");
    await onSave({
      name: name.trim(),
      description: description.trim(),
      maxBudgetUsd: enabled ? Number(amount) : null,
      budgetDuration: enabled ? duration : null,
    });
  }
  return (
    <Modal
      isOpen
      title={t(team ? "edit" : "create")}
      onClose={() => {
        if (!pending) onClose();
      }}
      closeOnOverlay={!pending}
      showCloseButton={!pending}
    >
      <form onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
        <fieldset disabled={pending} className="space-y-4">
          <Input
            label={t("name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={200}
          />
          <label className="block text-sm">
            {t("description")}
            <textarea
              className="mt-2 w-full rounded-control border border-border bg-bg p-3 text-text-main"
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t("enableBudget")}
          </label>
          <div
            className={`grid motion-safe:transition-[grid-template-rows] motion-safe:duration-200 ${enabled ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
            aria-hidden={!enabled}
          >
            <div className="overflow-hidden">
              <fieldset disabled={!enabled || pending} className="space-y-3">
                <Input
                  label={t("amount")}
                  type="number"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <label className="block text-sm">
                  {t("duration")}
                  <select
                    aria-label={t("duration")}
                    className="ml-3 rounded-control border border-border bg-bg p-2"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value as typeof duration)}
                  >
                    <option value="1d">{t("day1")}</option>
                    <option value="7d">{t("day7")}</option>
                    <option value="30d">{t("day30")}</option>
                  </select>
                </label>
              </fieldset>
            </div>
          </div>
        </fieldset>
        {(validation || error) && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {t(validation || error)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" loading={pending}>
            {t("save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
