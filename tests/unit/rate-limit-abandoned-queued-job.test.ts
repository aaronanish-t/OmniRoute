import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rl-abandoned-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const resilienceSettings = await import("../../src/lib/resilience/settings.ts");
const rateLimitManager = await import("../../open-sse/services/rateLimitManager.ts");
const { cancelQueuedJob, ABANDONED_JOB_DROP_MESSAGE } =
  await import("../../open-sse/services/rateLimitManager/queuedJobCancel.ts");
const Bottleneck = (await import("bottleneck")).default;

const REFRESH_MS = 300;

function wait(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// Bottleneck hops through setTimeout(0) at every step, so poll instead of
// guessing a fixed delay (timer resolution varies across platforms).
async function waitFor(condition: () => boolean, message: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await wait(5);
  }
}

async function useOverrideLimiter(connectionId: string, overrides: Record<string, number>) {
  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    autoEnableApiKeyProviders: false,
    requestsPerMinute: 0,
    minTimeBetweenRequestsMs: 0,
    maxQueueDepth: 0,
  });
  // Same limiter the manager builds from the override, with the 60s rpm window
  // shortened so one refresh fits in a unit test.
  rateLimitManager.__setLimiterFactoryForTests(
    (options) =>
      new Bottleneck({
        ...options,
        ...(options.reservoirRefreshInterval ? { reservoirRefreshInterval: REFRESH_MS } : {}),
      })
  );
  rateLimitManager.enableRateLimitProtection(connectionId);
  rateLimitManager.refreshConnectionRateLimits(connectionId, overrides);
}

test.afterEach(async () => {
  await rateLimitManager.__resetRateLimitManagerForTests();
});

test.after(async () => {
  await rateLimitManager.__resetRateLimitManagerForTests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("queue-timed-out callers do not spend the next rpm window of a live request", async () => {
  const connectionId = "abandoned-rpm-conn";
  await useOverrideLimiter(connectionId, { rpm: 1, maxWaitMs: 100 });

  let abandonedRuns = 0;
  const burst = Array.from({ length: 5 }, (_, i) =>
    rateLimitManager
      .withRateLimit("openai", connectionId, null, async () => {
        if (i > 0) abandonedRuns++;
        return i;
      })
      .then(
        () => "ok",
        (error: Error & { code?: string }) => error.code
      )
  );
  assert.deepEqual(await Promise.all(burst), [
    "ok",
    "RATE_LIMIT_QUEUE_TIMEOUT",
    "RATE_LIMIT_QUEUE_TIMEOUT",
    "RATE_LIMIT_QUEUE_TIMEOUT",
    "RATE_LIMIT_QUEUE_TIMEOUT",
  ]);
  await waitFor(
    () => rateLimitManager.getRateLimitStatus("openai", connectionId).queued === 0,
    "timed-out callers must leave the Bottleneck queue"
  );

  // One refresh later the window has one token again. It belongs to the live
  // request, not to the first of four abandoned jobs queued ahead of it.
  await wait(REFRESH_MS + 50);
  assert.equal(
    await rateLimitManager.withRateLimit("openai", connectionId, null, async () => "live"),
    "live"
  );
  assert.equal(abandonedRuns, 0, "abandoned work must never run");
});

test("an aborted queued caller leaves the queue immediately", async () => {
  const connectionId = "abandoned-abort-conn";
  await useOverrideLimiter(connectionId, { rpm: 1 });

  assert.equal(
    await rateLimitManager.withRateLimit("openai", connectionId, null, async () => "first"),
    "first"
  );
  const controller = new AbortController();
  let ran = false;
  const pending = rateLimitManager.withRateLimit(
    "openai",
    connectionId,
    null,
    async () => {
      ran = true;
    },
    controller.signal
  );
  await waitFor(
    () => rateLimitManager.getRateLimitStatus("openai", connectionId).queued === 1,
    "the second caller never queued behind the spent reservoir"
  );
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await waitFor(
    () => rateLimitManager.getRateLimitStatus("openai", connectionId).queued === 0,
    "the aborted caller must leave the Bottleneck queue"
  );

  await wait(REFRESH_MS + 50);
  assert.equal(
    await rateLimitManager.withRateLimit("openai", connectionId, null, async () => "live"),
    "live"
  );
  assert.equal(ran, false);
});

test("cancelQueuedJob removes only the named QUEUED job and keeps FIFO order", async () => {
  const limiter = new Bottleneck({ maxConcurrent: 1 });
  const order: string[] = [];
  const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
  const running = limiter.schedule({ id: "running" }, async () => {
    await gate;
    order.push("running");
  });
  const jobs = ["a", "b", "c"].map((id) =>
    limiter
      .schedule({ id }, async () => {
        order.push(id);
        return "ran";
      })
      .catch((error: Error) => error.message)
  );
  await waitFor(() => limiter.counts().QUEUED === 3, "jobs a, b and c never queued");

  assert.equal(await cancelQueuedJob(limiter, "running"), false, "an executing job stays");
  assert.equal(await cancelQueuedJob(limiter, "missing"), false);
  assert.equal(await cancelQueuedJob(limiter, "b"), true);
  assert.equal(await cancelQueuedJob(limiter, "b"), false, "already removed");
  assert.equal(limiter.counts().QUEUED, 2);
  assert.equal(limiter.queued(), 2);

  openGate();
  await running;
  assert.deepEqual(await Promise.all(jobs), ["ran", ABANDONED_JOB_DROP_MESSAGE, "ran"]);
  assert.deepEqual(order, ["running", "a", "c"]);
  await limiter.disconnect();
});
