/**
 * TypeSafe AI (System One / Jev) API-key validation.
 *
 * Probes POST /v1/systemone with a tiny choice question. A 2xx with a parseable
 * choice means the key works; 401/403 means invalid; everything else is treated
 * as unavailable (credentials may still be fine).
 */

import { evaluateSystemOneChoice } from "@omniroute/open-sse/services/typesafe/systemOne.ts";

export async function validateTypesafeProvider({ apiKey }: { apiKey?: string | null }) {
  const result = await evaluateSystemOneChoice({
    apiKey,
    state: "ping",
    instructions: "Pick any option.",
    criteria: {
      ok: "A valid routing destination",
      other: "Any other destination",
    },
    timeoutMs: 10_000,
  });

  if (result.ok) {
    return { valid: true, error: null, method: "typesafe_systemone" };
  }

  if (result.reason === "missing_api_key") {
    return { valid: false, error: "API key is required" };
  }

  if (result.reason === "http_error" && (result.status === 401 || result.status === 403)) {
    return { valid: false, error: "Invalid API key" };
  }

  if (result.reason === "http_error" && result.status === 429) {
    return {
      valid: true,
      error: null,
      method: "typesafe_systemone",
      warning: "Rate limited, but credentials appear valid",
    };
  }

  if (result.reason === "timeout" || result.reason === "network_error") {
    return {
      valid: false,
      error: `TypeSafe unreachable (${result.reason})`,
    };
  }

  return {
    valid: false,
    error: result.detail || `TypeSafe validation failed (${result.reason})`,
  };
}
