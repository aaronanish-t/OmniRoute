/**
 * Decision-only models (Ollama System One: Clef, Clef Flash) must not be served as chat.
 *
 * Ollama's `/api/show` reports Clef as `["vision", "decision"]` — no `completion` — and
 * discovery stores that as `supportedEndpoints: ["systemone"]`. Before this guard the row
 * reached `/v1/models` with no `type` (so agents listed it as a chat model) and a chat call
 * went upstream and came back as a 400.
 *
 * Rules:
 *   R1 The endpoint policy classifies a systemone-only row as `decision`, not chat-selectable.
 *   R2 `/v1/models` classification tags a systemone-only row `type: "decision"`; a model that
 *      also advertises chat (Nimble, Tev) stays a chat model.
 *   R3 A chat call to a decision-only model is refused with a clear 400, before any upstream
 *      call, and the message is one a combo treats as model-scoped (advance, never stop).
 *   R4 Chat-capable, unknown, and non-System-One-provider models are untouched, and other
 *      providers never pay the stored-model lookup.
 *   R5 resolveModelOrError — the chokepoint for direct calls and every combo target —
 *      returns that 400 for a decision-only model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-decision-guard-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-secret-decision-guard";

const core = await import("../../src/lib/db/core.ts");
const models = await import("../../src/lib/db/models.ts");
const { getModelEndpointDecision, isChatSelectableModel } =
  await import("../../open-sse/services/modelEndpointPolicy.ts");
const { classifyModelSupportedEndpoints } =
  await import("../../src/shared/constants/modelSupportedEndpoints.ts");
const { comboTargetDecision } =
  await import("../../open-sse/services/combo/statusDecisionTable.ts");
const { decisionOnlyChatRejection } =
  await import("../../src/lib/providerModels/decisionOnlyChatGuard.ts");
const { resolveModelOrError } = await import("../../src/sse/handlers/chatHelpers.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

await models.replaceSyncedAvailableModelsForConnection("ollama-local", "conn-1", [
  { id: "clef-flash", name: "clef-flash", supportedEndpoints: ["systemone"] },
  { id: "nimble:latest", name: "nimble:latest", supportedEndpoints: ["systemone", "chat"] },
  { id: "gemma3:4b", name: "gemma3:4b", supportedEndpoints: ["chat"] },
]);

test("R1: the endpoint policy classifies a systemone-only row as a decision model", () => {
  const decision = getModelEndpointDecision("ollama-local", "clef-flash", ["systemone"]);
  assert.equal(decision.kind, "decision");
  assert.equal(decision.chatSelectable, false);
  assert.equal(
    isChatSelectableModel("ollama-local", { id: "clef", supportedEndpoints: ["systemone"] }),
    false
  );

  const both = getModelEndpointDecision("ollama-local", "nimble", ["systemone", "chat"]);
  assert.equal(both.kind, "chat");
  assert.equal(both.chatSelectable, true);
});

test("R2: /v1/models tags a systemone-only row as decision; chat + systemone stays chat", () => {
  assert.deepEqual(classifyModelSupportedEndpoints(["systemone"]), { type: "decision" });
  assert.deepEqual(classifyModelSupportedEndpoints(["systemone", "chat"]), {});
  assert.deepEqual(classifyModelSupportedEndpoints(["chat"]), {});
});

test("R3: a chat call to a decision-only model is a clear, combo-advancing 400", async () => {
  const response = await decisionOnlyChatRejection({
    provider: "ollama-local",
    model: "clef-flash",
  });
  assert.ok(response, "a decision-only model must be refused");
  assert.equal(response.status, 400);
  const body = await response.json();
  const message = String(body.error?.message ?? "");
  assert.match(message, /does not support chat/i);
  assert.match(message, /System One API \(POST v1\/systemone\)/);
  assert.equal(message.includes("at /"), false, "no stack trace in the body");
  assert.equal(
    comboTargetDecision(400, message),
    "advance",
    "a combo must move to the next target"
  );
});

test("R4: chat-capable, unknown and other-provider models are untouched", async () => {
  assert.equal(
    await decisionOnlyChatRejection({ provider: "ollama-local", model: "nimble:latest" }),
    null
  );
  assert.equal(
    await decisionOnlyChatRejection({ provider: "ollama-local", model: "gemma3:4b" }),
    null
  );
  assert.equal(
    await decisionOnlyChatRejection({ provider: "ollama-local", model: "not-synced" }),
    null
  );

  let lookups = 0;
  const spy = async () => {
    lookups += 1;
    return [];
  };
  assert.equal(
    await decisionOnlyChatRejection(
      { provider: "openai", model: "gpt-5.5" },
      { getSyncedAvailableModels: spy }
    ),
    null
  );
  assert.equal(lookups, 0, "providers that cannot serve System One never pay the lookup");
});

test("R5: resolveModelOrError refuses a decision-only model before any dispatch", async () => {
  const body = { model: "ollama-local/clef-flash", messages: [{ role: "user", content: "hi" }] };
  const resolved = (await resolveModelOrError(
    "ollama-local/clef-flash",
    body,
    "/v1/chat/completions"
  )) as {
    error?: Response;
  };
  assert.ok(resolved.error, "a decision-only model must not resolve for chat");
  assert.equal(resolved.error.status, 400);

  const chat = (await resolveModelOrError(
    "ollama-local/gemma3:4b",
    body,
    "/v1/chat/completions"
  )) as {
    error?: Response;
  };
  assert.equal(chat.error, undefined, "a chat model still resolves");
});
