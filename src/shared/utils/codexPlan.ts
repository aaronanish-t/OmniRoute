/** Display-only Codex Pro names; keep upstream plan values intact elsewhere. */
export function getCodexProPlanLabel(plan: unknown): string | null {
  if (typeof plan !== "string") return null;
  switch (plan.trim().toLowerCase()) {
    case "prolite":
      return "Pro Standard";
    case "pro":
      return "Pro Extra";
    case "promax":
      return "Pro Max";
    default:
      return null;
  }
}
