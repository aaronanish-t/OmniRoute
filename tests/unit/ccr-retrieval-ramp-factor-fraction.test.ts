// CCR retrievalRampFactor must round-trip as a fraction. The settings schema accepts
// z.number().min(1).max(100) with no .int(), the engine's effectiveMinChars() ramps on
// fractions (rampFactor <= 1 short-circuits the ramp entirely), and the env override
// accepts fractions — but the read normalizer ran the value through boundedInt, so a
// saved 1.5 came back as 1 and live compression silently lost the ramp.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate DATA_DIR so this test never touches a real installed DB. Must be set BEFORE
// importing anything that resolves getDbInstance().
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ccr-ramp-"));
process.env.DATA_DIR = tmpDataDir;

const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { getCompressionSettings, updateCompressionSettings } =
  await import("../../src/lib/db/compression.ts");

test.after(() => {
  resetDbInstance();
  fs.rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("fractional retrievalRampFactor 1.5 survives save -> reload", async () => {
  await updateCompressionSettings({ ccr: { retrievalRampFactor: 1.5 } });
  const reloaded = await getCompressionSettings();
  assert.equal(reloaded.ccr.retrievalRampFactor, 1.5);
});

test("fractional retrievalRampFactor 2.5 is not floored to 2", async () => {
  await updateCompressionSettings({ ccr: { retrievalRampFactor: 2.5 } });
  const reloaded = await getCompressionSettings();
  assert.equal(reloaded.ccr.retrievalRampFactor, 2.5);
});

test("retrievalRampFactor stays clamped to [1, 100]", async () => {
  await updateCompressionSettings({ ccr: { retrievalRampFactor: 150 } });
  const over = await getCompressionSettings();
  assert.equal(over.ccr.retrievalRampFactor, 100);

  await updateCompressionSettings({ ccr: { retrievalRampFactor: 0.5 } });
  const under = await getCompressionSettings();
  assert.equal(under.ccr.retrievalRampFactor, 1);
});

test("non-numeric retrievalRampFactor falls back to the default (2)", async () => {
  await updateCompressionSettings({ ccr: { retrievalRampFactor: "fast" as unknown as number } });
  const reloaded = await getCompressionSettings();
  assert.equal(reloaded.ccr.retrievalRampFactor, 2);
});
