import test from "node:test";
import assert from "node:assert/strict";

import {
  clearGrevCacheEstimateSnapshotsForTest,
  prepareGrevCacheHitEstimate,
} from "../../../open-sse/services/compression/grevCacheEstimate.ts";

const estimate = (message: unknown) =>
  typeof message === "object" && message !== null && "tokens" in message
    ? Number((message as { tokens: number }).tokens)
    : 0;

test("Grev cache estimate sums the exact shared message prefix over sequential turns", () => {
  clearGrevCacheEstimateSnapshotsForTest();
  const firstTurn = [
    { role: "system", content: "stable", tokens: 500 },
    { role: "user", content: "block one", tokens: 20_000 },
  ];
  const firstEstimate = prepareGrevCacheHitEstimate("session-a", firstTurn, estimate);
  assert.equal(firstEstimate.estimatedTokens, 0);
  firstEstimate.rememberSuccessfulRequest();

  const secondTurn = [
    ...firstTurn,
    { role: "assistant", content: "ack one", tokens: 10 },
    { role: "user", content: "block two", tokens: 20_000 },
  ];
  const secondEstimate = prepareGrevCacheHitEstimate("session-a", secondTurn, estimate);
  assert.equal(secondEstimate.estimatedTokens, 20_500);
  secondEstimate.rememberSuccessfulRequest();

  const thirdTurn = [
    ...secondTurn,
    { role: "assistant", content: "ack two", tokens: 10 },
    { role: "user", content: "block three", tokens: 20_000 },
  ];
  assert.equal(
    prepareGrevCacheHitEstimate("session-a", thirdTurn, estimate).estimatedTokens,
    40_510
  );
});

test("Grev cache estimate stops at the first changed message and isolates sessions", () => {
  clearGrevCacheEstimateSnapshotsForTest();
  const original = [
    { role: "system", content: "stable", tokens: 50 },
    { role: "user", content: "old block", tokens: 20_000 },
  ];
  prepareGrevCacheHitEstimate("session-a", original, estimate).rememberSuccessfulRequest();

  const changedPrefix = [
    original[0],
    { role: "user", content: "archived with CCR", tokens: 2_000 },
    { role: "user", content: "new turn", tokens: 20_000 },
  ];
  assert.equal(
    prepareGrevCacheHitEstimate("session-a", changedPrefix, estimate).estimatedTokens,
    50
  );
  assert.equal(
    prepareGrevCacheHitEstimate("session-b", changedPrefix, estimate).estimatedTokens,
    0
  );
});

test("five cumulative 20k batches estimate 200k prefix tokens reused", () => {
  clearGrevCacheEstimateSnapshotsForTest();
  let messages: Array<Record<string, unknown>> = [
    { role: "system", content: "stable system prefix", tokens: 0 },
  ];
  let totalEstimatedHits = 0;

  for (let batch = 1; batch <= 5; batch++) {
    messages = [...messages, { role: "user", content: `batch-${batch}`, tokens: 20_000 }];
    const estimateForTurn = prepareGrevCacheHitEstimate("20k-batches", messages, estimate);
    totalEstimatedHits += estimateForTurn.estimatedTokens;
    estimateForTurn.rememberSuccessfulRequest();
    if (batch < 5) {
      messages = [...messages, { role: "assistant", content: `ack-${batch}`, tokens: 0 }];
    }
  }

  assert.equal(totalEstimatedHits, 200_000);
});
