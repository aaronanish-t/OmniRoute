import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ollama-systemone-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { applyOllamaShowCapabilities } =
  await import("../../src/lib/providerModels/ollamaCapabilities.ts");
const systemOne = await import("../../open-sse/handlers/ollamaSystemOne.ts");
const {
  buildOllamaSystemOneUrl,
  classifyOllamaSystemOneFailure,
  handleOllamaSystemOne,
  validateOllamaSystemOneRequest,
} = systemOne;

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Captured from Ollama 0.35.0 (`/api/show` for nimble:latest and tev1:4b, 2026-09-30).
const SYSTEM_ONE_SHOW = { capabilities: ["decision", "tools", "thinking", "completion"] };

// Captured from Ollama 0.35.0 `POST /v1/systemone` with tev1:4b (2026-09-30).
const TEV_RESPONSE = {
  model: "tev1:4b",
  answers: {
    eligible: { type: "noul", noul: 0.012264916251606712 },
    route: {
      type: "choice",
      choice: "repairs",
      probabilities: {
        refunds: 0.0431434161733377,
        repairs: 0.946847119757787,
        sales: 0.010009464068875148,
      },
      confidence: 0.7875411973870763,
    },
    urgency: {
      type: "score",
      score: 1.4291681505763034,
      legend: { "0": "low", "1": "medium", "2": "high" },
      probabilities: {
        "0": 0.10908117502705174,
        "1": 0.35266949936959296,
        "2": 0.5382493256033553,
      },
      confidence: 0.14195633500571092,
    },
  },
  usage: { input_tokens: 817, output_tokens: 4 },
};

const VALID_BODY = {
  model: "tev1:4b",
  state: { ticket: "Laptop bought 45 days ago, screen flickers, wants a refund." },
  questions: {
    eligible: { type: "noul", instructions: "Is the customer eligible for a full refund?" },
    route: {
      type: "choice",
      instructions: "Which team should handle this ticket?",
      criteria: { refunds: "Refunds", repairs: "Repairs", sales: "Sales" },
    },
    urgency: {
      type: "score",
      instructions: "How urgent is this ticket?",
      criteria: ["low", "medium", "high"],
    },
  },
};

function validBody(overrides: Record<string, unknown> = {}) {
  const result = validateOllamaSystemOneRequest({ ...VALID_BODY, ...overrides });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.data;
}

type FetchCall = { url: string; init: RequestInit };

function jsonFetch(status: number, payload: unknown, calls: FetchCall[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function recorder() {
  const marks: unknown[][] = [];
  const logs: Record<string, unknown>[] = [];
  const clears: unknown[] = [];
  return {
    marks,
    logs,
    clears,
    deps: {
      markAccountUnavailable: async (...args: unknown[]) => {
        marks.push(args);
      },
      logCall: async (entry: Record<string, unknown>) => {
        logs.push(entry);
      },
      clearRecoveredState: async (credentials: unknown) => {
        clears.push(credentials);
      },
    },
  };
}

const CREDENTIALS = {
  connectionId: "conn-1",
  providerSpecificData: { baseUrl: "http://jetson.local:11434/v1" },
};

// ── Capability discovery ────────────────────────────────────────────────────

test("Ollama `decision` capability advertises the systemone endpoint alongside chat", () => {
  const model = applyOllamaShowCapabilities({ id: "nimble:latest" }, SYSTEM_ONE_SHOW);
  assert.deepEqual(model.supportedEndpoints, ["systemone", "chat"]);
  assert.equal(model.apiFormat, "chat-completions");
  assert.equal(model.supportsTools, true);
  assert.equal(model.supportsThinking, true);
});

test("a decision-only model keeps its existing apiFormat instead of becoming an image model", () => {
  const model = applyOllamaShowCapabilities(
    { id: "decider", apiFormat: "chat-completions" },
    { capabilities: ["decision"] }
  );
  assert.deepEqual(model.supportedEndpoints, ["systemone"]);
  assert.equal(model.apiFormat, "chat-completions");

  const bare = applyOllamaShowCapabilities({ id: "decider" }, { capabilities: ["decision"] });
  assert.equal("apiFormat" in bare, false);
});

test("ordinary chat models are unchanged by the decision mapping", () => {
  const model = applyOllamaShowCapabilities(
    { id: "gemma3:4b" },
    { capabilities: ["completion", "vision"] }
  );
  assert.deepEqual(model.supportedEndpoints, ["chat"]);
  assert.equal(model.supportsVision, true);
});

// ── Request validation (mirrors Ollama 0.35.0's own responses) ──────────────

test("accepts all three question types and object/array/empty-object state", () => {
  validBody();
  validBody({ state: ["a", "b"] });
  validBody({ state: {} });
  validBody({ keep_alive: "10m" });
  validBody({ keep_alive: 0 });
});

test("drops unknown top-level fields such as stream, as Ollama ignores them", () => {
  const data = validBody({ stream: true, foo: 1 });
  assert.equal("stream" in data, false);
  assert.equal("foo" in data, false);
});

test("rejects the same bodies Ollama rejects, with a 400", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["whitespace state", { state: "   " }, /state/],
    ["numeric state", { state: 5 }, /state/],
    ["no questions", { questions: {} }, /questions must contain 1–64 fields/],
    [
      "choice with one option",
      { questions: { a: { type: "choice", instructions: "x", criteria: { only: "one" } } } },
      /criteria must contain 2–26 candidates/,
    ],
    [
      "score with one level",
      { questions: { a: { type: "score", instructions: "x", criteria: ["low"] } } },
      /criteria must contain 2–26 candidates/,
    ],
    ["unknown question type", { questions: { a: { type: "rank", instructions: "x" } } }, /type/],
    ["missing instructions", { questions: { a: { type: "noul" } } }, /instructions/],
    ["missing model", { model: "" }, /model/],
  ];
  for (const [name, overrides, pattern] of cases) {
    const result = validateOllamaSystemOneRequest({ ...VALID_BODY, ...overrides });
    assert.equal(result.ok, false, name);
    if (result.ok) continue;
    assert.equal(result.status, 400, name);
    assert.match(result.message, pattern, name);
  }
});

test("rejects more than 64 questions", () => {
  const questions = Object.fromEntries(
    Array.from({ length: 65 }, (_, i) => [`q${i}`, { type: "noul", instructions: "?" }])
  );
  const result = validateOllamaSystemOneRequest({ ...VALID_BODY, questions });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 400);
});

test("rejects a body over 64 KiB with 413, like Ollama", () => {
  const result = validateOllamaSystemOneRequest({ ...VALID_BODY, state: "x".repeat(70_000) });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 413);
  assert.match(result.message, /64 KiB/);
});

// ── URL + failure classification ────────────────────────────────────────────

test("builds the native systemone URL from any OpenAI-compatible base URL", () => {
  assert.equal(buildOllamaSystemOneUrl("http://h:11434/v1"), "http://h:11434/v1/systemone");
  assert.equal(buildOllamaSystemOneUrl("http://h:11434/v1/"), "http://h:11434/v1/systemone");
  assert.equal(buildOllamaSystemOneUrl("http://h:11434"), "http://h:11434/v1/systemone");
  assert.equal(
    buildOllamaSystemOneUrl("http://h:11434/v1/chat/completions"),
    "http://h:11434/v1/systemone"
  );
  assert.equal(buildOllamaSystemOneUrl(null), "http://localhost:11434/v1/systemone");
});

test("classifies upstream failures into the right resilience layer", () => {
  assert.equal(
    classifyOllamaSystemOneFailure(404, 'model "nimble" not found, try pulling it first'),
    "model_not_found"
  );
  assert.equal(
    classifyOllamaSystemOneFailure(
      400,
      'model "gemma3:4b" is not supported by System One; use a local Nimble or Tev GGUF model'
    ),
    "unsupported_model"
  );
  assert.equal(
    classifyOllamaSystemOneFailure(400, "questions must contain 1–64 fields"),
    "invalid_request"
  );
  assert.equal(classifyOllamaSystemOneFailure(500, "boom"), "upstream_error");
});

// ── Handler ─────────────────────────────────────────────────────────────────

test("forwards only known fields to the connection's host and echoes the routed model id", async () => {
  const calls: FetchCall[] = [];
  const rec = recorder();
  const response = await handleOllamaSystemOne({
    body: validBody({ keep_alive: "5m", stream: true }),
    requestedModel: "ollama-local/tev1:4b",
    credentials: CREDENTIALS,
    fetchImpl: jsonFetch(200, TEV_RESPONSE, calls),
    ...rec.deps,
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://jetson.local:11434/v1/systemone");
  const sent = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(Object.keys(sent).sort(), ["keep_alive", "model", "questions", "state"]);
  assert.equal(sent.model, "tev1:4b");

  const body = await response.json();
  assert.equal(body.model, "ollama-local/tev1:4b");
  assert.deepEqual(body.answers, TEV_RESPONSE.answers);
  assert.deepEqual(body.usage, TEV_RESPONSE.usage);

  assert.equal(rec.marks.length, 0);
  assert.equal(rec.clears.length, 1);
  assert.equal(rec.logs.length, 1);
  assert.deepEqual(rec.logs[0].tokens, { prompt_tokens: 817, completion_tokens: 4 });
  assert.equal(rec.logs[0].path, "/v1/systemone");
  assert.equal(rec.logs[0].connectionId, "conn-1");
});

test("a missing model (404) locks that model on the connection", async () => {
  const rec = recorder();
  const response = await handleOllamaSystemOne({
    body: validBody({ model: "nimble" }),
    requestedModel: "ollama-local/nimble",
    credentials: CREDENTIALS,
    fetchImpl: jsonFetch(404, { error: 'model "nimble" not found, try pulling it first' }),
    ...rec.deps,
  });

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.error.message, /not found/);
  assert.equal(rec.marks.length, 1);
  const [connectionId, status, , provider, model] = rec.marks[0];
  assert.deepEqual(
    [connectionId, status, provider, model],
    ["conn-1", 404, "ollama-local", "nimble"]
  );
});

test("a non-System-One model (400) is returned as-is without touching the connection", async () => {
  const rec = recorder();
  const message =
    'model "gemma3:4b" is not supported by System One; use a local Nimble or Tev GGUF model';
  const response = await handleOllamaSystemOne({
    body: validBody({ model: "gemma3:4b" }),
    requestedModel: "ollama-local/gemma3:4b",
    credentials: CREDENTIALS,
    fetchImpl: jsonFetch(400, { error: message }),
    ...rec.deps,
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error.message, /not supported by System One/);
  assert.equal(rec.marks.length, 0);
});

test("an unreachable host returns 503 and cools the connection, without leaking internals", async () => {
  const rec = recorder();
  const response = await handleOllamaSystemOne({
    body: validBody(),
    requestedModel: "ollama-local/tev1:4b",
    credentials: CREDENTIALS,
    fetchImpl: (async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.5:11434");
    }) as typeof fetch,
    ...rec.deps,
  });

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.message.includes("at /"), false);
  assert.equal(body.error.message.includes("ECONNREFUSED"), false);
  assert.equal(rec.marks.length, 1);
  assert.equal(rec.marks[0][1], 503);
});

function hangingFetch(): typeof fetch {
  return ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;
}

test("a slow upstream times out with 504 and cools the connection", async () => {
  const rec = recorder();
  const response = await handleOllamaSystemOne({
    body: validBody(),
    requestedModel: "ollama-local/tev1:4b",
    credentials: CREDENTIALS,
    timeoutMs: 20,
    fetchImpl: hangingFetch(),
    ...rec.deps,
  });

  assert.equal(response.status, 504);
  assert.equal(rec.marks.length, 1);
  assert.equal(rec.marks[0][1], 504);
});

test("a client disconnect does not cool the connection", async () => {
  const rec = recorder();
  const controller = new AbortController();
  const pending = handleOllamaSystemOne({
    body: validBody(),
    requestedModel: "ollama-local/tev1:4b",
    credentials: CREDENTIALS,
    signal: controller.signal,
    fetchImpl: hangingFetch(),
    ...rec.deps,
  });
  controller.abort();
  const response = await pending;

  assert.equal(response.status, 499);
  assert.equal(rec.marks.length, 0);
});

test("a 200 without answers is treated as a 502 upstream error", async () => {
  const rec = recorder();
  const response = await handleOllamaSystemOne({
    body: validBody(),
    requestedModel: "ollama-local/tev1:4b",
    credentials: CREDENTIALS,
    fetchImpl: jsonFetch(200, "not json"),
    ...rec.deps,
  });

  assert.equal(response.status, 502);
  assert.equal(rec.marks.length, 1);
});

test("without a connection id nothing is marked, and the default host is used", async () => {
  const calls: FetchCall[] = [];
  const rec = recorder();
  const response = await handleOllamaSystemOne({
    body: validBody(),
    requestedModel: "ollama-local/tev1:4b",
    credentials: null,
    fetchImpl: jsonFetch(500, { error: "boom" }, calls),
    ...rec.deps,
  });

  assert.equal(response.status, 500);
  assert.equal(calls[0].url, "http://localhost:11434/v1/systemone");
  assert.equal(rec.marks.length, 0);
  assert.equal(rec.clears.length, 0);
});

// ── Real resilience wiring ──────────────────────────────────────────────────

test("a 404 through the real markAccountUnavailable locks only that model", async () => {
  const providersDb = await import("../../src/lib/db/providers.ts");
  const { isModelLocked } = await import("../../open-sse/services/accountFallback.ts");

  const connection = await providersDb.createProviderConnection({
    provider: "ollama-local",
    authType: "none",
    baseUrl: "http://127.0.0.1:11434/v1",
    isActive: true,
  });
  assert.ok(connection);
  const connectionId = String(connection.id);

  const response = await handleOllamaSystemOne({
    body: validBody({ model: "nimble" }),
    requestedModel: "ollama-local/nimble",
    credentials: { connectionId },
    fetchImpl: jsonFetch(404, { error: 'model "nimble" not found, try pulling it first' }),
    logCall: async () => {},
  });

  assert.equal(response.status, 404);
  assert.equal(isModelLocked("ollama-local", connectionId, "nimble"), true);
  assert.equal(isModelLocked("ollama-local", connectionId, "tev1:4b"), false);
  const stored = await providersDb.getProviderConnectionById(connectionId);
  assert.notEqual(stored?.testStatus, "unavailable");
});

// ── Clef / Clef Flash: vision System One models (Ollama >= 0.35.1) ──────────
// ollama.com/library/clef and /clef-flash tag both models `vision` + `decision`; the
// System One API takes base64 `images` shared by all questions (URLs and data URLs are
// not supported) and allows 32 MiB bodies when images are present (docs.ollama.com/api/systemone).

// 1×1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test("Clef: a vision + decision model advertises systemone and vision, not chat", () => {
  const model = applyOllamaShowCapabilities(
    { id: "clef-flash:9b" },
    {
      capabilities: ["vision", "decision"],
    }
  );
  assert.deepEqual(model.supportedEndpoints, ["systemone"]);
  assert.equal(model.supportsVision, true);
  assert.equal("apiFormat" in model, false);
});

test("Clef: base64 images are validated and forwarded to Ollama", async () => {
  const calls: FetchCall[] = [];
  const rec = recorder();
  const response = await handleOllamaSystemOne({
    body: validBody({ model: "clef-flash", images: [PNG_B64, PNG_B64] }),
    requestedModel: "ollama-local/clef-flash",
    credentials: CREDENTIALS,
    fetchImpl: jsonFetch(200, { ...TEV_RESPONSE, model: "clef-flash" }, calls),
    ...rec.deps,
  });
  assert.equal(response.status, 200);
  const sent = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(sent.images, [PNG_B64, PNG_B64]);
  assert.deepEqual(Object.keys(sent).sort(), ["images", "model", "questions", "state"]);
});

test("Clef: image URLs, data URLs and non-string images are rejected with 400", () => {
  for (const images of [
    ["https://example.com/cat.png"],
    ["http://example.com/cat.png"],
    [`data:image/png;base64,${PNG_B64}`],
    [""],
    [42],
    PNG_B64,
  ]) {
    const result = validateOllamaSystemOneRequest({ ...VALID_BODY, images });
    assert.equal(result.ok, false, `images=${JSON.stringify(images).slice(0, 40)} must fail`);
    if (result.ok) continue;
    assert.equal(result.status, 400);
  }
});

test("Clef: a body with images may exceed 64 KiB, up to Ollama's 32 MiB limit", () => {
  const largeImage = "A".repeat(2 * 1024 * 1024); // ~2 MiB of base64
  const accepted = validateOllamaSystemOneRequest({ ...VALID_BODY, images: [largeImage] });
  assert.equal(accepted.ok, true);

  const tooLarge = validateOllamaSystemOneRequest({
    ...VALID_BODY,
    images: ["A".repeat(33 * 1024 * 1024)],
  });
  assert.equal(tooLarge.ok, false);
  if (tooLarge.ok) return;
  assert.equal(tooLarge.status, 413);
  assert.match(tooLarge.message, /32 MiB/);

  // Without images the 64 KiB limit still applies.
  const textOnly = validateOllamaSystemOneRequest({ ...VALID_BODY, state: "x".repeat(70_000) });
  assert.equal(textOnly.ok, false);
});
