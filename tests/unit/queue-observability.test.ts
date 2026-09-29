import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const semaphore = await import("../../open-sse/services/rateLimitSemaphore.ts");
const routeSource = fs.readFileSync(path.resolve("src/app/api/admin/concurrency/route.ts"), "utf8");
const panelSource = fs.readFileSync(
  path.resolve("src/app/(dashboard)/dashboard/health/ConcurrencyQueuesCard.tsx"),
  "utf8"
);

test.afterEach(() => {
  semaphore.resetAll();
});

test("rate-limit semaphore stats can be scoped to combo target gates", async () => {
  const release = await semaphore.acquire("combo:alpha:target-a", { maxConcurrency: 1 });
  const queued = semaphore.acquire("combo:alpha:target-a", {
    maxConcurrency: 1,
    timeoutMs: 500,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await semaphore.acquire("provider:unrelated", { maxConcurrency: 1 });

  assert.deepEqual(semaphore.getStats("combo:"), {
    "combo:alpha:target-a": {
      running: 1,
      queued: 1,
      max: 1,
      rateLimitedUntil: null,
    },
  });
  assert.equal(Object.keys(semaphore.getStats("provider:")).length, 1);

  release();
  const queuedRelease = await queued;
  queuedRelease();
});

test("admin concurrency route exposes authenticated combo and account snapshots", () => {
  assert.match(routeSource, /requireManagementAuth\(request\)/);
  assert.match(routeSource, /comboQueues:\s*getComboSemaphoreStats\("combo:"\)/);
  assert.match(routeSource, /semaphores:\s*getSemaphoreStats\(\)/);
});

test("health panel labels combo-target and account semaphore scopes", () => {
  assert.match(panelSource, /aria-label=\{`\$\{t\("models"\)\} combo queues`\}/);
  assert.match(panelSource, /aria-label=\{`\$\{t\("accounts"\)\} account queues`\}/);
  assert.match(panelSource, /data\?\.timestamp/);
  assert.match(panelSource, /failedToLoad/);
});
