import { test } from "node:test";
import assert from "node:assert/strict";
import { selectBetaFlags } from "../../open-sse/executors/claudeIdentity.ts";
import { BaseExecutor } from "../../open-sse/executors/base.ts";
import {
  setThinkingBudgetConfig,
  DEFAULT_THINKING_CONFIG,
} from "../../open-sse/services/thinkingBudget.ts";

class ClaudeLikeExecutor extends BaseExecutor {
  constructor() {
    super("claude", { baseUrls: ["https://api.anthropic.com/v1/messages"] });
  }
  needsRefresh() {
    return false;
  }
  async transformRequest(_model: string, body: Record<string, unknown>) {
    return { ...body };
  }
}

async function captureUpstreamBody(
  body: Record<string, unknown>,
  model = "claude-opus-4-8"
): Promise<Record<string, unknown>> {
  const executor = new ClaudeLikeExecutor();
  const originalFetch = globalThis.fetch;
  let upstreamBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_url: string | URL | Request, init: RequestInit = {}) => {
    upstreamBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await executor.execute({
      model,
      body,
      stream: false,
      credentials: { accessToken: "sk-ant-oat-test-5312" },
      // #5480: the default adaptive-thinking injection (and the native-Claude-Code wire
      // image these #5312 cases exercise) is gated behind a real Claude Code client
      // (`x-app: cli` / `claude-code` UA). A bare OAuth token from a generic OpenAI-compat
      // client must opt in via x-omniroute-thinking, so identify as a Claude Code client here.
      clientHeaders: { "x-app": "cli" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(upstreamBody, "fetch must have been called");
  return upstreamBody!;
}

test.afterEach(() => {
  setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG);
});

for (const model of [
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-20250514",
]) {
  test(`legacy native ${model} does not receive unsupported adaptive defaults`, async () => {
    const upstream = await captureUpstreamBody(
      { model, messages: [{ role: "user", content: "hi" }] },
      model
    );
    assert.equal(upstream.thinking, undefined);
    assert.equal(upstream.output_config, undefined);
  });
  test(`legacy native ${model} preserves explicit manual thinking in custom mode`, async () => {
    setThinkingBudgetConfig({ mode: "custom", customBudget: 8192 });
    const thinking = { type: "enabled", budget_tokens: 8192 };
    const upstream = await captureUpstreamBody(
      { model, max_tokens: 16384, messages: [{ role: "user", content: "hi" }], thinking },
      model
    );
    assert.deepEqual(upstream.thinking, thinking);
    assert.equal(upstream.output_config, undefined);
  });
}
for (const model of [
  "claude-sonnet-4-6",
  "claude-opus-4-8",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
]) {
  test(`current native ${model} retains adaptive defaults`, async () => {
    const upstream = await captureUpstreamBody(
      { model, messages: [{ role: "user", content: "hi" }] },
      model
    );
    assert.deepEqual(upstream.thinking, { type: "adaptive" });
    assert.deepEqual(upstream.output_config, { effort: "high" });
  });
}
for (const model of [
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-20250514",
]) {
  test(`full native ${model} does not force unsupported 1M beta`, () => {
    const beta = selectBetaFlags(
      {
        model,
        system: "Native fixture",
        tools: [{ name: "Read", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "hi" }],
      },
      model,
      "oauth-2025-04-20,claude-code-20250219"
    );
    assert.equal(beta.split(",").includes("context-1m-2025-08-07"), false);
  });
}
for (const beta of [undefined, "oauth-2025-04-20,context-1m-2025-08-07"]) {
  test(`legacy Opus full-agent rejects forced or negotiated unsupported 1M: ${beta ?? "opaque"}`, () => {
    const flags = selectBetaFlags(
      { model: "claude-opus-4-5-20251101", system: "Native fixture", tools: [{ name: "Read" }] },
      null,
      beta
    );
    assert.equal(flags.split(",").includes("context-1m-2025-08-07"), false);
  });
}
for (const requested of [false, true]) {
  test(`supported Opus preserves actual client 1M negotiation: ${requested}`, () => {
    const flags = selectBetaFlags(
      { model: "claude-opus-4-8", system: "Native fixture", tools: [{ name: "Read" }] },
      null,
      `oauth-2025-04-20${requested ? ",context-1m-2025-08-07" : ""}`
    );
    assert.equal(flags.split(",").includes("context-1m-2025-08-07"), requested);
  });
}
