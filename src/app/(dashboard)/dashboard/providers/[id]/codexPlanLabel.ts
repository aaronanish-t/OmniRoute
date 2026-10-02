import { getCodexProPlanLabel } from "@/shared/utils/codexPlan";

/**
 * Codex subscription label from OAuth workspace metadata or imported auth data.
 * Unknown plans retain their raw spelling. Missing plans and non-Codex connections
 * return "" so callers can omit the badge.
 */
export function getCodexPlanLabel(isCodex: boolean, providerSpecificData: unknown): string {
  if (!isCodex) return "";
  const record =
    providerSpecificData && typeof providerSpecificData === "object"
      ? (providerSpecificData as Record<string, unknown>)
      : {};
  const candidates = [record.workspacePlanType, record.chatgptPlanType]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  const raw = candidates.find((value) => value.toLowerCase() !== "unknown") ?? candidates[0];
  return raw ? (getCodexProPlanLabel(raw) ?? raw) : "";
}
