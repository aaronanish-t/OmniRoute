/**
 * Combo health-check summary for strategy `jev` (#15276).
 *
 * Runs the same pre-ask block partition as live routing. Does not call TypeSafe:
 * without a user message a choice would be a fake decision. Eligible targets are
 * listed as not-yet-judged; blocked targets use their skip reason.
 */

import type { ResilienceSettings } from "../../../src/lib/resilience/settings";
import { partitionJevTargetsForAsk } from "./jevBlockChecker.ts";
import type { ComboLogger, ResolvedComboTarget } from "./types.ts";

export type JevComboTestSummary = {
  admittedSentence: string;
  heldSentence: string;
  blockedSentence: string;
  /** Present when no TypeSafe API key is configured. */
  configurationNote: string | null;
  eligible: Array<{ model: string; executionKey: string }>;
  blocked: Array<{ model: string; executionKey: string; reason: string }>;
};

const noopLog: ComboLogger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
};

export async function buildJevComboTestSummary(args: {
  targets: readonly ResolvedComboTarget[];
  comboName: string;
  config?: Record<string, unknown> | null;
  resilienceSettings: ResilienceSettings;
  hasTypesafeKey: boolean;
  log?: ComboLogger;
}): Promise<JevComboTestSummary> {
  const partition = await partitionJevTargetsForAsk(args.targets, {
    body: {},
    config: args.config ?? null,
    resilienceSettings: args.resilienceSettings,
    log: args.log ?? noopLog,
    comboName: args.comboName,
  });

  const eligible = partition.eligible.map((target) => ({
    model: target.modelStr,
    executionKey: target.executionKey,
  }));
  const blocked = partition.blocked.map((row) => ({
    model: row.target.modelStr,
    executionKey: row.target.executionKey,
    reason: row.reason,
  }));

  const admittedSentence =
    eligible.length === 0
      ? "Admitted: none — every target is blocked before Jev."
      : `Admitted: not yet judged (live Jev needs a user message). Eligible: ${eligible
          .map((row) => row.model)
          .join(" → ")}.`;

  const heldSentence =
    "Held: none until Jev runs on a live request (probability floor and dominated).";

  const blockedSentence =
    blocked.length === 0
      ? "Blocked: none."
      : `Blocked: ${blocked.map((row) => `${row.model} (${row.reason})`).join(", ")}.`;

  return {
    admittedSentence,
    heldSentence,
    blockedSentence,
    configurationNote: args.hasTypesafeKey ? null : "Jev is not configured",
    eligible,
    blocked,
  };
}
