import { getModelEndpointDecision } from "@omniroute/open-sse/services/modelEndpointPolicy.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { getSyncedAvailableModels, type SyncedAvailableModel } from "@/lib/db/models";

type DecisionOnlyChatGuardDeps = {
  getSyncedAvailableModels: (providerId: string) => Promise<SyncedAvailableModel[]>;
};

/**
 * Providers whose discovery can record a System One (`decision`) model. Only these pay the
 * stored-model lookup on the chat path; every other provider is untouched.
 */
const SYSTEM_ONE_CAPABLE_PROVIDERS = new Set(["ollama-local"]);

/**
 * Refuse a chat call to a model that only serves `/v1/systemone`.
 *
 * Ollama's `/api/show` reports Clef / Clef Flash as `["vision", "decision"]` with no
 * `completion`; discovery stores that as `supportedEndpoints: ["systemone"]`. Sending
 * such a model a chat request only earns an upstream 400, so it is refused here, before
 * any credential is selected — nothing is marked on the connection. The message reads as
 * a model-scoped 400, so a combo advances to its next target instead of stopping.
 */
export async function decisionOnlyChatRejection(
  modelInfo: { provider?: string | null; model?: string | null },
  deps: DecisionOnlyChatGuardDeps = { getSyncedAvailableModels }
): Promise<Response | null> {
  const provider = modelInfo.provider ?? "";
  const model = modelInfo.model ?? "";
  if (!model || !SYSTEM_ONE_CAPABLE_PROVIDERS.has(provider)) return null;

  const row = (await deps.getSyncedAvailableModels(provider)).find((m) => m.id === model);
  if (!row) return null;
  if (getModelEndpointDecision(provider, model, row.supportedEndpoints).kind !== "decision") {
    return null;
  }
  return errorResponse(
    400,
    `Model ${provider}/${model} does not support chat: it is a System One decision model; ` +
      "use the System One API (POST v1/systemone)"
  );
}
