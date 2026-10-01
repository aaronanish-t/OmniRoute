/**
 * Production adapter for {@link partitionJevTargets}: the same pre-dispatch
 * gates the attempt loop would apply, without mutating attempt state.
 */

import { isModelLocked } from "../accountFallback.ts";
import { checkCredentialGate } from "../credentialGate.ts";
import { isProviderInCooldown } from "../providerCooldownTracker.ts";
import { parseModel } from "../model.ts";
import type { ResilienceSettings } from "../../../src/lib/resilience/settings";
import { findOpenCircuitBreaker, readConnectionForCooldownGate } from "./executeTargetGates.ts";
import { resolvePersistedConnectionCooldownSkipReason } from "./comboPredicates.ts";
import { resolveQuotaExhaustionCutoffForTarget } from "./quotaExhaustionCutoff.ts";
import { resolveResetWindowConfig } from "./quotaScoring.ts";
import { filterTargetsByRequestCompatibility } from "./comboStructure.ts";
import { applyContextRequirements } from "./contextRequirements.ts";
import type { ComboSkipReason } from "./decisionTrace.ts";
import {
  modelAvailabilitySkipReason,
  type ComboLogger,
  type IsModelAvailable,
  type ResolvedComboTarget,
} from "./types.ts";
import type { CheckJevBlock } from "./jevEligibility.ts";
import { partitionJevTargets, type JevPartition } from "./jevEligibility.ts";

export type JevBlockCheckerDeps = {
  body: Record<string, unknown>;
  config: Record<string, unknown> | null | undefined;
  resilienceSettings: ResilienceSettings;
  log: ComboLogger;
  isModelAvailable?: IsModelAvailable;
  comboName: string;
};

/**
 * Build the production `checkBlock` port. Per-target gates first; list-level
 * tools/vision and context filters are applied in {@link partitionJevTargetsForAsk}.
 */
export function createJevBlockChecker(deps: JevBlockCheckerDeps): CheckJevBlock {
  const resetWindowConfig = resolveResetWindowConfig(deps.config);

  return async (target) => {
    const provider = target.provider;
    const rawModel = parseModel(target.modelStr).model || target.modelStr;

    if (provider) {
      const open = findOpenCircuitBreaker(provider, target.connectionId);
      if (open) return "circuit_open";
    }

    if (
      deps.resilienceSettings.providerCooldown.enabled &&
      Boolean(provider && provider !== "unknown") &&
      (isProviderInCooldown(provider, target.connectionId ?? undefined, deps.resilienceSettings) ||
        isProviderInCooldown(provider, undefined, deps.resilienceSettings))
    ) {
      return "provider_cooldown";
    }

    if (target.connectionId) {
      const persisted = await resolvePersistedConnectionCooldownSkipReason(target, (id) =>
        readConnectionForCooldownGate(id, false)
      );
      if (persisted) return "persisted_cooldown";
    }

    if (provider && rawModel && isModelLocked(provider, target.connectionId || "", rawModel)) {
      return "model_lockout";
    }

    if (provider && target.connectionId) {
      const quotaCutoff = await resolveQuotaExhaustionCutoffForTarget(
        provider,
        target.connectionId,
        deps.resilienceSettings,
        resetWindowConfig,
        deps.comboName,
        deps.log,
        target.modelStr
      );
      if (quotaCutoff.blocked) return "quota_cutoff";
    }

    if (deps.isModelAvailable) {
      const available = await deps.isModelAvailable(target.modelStr, target);
      const skipReason = modelAvailabilitySkipReason(available);
      if (skipReason) return skipReason;
    }

    if (target.connectionId) {
      const gate = checkCredentialGate(target.connectionId, provider, target.modelStr);
      if (gate.allowed === false) return "credential_gate";
    }

    return null;
  };
}

/**
 * Partition for the Jev choice call: per-target gates, then hard request
 * compatibility and context requirements. Survivors are the only options.
 */
export async function partitionJevTargetsForAsk(
  targets: readonly ResolvedComboTarget[],
  deps: JevBlockCheckerDeps
): Promise<JevPartition> {
  const perTarget = await partitionJevTargets(targets, createJevBlockChecker(deps));
  if (perTarget.eligible.length === 0) return perTarget;

  const compatFailOpen =
    (deps.config as { compatFilterFailOpen?: unknown } | null | undefined)?.compatFilterFailOpen ===
    true;
  const afterCompat = filterTargetsByRequestCompatibility(
    perTarget.eligible,
    deps.body,
    deps.log,
    "Jev pre-ask",
    { failOpen: compatFailOpen }
  );
  const blocked: typeof perTarget.blocked = [...perTarget.blocked];
  const compatSurvivors = new Set(afterCompat.map((t) => t.executionKey));
  for (const target of perTarget.eligible) {
    if (!compatSurvivors.has(target.executionKey)) {
      blocked.push({ target, reason: "availability" });
    }
  }

  const contextRequirements = (
    deps.config as { contextRequirements?: Parameters<typeof applyContextRequirements>[1] } | null
  )?.contextRequirements;
  const afterContext = applyContextRequirements(afterCompat, contextRequirements, deps.log);
  const contextSurvivors = new Set(afterContext.map((t) => t.executionKey));
  for (const target of afterCompat) {
    if (!contextSurvivors.has(target.executionKey)) {
      blocked.push({ target, reason: "availability" as ComboSkipReason });
    }
  }

  return { eligible: afterContext, blocked };
}
