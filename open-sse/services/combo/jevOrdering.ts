/**
 * Jev ordering module (#15276).
 *
 * One interface: preference-ordered targets, the latest user text, whether a
 * live session pin already owns the conversation, and an `ask` port. The
 * result is the attempt order plus holds safe to record on the decision trace.
 * Probability floors, the admission cap, fail-open, and the choice-option
 * ceiling stay inside. Callers do not learn them.
 */

import type { ResolvedComboTarget } from "./types.ts";
import {
  buildJevCriteria,
  judgeJev,
  orderTargetsByJevVerdicts,
  type JevChoiceAnswer,
  type JevHoldReason,
  type JudgeJevResult,
} from "./jevStrategy.ts";
import { TYPESAFE_MAX_CHOICE_OPTIONS, TYPESAFE_MAX_STATE_CHARS } from "../typesafe/systemOne.ts";

export type JevAsk = (input: {
  state: string;
  criteria: Record<string, string | null>;
}) => Promise<JevChoiceAnswer | null>;

export type JevHoldRecord = {
  executionKey: string;
  modelStr: string;
  reason: JevHoldReason;
  detail?: string;
};

export type JevOrderOutcome = {
  targets: ResolvedComboTarget[];
  holds: JevHoldRecord[];
  /**
   * True when this request's head is a Jev verdict or a fail-open preference
   * head and later stages must not replace it. False when a session pin owns
   * the request — stickiness promotes that pin afterwards.
   */
  protectHead: boolean;
};

export async function orderJevComboTargets(
  targets: readonly ResolvedComboTarget[],
  state: string,
  ports: { sessionPinned: boolean; ask: JevAsk }
): Promise<JevOrderOutcome> {
  if (ports.sessionPinned || targets.length <= 1) {
    return { targets: [...targets], holds: [], protectHead: false };
  }

  const candidates = targets.map((target, index) => ({
    id: target.executionKey,
    userRank: index,
    label: target.label || target.modelStr,
  }));
  const uniqueIds = new Set(candidates.map((candidate) => candidate.id));
  const boundedState =
    state.length > TYPESAFE_MAX_STATE_CHARS ? state.slice(0, TYPESAFE_MAX_STATE_CHARS) : state;

  let answer: JevChoiceAnswer | null = null;
  if (uniqueIds.size === candidates.length && candidates.length <= TYPESAFE_MAX_CHOICE_OPTIONS) {
    try {
      answer = await ports.ask({
        state: boundedState,
        criteria: buildJevCriteria(candidates),
      });
    } catch {
      answer = null;
    }
  }

  return toOutcome(targets, judgeJev(candidates, answer));
}

function toOutcome(
  targets: readonly ResolvedComboTarget[],
  judged: JudgeJevResult
): JevOrderOutcome {
  const byId = new Map(targets.map((target) => [target.executionKey, target]));
  const holds: JevHoldRecord[] = [];
  for (const row of judged.held) {
    const target = byId.get(row.id);
    if (!target || !row.reason) continue;
    holds.push({
      executionKey: target.executionKey,
      modelStr: target.modelStr,
      reason: row.reason,
      detail:
        row.probability !== null && row.probability !== undefined
          ? `p=${row.probability}`
          : judged.fallbackReason || undefined,
    });
  }
  return {
    targets: orderTargetsByJevVerdicts(targets, judged.admitted),
    holds,
    protectHead: true,
  };
}
