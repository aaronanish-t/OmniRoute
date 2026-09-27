// Normalizers for the compression engine DETAIL settings sub-objects that persist to a
// single key_value row each (settings.sessionDedup / settings.ccr / settings.relevanceConfig). Extracted out of
// src/lib/db/compression.ts (frozen at cap by file-size-baseline.json — see
// scripts/check/check-file-size.mjs) rather than growing that file inline.
//
// #8388: session-dedup and ccr detail fields (minBlockChars/fuzzy, minChars/
// retrievalRampFactor) were editable on the EngineConfigPage detail form but had no
// persisted sub-object — mirrors the #8056 headroom/minRows fix (normalizeHeadroomConfig
// in compression.ts), extended to the two engines #8056 left uncovered.
import {
  DEFAULT_APPEND_PRESERVING_CCR_CONFIG,
  DEFAULT_GREV_CACHING_CONFIG,
  DEFAULT_CCR_CONFIG,
  DEFAULT_RELEVANCE_CONFIG,
  DEFAULT_SESSION_DEDUP_CONFIG,
  type AppendPreservingCcrConfig,
  type CcrConfig,
  type CompressionConfig,
  type GrevCachingConfig,
  type RelevanceConfig,
  type SessionDedupConfig,
} from "@omniroute/open-sse/services/compression/types.ts";

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Matches SESSION_DEDUP_SCHEMA bounds (engines/session-dedup/index.ts). */
export function normalizeSessionDedupConfig(value: unknown): SessionDedupConfig {
  const record = toRecord(value);
  return {
    ...DEFAULT_SESSION_DEDUP_CONFIG,
    minBlockChars: boundedInt(
      record.minBlockChars,
      DEFAULT_SESSION_DEDUP_CONFIG.minBlockChars,
      1,
      100000
    ),
    fuzzy: typeof record.fuzzy === "boolean" ? record.fuzzy : DEFAULT_SESSION_DEDUP_CONFIG.fuzzy,
  };
}

/** Matches CCR_SCHEMA bounds (engines/ccr/index.ts). */
export function normalizeCcrConfig(value: unknown): CcrConfig {
  const record = toRecord(value);
  return {
    ...DEFAULT_CCR_CONFIG,
    minChars: boundedInt(record.minChars, DEFAULT_CCR_CONFIG.minChars, 100, 1_000_000),
    retrievalRampFactor: boundedInt(
      record.retrievalRampFactor,
      DEFAULT_CCR_CONFIG.retrievalRampFactor,
      1,
      100
    ),
  };
}

/** Matches append-preserving CCR engine bounds. */
export function normalizeAppendPreservingCcrConfig(value: unknown): AppendPreservingCcrConfig {
  const record = toRecord(value);
  return {
    ...DEFAULT_APPEND_PRESERVING_CCR_CONFIG,
    triggerPercent: boundedInt(
      record.triggerPercent,
      DEFAULT_APPEND_PRESERVING_CCR_CONFIG.triggerPercent,
      1,
      100
    ),
    preserveRecentPercent: boundedInt(
      record.preserveRecentPercent,
      DEFAULT_APPEND_PRESERVING_CCR_CONFIG.preserveRecentPercent,
      1,
      90
    ),
    minArchiveChars: boundedInt(
      record.minArchiveChars,
      DEFAULT_APPEND_PRESERVING_CCR_CONFIG.minArchiveChars,
      1,
      1_000_000
    ),
    minRetainedMessages: boundedInt(
      record.minRetainedMessages,
      DEFAULT_APPEND_PRESERVING_CCR_CONFIG.minRetainedMessages,
      1,
      100
    ),
    maxArchiveSectionChars: boundedInt(
      record.maxArchiveSectionChars,
      DEFAULT_APPEND_PRESERVING_CCR_CONFIG.maxArchiveSectionChars,
      1_000,
      1_000_000
    ),
  };
}

/** Normalizes the dedicated GrevCaching context-owner configuration. */
export function normalizeGrevCachingConfig(value: unknown): GrevCachingConfig {
  const record = toRecord(value);
  const archive = normalizeAppendPreservingCcrConfig(record);
  const normalizeKeys = (candidate: unknown) =>
    Array.isArray(candidate)
      ? [
          ...new Set(
            candidate
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
          ),
        ]
      : [];
  return {
    ...DEFAULT_GREV_CACHING_CONFIG,
    ...archive,
    enabled:
      typeof record.enabled === "boolean" ? record.enabled : DEFAULT_GREV_CACHING_CONFIG.enabled,
    excludedModelKeys: normalizeKeys(record.excludedModelKeys),
    excludedComboIds: normalizeKeys(record.excludedComboIds),
    newBlockPipeline: normalizeKeys(record.newBlockPipeline),
  };
}

/** Matches RELEVANCE_SCHEMA bounds (engines/relevance/configSchema.ts). */
export function normalizeRelevanceConfig(value: unknown): RelevanceConfig {
  const record = toRecord(value);
  const boundedFraction = (candidate: unknown, fallback: number, min: number) => {
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) return fallback;
    return Math.min(1, Math.max(min, candidate));
  };
  return {
    enabled:
      typeof record.enabled === "boolean" ? record.enabled : DEFAULT_RELEVANCE_CONFIG.enabled,
    overlapThreshold: boundedFraction(
      record.overlapThreshold,
      DEFAULT_RELEVANCE_CONFIG.overlapThreshold,
      0
    ),
    budgetPercent: boundedFraction(
      record.budgetPercent,
      DEFAULT_RELEVANCE_CONFIG.budgetPercent,
      0.1
    ),
    boilerplateWeight: boundedFraction(
      record.boilerplateWeight,
      DEFAULT_RELEVANCE_CONFIG.boilerplateWeight,
      0
    ),
  };
}

/** Default sub-objects spread into getCompressionSettings' seed config. */
export function buildDetailConfigDefaults(): Pick<
  CompressionConfig,
  "sessionDedup" | "ccr" | "appendPreservingCcr" | "grevCaching" | "relevanceConfig"
> {
  return {
    sessionDedup: normalizeSessionDedupConfig(undefined),
    ccr: normalizeCcrConfig(undefined),
    appendPreservingCcr: normalizeAppendPreservingCcrConfig(undefined),
    grevCaching: normalizeGrevCachingConfig(undefined),
    relevanceConfig: normalizeRelevanceConfig(undefined),
  };
}

/** Applies a stored sessionDedup/ccr row onto config during getCompressionSettings' row scan. */
export function applyDetailConfigUpdate(
  config: CompressionConfig,
  key: "sessionDedup" | "ccr" | "appendPreservingCcr" | "grevCaching" | "relevanceConfig",
  parsed: unknown
): void {
  if (key === "sessionDedup") config.sessionDedup = normalizeSessionDedupConfig(parsed);
  else if (key === "ccr") config.ccr = normalizeCcrConfig(parsed);
  else if (key === "relevanceConfig") config.relevanceConfig = normalizeRelevanceConfig(parsed);
  else if (key === "grevCaching") config.grevCaching = normalizeGrevCachingConfig(parsed);
  else config.appendPreservingCcr = normalizeAppendPreservingCcrConfig(parsed);
}
