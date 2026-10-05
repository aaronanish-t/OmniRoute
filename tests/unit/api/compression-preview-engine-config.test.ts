/**
 * TDD: the Aggressive/Ultra engine pages send their form values as preview config
 * ({ config: { ultra: { ... } } } — see EngineConfigPage.tsx handlePreview), but
 * dispatchCompression built the engineId/pipeline-branch config from
 * stackedPipeline/headroom/fidelityGate/riskGate only, so the sent engine keys were
 * dropped and the engines always ran on built-in defaults.
 *
 * Regression guard: a preview config must change the engine output.
 * compressionRate 1 is the sharpest knob — pruneByScore returns the text untouched
 * at keepRate >= 1, so ultra with it must produce zero savings.
 *
 * Auth/DB isolation pattern mirrors tests/unit/api/compression-preview-engine.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

// ─── temp DB isolation ────────────────────────────────────────────────────────

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-compression-preview-engine-config-")
);
const originalDataDir = process.env.DATA_DIR;
const originalJwtSecret = process.env.JWT_SECRET;

process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const previewRoute = await import("../../../src/app/api/compression/preview/route.ts");

// Stopword-heavy prose: scores below minScoreThreshold's 0.3 default (stopwords 0.1,
// ≤2-char words 0.2) are prune candidates, so the default run prunes roughly half.
// No digits/URLs/periods-attached-to-words beyond sentence ends (FORCE_PRESERVE_RE).
const PROSE = [
  "This is a summary of the state of the art in the field and it is one of the most common ways to think about the problem that we have seen so far",
  "the idea behind the approach is that the things we can do with a small amount of effort are often the ones that matter at the end",
  "in the world of the art the way to think about it is to see the one thing that we can do and then do it in the way that the work asks of us",
  "so the plan is to take the best of what we have and use it in a way that the rest of the field can see and use in their own work",
  "at the end the art of the work is in the way we think about the things we do and the way we see the world we work in",
].join(", ");

// ─── lifecycle ────────────────────────────────────────────────────────────────

test.before(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await settingsDb.updateSettings({
    requireLogin: true,
    setupComplete: true,
    password: "test-password-hash",
  });
});

test.after(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

interface PreviewResult {
  compressed: string;
  compressedTokens: number;
  savingsPct: number;
}

async function preview(body: Record<string, unknown>): Promise<PreviewResult> {
  const request = await makeManagementSessionRequest("http://localhost/api/compression/preview", {
    method: "POST",
    body,
  });
  const response = await previewRoute.POST(request);
  const result = (await response.json()) as PreviewResult;
  assert.equal(
    response.status,
    200,
    `Expected 200, got ${response.status}: ${JSON.stringify(result)}`
  );
  return result;
}

// ─── tests ────────────────────────────────────────────────────────────────────

test("engineId=ultra honors the sent config (compressionRate 1 must stop pruning)", async () => {
  const requestBody = { engineId: "ultra", messages: [{ role: "user", content: PROSE }] };

  const defaultRun = await preview(requestBody);
  const configuredRun = await preview({
    ...requestBody,
    config: { ultra: { compressionRate: 1 } },
  });

  assert.ok(
    defaultRun.savingsPct > 0,
    `default ultra run should prune (savingsPct > 0), got ${defaultRun.savingsPct}`
  );
  assert.equal(
    configuredRun.savingsPct,
    0,
    `ultra with compressionRate 1 must keep everything (savingsPct 0), got ${configuredRun.savingsPct} — the sent config was ignored`
  );
  assert.notEqual(
    configuredRun.compressed,
    defaultRun.compressed,
    "configured preview output must differ from the default run"
  );
});

test("pipeline=[ultra] honors the sent config (compressionRate 1 must stop pruning)", async () => {
  const requestBody = { pipeline: ["ultra"], messages: [{ role: "user", content: PROSE }] };

  const defaultRun = await preview(requestBody);
  const configuredRun = await preview({
    ...requestBody,
    config: { ultra: { compressionRate: 1 } },
  });

  assert.ok(
    defaultRun.savingsPct > 0,
    `default pipeline run should prune (savingsPct > 0), got ${defaultRun.savingsPct}`
  );
  assert.equal(
    configuredRun.savingsPct,
    0,
    `pipeline ultra with compressionRate 1 must keep everything (savingsPct 0), got ${configuredRun.savingsPct} — the sent config was ignored`
  );
});
