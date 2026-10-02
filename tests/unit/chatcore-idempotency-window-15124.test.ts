// #15124 — the configured `idempotencyWindowMs` setting must reach the idempotency save
// in handleChatCore on the SINGLE-MODEL (non-combo) path, where `cachedSettings` is null.
// Mock fetch, call the real handleChatCore without `cachedSettings`, and observe the
// replay window through the `X-OmniRoute-Idempotent` header (same convention as
// tests/unit/chatcore-reasoning-cache-write-guard.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupTempDataDir } from "../_setup/tempDataDir.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chatcore-idem-window-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { clearIdempotency } = await import("../../src/lib/idempotencyLayer.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const core = await import("../../src/lib/db/core.ts");

function noopLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function upstreamResponse() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-idem-window",
      object: "chat.completion",
      model: "gpt-5.1",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

// No `cachedSettings` is passed: this is exactly what handleSingleModelChat does.
async function callSingleModel(idempotencyKey: string, content: string) {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return upstreamResponse();
  };
  try {
    const body = { model: "gpt-5.1", messages: [{ role: "user", content }], stream: false };
    const result = (await handleChatCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-5.1", extendedContext: false },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body,
        headers: new Headers({ accept: "application/json", "idempotency-key": idempotencyKey }),
      },
      userAgent: "unit-test",
    } as never)) as { success: boolean; response: Response };
    await result.response.text();
    return {
      idempotent: result.response.headers.get("X-OmniRoute-Idempotent") === "true",
      upstreamCalls,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test.after(async () => {
  try {
    core.resetDbInstance();
  } catch {}
  clearIdempotency();
  await cleanupTempDataDir(TEST_DATA_DIR);
});

test("single-model path: a retry inside the default window replays (sanity)", async () => {
  clearIdempotency();
  const first = await callSingleModel("idem-default-15124", "default window");
  assert.equal(first.idempotent, false);
  assert.equal(first.upstreamCalls, 1);
  const retry = await callSingleModel("idem-default-15124", "default window");
  assert.equal(retry.idempotent, true);
  assert.equal(retry.upstreamCalls, 0);
});

test("single-model path: configured idempotencyWindowMs (shorter than 5000ms) is honored", async () => {
  clearIdempotency();
  await settingsDb.updateSettings({ idempotencyWindowMs: 150 });
  const first = await callSingleModel("idem-short-15124", "short window");
  assert.equal(first.idempotent, false);

  await new Promise((resolve) => setTimeout(resolve, 450));

  // With the setting ignored (5000ms default) this would still replay.
  const afterWindow = await callSingleModel("idem-short-15124", "short window");
  assert.equal(afterWindow.idempotent, false);
  assert.equal(afterWindow.upstreamCalls, 1);
});
