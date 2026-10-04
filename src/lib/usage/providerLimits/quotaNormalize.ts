import {
  isUserCallableAntigravityModelId,
  toClientAntigravityModelId,
} from "@omniroute/open-sse/config/antigravityModelAliases.ts";
import { isDiscoverableAgyModelId } from "@omniroute/open-sse/config/agyModels.ts";

type JsonRecord = Record<string, unknown>;

/**
 * Family-window summary keys produced by the `retrieveUserQuotaSummary` parser
 * (`antigravityWeeklyQuota.ts`): gemini_weekly / gemini_5h (Gemini Models group)
 * and claude_gpt_weekly / claude_gpt_5h (Claude and GPT models group). These are
 * aggregate windows, not model ids — they must pass through the model-id
 * allowlist unchanged or the provider-limits cache silently drops every window
 * row (regression observed on v3.8.52: the cards lost their weekly rows).
 */
const ANTIGRAVITY_WINDOW_SUMMARY_KEYS = new Set([
  "gemini_weekly",
  "gemini_5h",
  "claude_gpt_weekly",
  "claude_gpt_5h",
]);

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isUsageQuotaKeyAllowed(provider: string, quotaKey: string): boolean {
  if (quotaKey === "credits" || quotaKey === "models") return true;
  if (provider === "antigravity" || provider === "agy") {
    if (ANTIGRAVITY_WINDOW_SUMMARY_KEYS.has(quotaKey)) return true;
  }
  if (provider === "antigravity") return isUserCallableAntigravityModelId(quotaKey);
  if (provider === "agy") return isDiscoverableAgyModelId(quotaKey);
  return true;
}

export function normalizeUsageQuotaKey(provider: string, quotaKey: string): string | null {
  if (quotaKey === "credits" || quotaKey === "models") return quotaKey;
  if (provider === "antigravity" || provider === "agy") {
    if (ANTIGRAVITY_WINDOW_SUMMARY_KEYS.has(quotaKey)) return quotaKey;
    const clientKey = toClientAntigravityModelId(quotaKey);
    return isUsageQuotaKeyAllowed(provider, clientKey) ? clientKey : null;
  }
  return isUsageQuotaKeyAllowed(provider, quotaKey) ? quotaKey : null;
}

export function normalizeUsageQuotasForProvider(
  provider: string,
  quotas: JsonRecord | null | undefined
): JsonRecord | null {
  if (!isRecord(quotas)) return quotas ?? null;

  const normalized: JsonRecord = {};
  let changed = false;

  for (const [quotaKey, quota] of Object.entries(quotas)) {
    const normalizedKey = normalizeUsageQuotaKey(provider, quotaKey);
    if (!normalizedKey) {
      changed = true;
      continue;
    }

    const existing = normalized[normalizedKey];
    if (existing && isRecord(existing) && isRecord(quota)) {
      const existingSource = String(existing.quotaSource ?? "");
      const nextSource = String(quota.quotaSource ?? "");
      const sourceRank: Record<string, number> = {
        fetchAvailableModels: 0,
        localUsageHistory: 1,
        retrieveUserQuota: 2,
      };
      if ((sourceRank[existingSource] ?? 0) > (sourceRank[nextSource] ?? 0)) {
        continue;
      }
    }

    normalized[normalizedKey] = quota as JsonRecord;
    if (normalizedKey !== quotaKey) changed = true;
  }

  return changed ? normalized : quotas;
}

export function sanitizeUsageQuotasForProvider(provider: string, usage: JsonRecord): JsonRecord {
  if (provider !== "antigravity" && provider !== "agy") return usage;
  if (!isRecord(usage.quotas)) return usage;

  const sanitizedQuotas = normalizeUsageQuotasForProvider(provider, usage.quotas);
  return sanitizedQuotas === usage.quotas ? usage : { ...usage, quotas: sanitizedQuotas };
}
