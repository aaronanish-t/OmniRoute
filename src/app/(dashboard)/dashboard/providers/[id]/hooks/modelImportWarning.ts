/**
 * modelImportWarning — pure helper (no React/store deps) so it is unit-testable in isolation.
 *
 * The model-import route (`/api/providers/[id]/models`) returns a `warning` field when it falls
 * back to the cached/local catalog (e.g. the provider's `/models` endpoint was unreachable —
 * "API unavailable — using local catalog"). The import hook previously read only `models`/`error`,
 * so the fallback was silent: the user saw imported models with no indication they came from the
 * local catalog instead of the live API (#5428, #5429, #5431). Returns the warning string to
 * surface as a log line, or null when the response carries no usable warning.
 */
export function extractImportWarning(data: unknown): string | null {
  if (data && typeof data === "object" && "warning" in data) {
    const warning = (data as { warning?: unknown }).warning;
    if (typeof warning === "string" && warning.trim()) return warning;
  }
  return null;
}

/**
 * #15069 — pure phase resolver for the zero-new-models branch in handleImportModels.
 *
 * When all fetched models are already registered, what the user sees depends on whether
 * the fetch came from the live upstream API or fell back to the local catalog:
 *
 *  - `importWarning` present → local-catalog fallback → phase "warning" (the remote API was
 *    unreachable; a success indicator would be misleading).
 *  - `importWarning` absent  → remote catalog actually fetched → phase "done" (genuine success).
 *
 * Extracted as a pure function so unit tests can cover this branch without a React renderer.
 */
export function resolveNoNewModelsPhase(importWarning: string | null): "warning" | "done" {
  return importWarning ? "warning" : "done";
}
