export const STANDARD_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
export const EXTENDED_REASONING_EFFORTS = ["max", "ultra"] as const;

type ExtendedReasoningEffort = (typeof EXTENDED_REASONING_EFFORTS)[number];

export function supportsExtendedCodexEffort(
  model: string,
  effort: ExtendedReasoningEffort
): boolean {
  const normalized = model
    .trim()
    .toLowerCase()
    .replace(/^(?:codex|cx|openai)\//, "");
  return effort === "ultra"
    ? /^gpt-5\.6-(?:sol|terra)(?:-|$)/.test(normalized)
    : /^gpt-5\.6-(?:sol|terra|luna)(?:-|$)/.test(normalized);
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
