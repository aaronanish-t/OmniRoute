/**
 * #14360: when quota parking skips a provider (every connection is parked /
 * rate-limited), `handleNoCredentials` synthesizes a 429/503 without ever
 * reaching an upstream — so the normal failure path never writes a call_logs
 * row and the refusal only exists in the client's terminal.
 *
 * This leaf records that synthesized response through
 * `recordRejectedRequestUsage` with the same attribution the pipeline-gate path
 * in `chat.ts` passes (api key, endpoint, conversation, start time), so the
 * `usage_history` row (success:false) is counted against the right key.
 *
 * Combo targets are NOT recorded here: a combo calls handleSingleModel once per
 * target, and the combo-exhausted path in `chat.ts` already writes one row for
 * the whole request — recording each parked target too would duplicate it.
 */
import * as log from "../utils/logger";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { recordRejectedRequestUsage } from "./rejectedRequestUsage";

export interface QuotaParkedSkipInput {
  credentials: unknown;
  lastError: string | null;
  lastStatus: number | null;
  provider: string;
  model: string;
  isCombo: boolean;
  requestedModel?: string | null;
  endpoint?: string | null;
  apiKeyId?: string | null;
  apiKeyName?: string | null;
  correlationId?: string | null;
  sessionTag?: string | null;
  startTime?: number;
}

type ParkedCredentials = {
  allRateLimited?: unknown;
  lastError?: unknown;
  lastErrorCode?: unknown;
  cooldownScope?: unknown;
};

/**
 * The status `handleNoCredentials` returns through `unavailableResponse` for a
 * quota-parked provider, or null when it takes another branch (no parked
 * credentials, or the model-scoped cooldown response, which is its own path).
 */
export function quotaParkedSkipStatus(credentials: unknown, lastStatus: number | null) {
  const creds = credentials as ParkedCredentials | null;
  if (!creds || !creds.allRateLimited) return null;
  const status = Number(
    lastStatus || Number(creds.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE
  );
  if (creds.cooldownScope === "model" && status === HTTP_STATUS.RATE_LIMITED) return null;
  return status;
}

export async function recordQuotaParkedSkip(input: QuotaParkedSkipInput): Promise<void> {
  if (input.isCombo) return;
  const status = quotaParkedSkipStatus(input.credentials, input.lastStatus);
  if (status === null) return;
  const creds = input.credentials as ParkedCredentials;
  const errorMsg =
    input.lastError || (typeof creds.lastError === "string" && creds.lastError) || "Unavailable";
  try {
    await recordRejectedRequestUsage({
      status,
      model: input.model,
      requestedModel: input.requestedModel || input.model,
      provider: input.provider,
      endpoint: input.endpoint,
      error: `[${input.provider}/${input.model}] ${errorMsg}`,
      apiKeyId: input.apiKeyId ?? null,
      apiKeyName: input.apiKeyName ?? null,
      correlationId: input.correlationId ?? null,
      sessionTag: input.sessionTag ?? null,
      startTime: input.startTime,
    });
  } catch (err) {
    log.debug("CHAT", `[${input.provider}/${input.model}] quota-parked skip log failed`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
