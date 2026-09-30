import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-engine-config-save-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { getCompressionSettings, updateCompressionSettings } =
  await import("../../../src/lib/db/compression.ts");
const { compressionSettingsUpdateSchema } =
  await import("../../../src/shared/validation/compressionConfigSchemas.ts");
const { aggressiveEngine, ultraEngine } =
  await import("../../../open-sse/services/compression/engines/cavemanAdapter.ts");
const { seedEngineForm, buildEngineDetailUpdate } =
  await import("../../../src/shared/components/compression/engineConfigSave.ts");

type Settings = Record<string, unknown>;
type Engine = typeof aggressiveEngine;

beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
});

async function readSettings(): Promise<Settings> {
  return (await getCompressionSettings()) as unknown as Settings;
}

// Mirrors PUT /api/settings/compression: the route's schema validates the body, then the
// settings are written.
async function put(body: Settings): Promise<number> {
  const parsed = compressionSettingsUpdateSchema.safeParse(body);
  if (!parsed.success) return 400;
  await updateCompressionSettings(parsed.data as Parameters<typeof updateCompressionSettings>[0]);
  return 200;
}

// An engine page save: the form was seeded from `loadedSettings`, the operator applied
// `edits`, and the body is built from a read made at save time.
async function pageSave(
  engine: Engine,
  subKey: string,
  loadedSettings: Settings,
  edits: Settings
): Promise<number> {
  const loaded = seedEngineForm(engine.id, engine.getConfigSchema(), loadedSettings[subKey]);
  const current = await readSettings();
  return put({
    [subKey]: buildEngineDetailUpdate(loaded, { ...loaded, ...edits }, current[subKey]),
  });
}

describe("engine config page save", () => {
  it("keeps aggressive fields another page saved after the engine page loaded", async () => {
    const loadedSettings = await readSettings();
    const now = (await readSettings()).aggressive as Settings & {
      thresholds: Settings;
      toolStrategies: Settings;
    };
    const fromSettingsTab = {
      ...now,
      thresholds: { ...now.thresholds, fullSummary: 9 },
      toolStrategies: { ...now.toolStrategies, json: false },
      summarizerEnabled: false,
    };
    assert.equal(await put({ aggressive: fromSettingsTab }), 200);

    const status = await pageSave(aggressiveEngine, "aggressive", loadedSettings, {
      maxTokensPerMessage: 4096,
    });

    assert.equal(status, 200);
    assert.deepEqual((await readSettings()).aggressive, {
      ...fromSettingsTab,
      maxTokensPerMessage: 4096,
    });
  });

  it("saves the ultra page on a default install, where the form shows an empty model path", async () => {
    const loadedSettings = await readSettings();
    const before = loadedSettings.ultra as Settings;
    assert.equal(before.modelPath, undefined);

    const status = await pageSave(ultraEngine, "ultra", loadedSettings, { compressionRate: 0.4 });

    assert.equal(status, 200);
    assert.deepEqual((await readSettings()).ultra, { ...before, compressionRate: 0.4 });
  });

  it("keeps ultra.enabled and the model path when the ultra page saves another field", async () => {
    const now = (await readSettings()).ultra as Settings;
    assert.equal(await put({ ultra: { ...now, enabled: true, modelPath: "/models/ultra" } }), 200);
    const loadedSettings = await readSettings();

    const status = await pageSave(ultraEngine, "ultra", loadedSettings, { compressionRate: 0.4 });

    assert.equal(status, 200);
    assert.deepEqual((await readSettings()).ultra, {
      ...now,
      enabled: true,
      modelPath: "/models/ultra",
      compressionRate: 0.4,
    });
  });

  it("clears the stored model path when the field is emptied", async () => {
    const now = (await readSettings()).ultra as Settings;
    assert.equal(await put({ ultra: { ...now, modelPath: "/models/ultra" } }), 200);
    const loadedSettings = await readSettings();

    const status = await pageSave(ultraEngine, "ultra", loadedSettings, { modelPath: "  " });

    assert.equal(status, 200);
    assert.deepEqual((await readSettings()).ultra, now);
  });

  it("never writes enabled from the page form", async () => {
    const now = (await readSettings()).ultra as Settings;
    assert.equal(await put({ ultra: { ...now, enabled: true } }), 200);
    const loadedSettings = await readSettings();

    const status = await pageSave(ultraEngine, "ultra", loadedSettings, { enabled: false });

    assert.equal(status, 200);
    assert.equal(((await readSettings()).ultra as Settings).enabled, true);
  });

  it("sends back the stored sub-object when nothing was edited", async () => {
    const settings = await readSettings();
    const loaded = seedEngineForm(
      aggressiveEngine.id,
      aggressiveEngine.getConfigSchema(),
      settings.aggressive
    );

    assert.deepEqual(
      buildEngineDetailUpdate(loaded, loaded, settings.aggressive),
      settings.aggressive
    );
  });
});
