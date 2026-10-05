/**
 * Legacy per-engine settings rows (aggressiveConfig / ultraConfig / headroomConfig) share
 * their read case with the current keys (aggressive / ultra / headroom) in
 * getCompressionSettings. The settings query has no ORDER BY, so when both rows exist the
 * last one read wins — and with the (namespace, key) primary-key index the longer legacy
 * key always comes second: every save returns 200, but GET keeps serving the legacy
 * values. The current key must win when both rows exist.
 */
import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_HEADROOM_CONFIG,
  type AggressiveConfig,
  type HeadroomConfig,
  type UltraConfig,
} from "../../../open-sse/services/compression/types.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compression-legacy-keys-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { getCompressionSettings, updateCompressionSettings } =
  await import("../../../src/lib/db/compression.ts");

function seedRow(key: string, value: unknown): void {
  // Simulates a legacy row left by manual SQL, an outside tool, or a database from
  // another build — no app write path creates these keys.
  core
    .getDbInstance()
    .prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
    .run("compression", key, JSON.stringify(value));
}

beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  core.resetDbInstance();
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

describe("current engine settings rows win over legacy rows", () => {
  it("aggressive beats legacy aggressiveConfig after a save", async () => {
    seedRow("aggressiveConfig", { maxTokensPerMessage: 1111 } satisfies AggressiveConfig);
    seedRow("aggressive", { maxTokensPerMessage: 2222 } satisfies AggressiveConfig);

    await updateCompressionSettings({ aggressive: { maxTokensPerMessage: 4096 } });

    const settings = await getCompressionSettings();
    assert.equal(settings.aggressive?.maxTokensPerMessage, 4096);
  });

  it("ultra beats legacy ultraConfig after a save", async () => {
    seedRow("ultraConfig", { compressionRate: 0.1 } satisfies UltraConfig);
    seedRow("ultra", { compressionRate: 0.2 } satisfies UltraConfig);

    await updateCompressionSettings({ ultra: { compressionRate: 0.9 } });

    const settings = await getCompressionSettings();
    assert.equal(settings.ultra?.compressionRate, 0.9);
  });

  it("headroom beats legacy headroomConfig after a save", async () => {
    seedRow("headroomConfig", { minRows: 3 } satisfies HeadroomConfig);
    seedRow("headroom", { minRows: 4 } satisfies HeadroomConfig);

    await updateCompressionSettings({ headroom: { minRows: 50 } });

    const settings = await getCompressionSettings();
    assert.equal(settings.headroom?.minRows, 50);
  });

  it("legacy row still applies when no current row exists", async () => {
    seedRow("aggressiveConfig", { maxTokensPerMessage: 1111 } satisfies AggressiveConfig);

    const settings = await getCompressionSettings();
    assert.equal(settings.aggressive?.maxTokensPerMessage, 1111);
  });

  it("non-object legacy value resets the engine to defaults", async () => {
    seedRow("headroomConfig", 5);

    const settings = await getCompressionSettings();
    assert.equal(settings.headroom?.minRows, DEFAULT_HEADROOM_CONFIG.minRows);
  });
});
