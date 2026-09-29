import { codexModelFamilySupportsExtendedEffort } from "./codexExtendedEffort";

export const STANDARD_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
export const EXTENDED_REASONING_EFFORTS = ["max", "ultra"] as const;

type ExtendedReasoningEffort = (typeof EXTENDED_REASONING_EFFORTS)[number];

/**
 * The rules editor accepts `codex/`, `cx/` and `openai/` prefixed ids (#14961); the alias-set
 * lookup shared with the Codex executor (#14720) knows the first two, so strip `openai/` here.
 */
export function supportsExtendedCodexEffort(
  model: string,
  effort: ExtendedReasoningEffort
): boolean {
  return codexModelFamilySupportsExtendedEffort(model.trim().replace(/^openai\//i, ""), effort);
}

export function getReasoningRoutingTargetEffortOptions(
  model: string,
  currentTargetEffort: string
): string[] {
  return [
    ...STANDARD_REASONING_EFFORTS,
    ...EXTENDED_REASONING_EFFORTS.filter(
      (effort) => supportsExtendedCodexEffort(model, effort) || currentTargetEffort === effort
    ),
  ];
}
