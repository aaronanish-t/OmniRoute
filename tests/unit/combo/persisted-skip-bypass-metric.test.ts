/**
 * Persisted-cooldown bypass metric: targets re-served via an allow-listed
 * rate-limited connection (transient 429 flag set, no future persisted
 * cooldown) increment a process-wide counter exposed on the combo metrics
 * view. A future persisted cooldown still skips without counting.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  getPersistedSkipBypassed,
  recordComboRequest,
  recordPersistedSkipBypass,
  resetAllComboMetrics,
  resetComboMetrics,
  getComboMetrics,
} from "../../../open-sse/services/comboMetrics.ts";
import { resetComboTraceStore } from "../../../open-sse/services/combo/decisionTrace.ts";
import type {
  AttemptLoopDeps,
  AttemptLoopState,
} from "../../../open-sse/services/combo/attemptLoopTypes.ts";
import type { ResolvedComboTarget } from "../../../open-sse/services/combo/types.ts";

function emptyState(overrides: Partial<AttemptLoopState> = {}): AttemptLoopState {
  return {
    orderedTargets: [],
    fallbackCount: 0,
    recordedAttempts: 0,
    comboErrors: [],
    lastError: null,
    lastStatus: null,
    earliestRetryAfter: null,
    comboExpired: false,
    exhaustedProviders: new Set(),
    exhaustedConnections: new Set(),
    transientRateLimitedProviders: new Set(),
    abortControllers: new Map([[0, new AbortController()]]),
    dispatchedTargets: new Set(),
    targetFailureTrust: new Map(),
    comboAttemptOrder: [],
    skippedForCircuitOpen: false,
    earliestCircuitOpenRetryMs: 0,
    globalAttempts: 0,
    observedFailure: false,
    allObservedFailuresQuota: true,
    observeFailure() {},
    ...overrides,
  };
}

function baseDeps(overrides: Partial<AttemptLoopDeps> = {}): AttemptLoopDeps {
  const handleSingleModelWithTimeout = async () => {
    throw new Error("handleSingleModel must not be called from gates");
  };
  return {
    strategy: "priority",
    combo: { name: "t", models: [] },
    config: {},
    log: { info() {}, warn() {}, debug() {}, error() {} },
    settings: null,
    resilienceSettings: {
      providerCooldown: { enabled: false },
    } as AttemptLoopDeps["resilienceSettings"],
    sticky: { targets: [], messageHash: null, stuck: false },
    effectiveSessionId: null,
    preScreenMap: new Map(),
    quotaCutoffResetWindowConfig: {} as AttemptLoopDeps["quotaCutoffResetWindowConfig"],
    maxRetries: 0,
    traceInvocationId: `inv-bypass-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    clientRequestedStream: false,
    handleSingleModelWithTimeout,
    body: { messages: [{ role: "user", content: "hi" }] },
    startTime: Date.now(),
    releaseStickyPinOnFailure() {},
    clearStaleLKGP() {},
    ...overrides,
  };
}

function modelTarget(overrides: Partial<ResolvedComboTarget> = {}): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: "s1",
    executionKey: "ek-1",
    modelStr: "openai/gpt-4o",
    provider: "openai",
    providerId: null,
    connectionId: "c1",
    weight: 1,
    label: null,
    ...overrides,
  };
}

async function seedCooldownConnection(input: {
  provider: string;
  testStatus: string;
  lastErrorAt?: string | null;
  rateLimitedUntil?: string | null;
}): Promise<string> {
  const providersDb = await import("../../../src/lib/db/providers.ts");
  const readCache = await import("../../../src/lib/db/readCache.ts");
  const connection = (await providersDb.createProviderConnection({
    provider: input.provider,
    authType: "apikey",
    name: `gates-bypass-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    apiKey: "[REDACTED]",
    testStatus: input.testStatus,
    lastErrorAt: input.lastErrorAt ?? null,
    rateLimitedUntil: input.rateLimitedUntil ?? null,
  } as unknown as Record<string, unknown>)) as { id: string };
  readCache.invalidateDbCache("connections");
  return connection.id;
}

describe("persisted-skip bypass metric", () => {
  beforeEach(() => {
    resetAllComboMetrics();
    resetComboTraceStore();
  });
  afterEach(() => {
    resetAllComboMetrics();
    resetComboTraceStore();
  });

  it("counts one bypass per record call and resets to zero", () => {
    const before = getPersistedSkipBypassed();
    recordPersistedSkipBypass();
    assert.equal(getPersistedSkipBypassed() - before, 1);
    recordComboRequest("probe-combo", null, { success: true, latencyMs: 1 });
    const view = getComboMetrics("probe-combo");
    assert.ok(view);
    assert.equal(view!.persistedSkipBypassed - before, 1);
    resetComboMetrics("probe-combo");
    assert.equal(getPersistedSkipBypassed() - before, 1);
    resetAllComboMetrics();
    assert.equal(getPersistedSkipBypassed(), 0);
  });

  it("gate with allow flag and no future cooldown proceeds and counts one bypass", async () => {
    const { evaluateExecuteTargetGates } =
      await import("../../../open-sse/services/combo/executeTargetGates.ts");
    const { startComboTrace } = await import("../../../open-sse/services/combo/decisionTrace.ts");
    const provider = `openai-gates-bypass-${Date.now()}`;
    const connectionId = await seedCooldownConnection({
      provider,
      testStatus: "active",
      rateLimitedUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    const target = modelTarget({ provider, modelStr: `${provider}/gpt-4o-mini`, connectionId });
    const state = emptyState({
      orderedTargets: [target],
      transientRateLimitedProviders: new Set([provider]),
    });
    const deps = baseDeps();
    startComboTrace(deps.traceInvocationId, { strategy: "priority", comboName: "t" });
    const before = getPersistedSkipBypassed();
    try {
      const decision = await evaluateExecuteTargetGates({ index: 0, state, deps });
      assert.equal(decision.kind, "proceed");
      assert.equal(getPersistedSkipBypassed() - before, 1);
    } finally {
      resetAllComboMetrics();
      resetComboTraceStore();
    }
  });

  it("gate with allow flag and future cooldown skips without counting", async () => {
    const { evaluateExecuteTargetGates } =
      await import("../../../open-sse/services/combo/executeTargetGates.ts");
    const { startComboTrace } = await import("../../../open-sse/services/combo/decisionTrace.ts");
    const provider = `openai-gates-nosbypass-${Date.now()}`;
    const connectionId = await seedCooldownConnection({
      provider,
      testStatus: "active",
      rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    const target = modelTarget({ provider, modelStr: `${provider}/gpt-4o-mini`, connectionId });
    const state = emptyState({
      orderedTargets: [target],
      transientRateLimitedProviders: new Set([provider]),
    });
    const deps = baseDeps();
    startComboTrace(deps.traceInvocationId, { strategy: "priority", comboName: "t" });
    const before = getPersistedSkipBypassed();
    try {
      const decision = await evaluateExecuteTargetGates({ index: 0, state, deps });
      assert.equal(decision.kind, "skip");
      assert.equal(getPersistedSkipBypassed() - before, 0);
    } finally {
      resetAllComboMetrics();
      resetComboTraceStore();
    }
  });

  it("gate without allow flag proceeds without counting", async () => {
    const { evaluateExecuteTargetGates } =
      await import("../../../open-sse/services/combo/executeTargetGates.ts");
    const { startComboTrace } = await import("../../../open-sse/services/combo/decisionTrace.ts");
    const provider = `openai-gates-noflag-${Date.now()}`;
    const connectionId = await seedCooldownConnection({
      provider,
      testStatus: "active",
      rateLimitedUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    const target = modelTarget({ provider, modelStr: `${provider}/gpt-4o-mini`, connectionId });
    const state = emptyState({ orderedTargets: [target] });
    const deps = baseDeps();
    startComboTrace(deps.traceInvocationId, { strategy: "priority", comboName: "t" });
    const before = getPersistedSkipBypassed();
    try {
      const decision = await evaluateExecuteTargetGates({ index: 0, state, deps });
      assert.equal(decision.kind, "proceed");
      assert.equal(getPersistedSkipBypassed() - before, 0);
    } finally {
      resetAllComboMetrics();
      resetComboTraceStore();
    }
  });

  it("round-robin counts the bypass when re-serving via the allow flag", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const rr = readFileSync(join(root, "open-sse/services/combo/roundRobinCombo.ts"), "utf8");
    assert.match(rr, /from "\.\.\/comboMetrics\.ts"/);
    assert.match(rr, /recordPersistedSkipBypass/);
    assert.match(
      rr,
      /if \(allowRateLimitedConnection && target\.connectionId\)[\s\S]*?if \(persistedSkip\)[\s\S]*?continue;[\s\S]*?\}[\s\S]*?recordPersistedSkipBypass\(\)/
    );
  });
});
