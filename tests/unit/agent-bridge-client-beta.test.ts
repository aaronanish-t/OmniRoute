import test from "node:test";
import assert from "node:assert/strict";
import { mergeClientAnthropicBeta } from "../../open-sse/config/anthropicHeaders.ts";

test("native message thread negotiation survives the provider beta merge", () => {
  const body = { thread: { type: "create" }, diagnostics: { previous_message_id: null } };
  const merged = mergeClientAnthropicBeta(
    "oauth-2025-04-20",
    "message-threads-2026-08-12,unrecognized-fixture-beta",
    undefined,
    "claude-sonnet-5-5",
    body
  );
  assert.equal(merged, "oauth-2025-04-20,message-threads-2026-08-12");
  assert.deepEqual(body, {
    thread: { type: "create" },
    diagnostics: { previous_message_id: null },
  });
});

test("message threads are never forced onto a client that did not negotiate them", () => {
  assert.equal(
    mergeClientAnthropicBeta("oauth-2025-04-20", "effort-2025-11-24"),
    "oauth-2025-04-20,effort-2025-11-24"
  );
  assert.equal(mergeClientAnthropicBeta("oauth-2025-04-20", null), "oauth-2025-04-20");
});

test("client thread beta negotiation remains deduplicated", () => {
  assert.equal(
    mergeClientAnthropicBeta(
      "oauth-2025-04-20,message-threads-2026-08-12",
      "message-threads-2026-08-12,message-threads-2026-08-12"
    ),
    "oauth-2025-04-20,message-threads-2026-08-12"
  );
});

import { BaseExecutor } from "../../open-sse/executors/base.ts";

test("inline tools and advisor client negotiation survive the beta merge", () => {
  const merged = mergeClientAnthropicBeta(
    "oauth-2025-04-20",
    "inline-tools-2026-09-15,advisor-tool-2026-03-01"
  );
  assert.ok(merged.includes("inline-tools-2026-09-15"));
  assert.ok(merged.includes("advisor-tool-2026-03-01"));
});
test("native first-party clients preserve future negotiated protocol betas", () => {
  assert.equal(
    mergeClientAnthropicBeta(
      "oauth-2025-04-20",
      "native-future-fixture-2026-10-02",
      undefined,
      "claude-sonnet-5-5",
      {},
      true
    ),
    "oauth-2025-04-20,native-future-fixture-2026-10-02"
  );
  assert.equal(
    mergeClientAnthropicBeta("oauth-2025-04-20", "native-future-fixture-2026-10-02"),
    "oauth-2025-04-20"
  );
});
test("native protocol passthrough still gates model and body-dependent betas", () => {
  const merged = mergeClientAnthropicBeta(
    "oauth-2025-04-20",
    "context-1m-2025-08-07,skills-2025-10-02,native-future-fixture-2026-10-02",
    undefined,
    "claude-haiku-4-5-20251001",
    {},
    true
  );
  assert.equal(merged, "oauth-2025-04-20,native-future-fixture-2026-10-02");
});
class NativeBetaExecutor extends BaseExecutor {
  constructor() {
    super("claude", { format: "claude", baseUrls: ["https://api.anthropic.com/v1/messages"] });
  }
  buildHeaders(...args: Parameters<BaseExecutor["buildHeaders"]>) {
    if (args[1] === false && args[2])
      assert.ok(args[5], "header eligibility needs the count request body");
    return super.buildHeaders(...args);
  }
  needsRefresh() {
    return false;
  }
  async transformRequest(_model: string, body: Record<string, unknown>) {
    return { ...body };
  }
}
for (const native of [true, false])
  test(`final Claude dispatch keeps protocol betas only on native identified requests: ${native}`, async () => {
    const original = globalThis.fetch;
    let outgoing: Headers | undefined;
    globalThis.fetch = async (_url: string | URL | Request, init: RequestInit = {}) => {
      outgoing = new Headers(init.headers);
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      await new NativeBetaExecutor().execute({
        model: "claude-sonnet-5-5",
        body: {
          model: "claude-sonnet-5-5",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "advisor_20260301", name: "advisor" }],
        },
        stream: false,
        credentials: { accessToken: "sk-ant-oat-fixture" },
        clientHeaders: {
          ...(native ? { "x-app": "cli" } : {}),
          "anthropic-beta":
            "inline-tools-2026-09-15,advisor-tool-2026-03-01,native-future-fixture-2026-10-02",
        },
      });
    } finally {
      globalThis.fetch = original;
    }
    assert.ok(outgoing);
    const beta = outgoing.get("anthropic-beta") || "";
    assert.ok(beta.includes("inline-tools-2026-09-15"));
    assert.ok(beta.includes("advisor-tool-2026-03-01"));
    assert.equal(beta.includes("native-future-fixture-2026-10-02"), native);
  });

for (const native of [true, false])
  test(`count_tokens preserves negotiated tool protocol and provider credentials: ${native}`, async () => {
    const original = globalThis.fetch;
    let outgoing: Headers | undefined;
    let outgoingBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url: string | URL | Request, init: RequestInit = {}) => {
      outgoing = new Headers(init.headers);
      outgoingBody = JSON.parse(String(init.body));
      return new Response('{"input_tokens":42}', { status: 200 });
    };
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "advisor_20260301", name: "advisor" }],
    };
    let result;
    try {
      result = await new NativeBetaExecutor().countTokens({
        model: "claude-sonnet-5-5",
        body,
        credentials: { accessToken: "sk-ant-oat-fixture" },
        clientHeaders: {
          ...(native ? { "x-app": "cli" } : {}),
          authorization: "Bearer original-client-credential",
          "anthropic-beta":
            "inline-tools-2026-09-15,advisor-tool-2026-03-01,native-future-fixture-2026-10-02",
        },
      });
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(result?.source, "provider");
    assert.equal(result?.input_tokens, 42);
    assert.equal(outgoing?.get("authorization"), "Bearer sk-ant-oat-fixture");
    assert.deepEqual(outgoingBody?.tools, body.tools);
    const beta = outgoing?.get("anthropic-beta") || "";
    assert.ok(beta.includes("inline-tools-2026-09-15"));
    assert.ok(beta.includes("advisor-tool-2026-03-01"));
    assert.equal(beta.includes("native-future-fixture-2026-10-02"), native);
  });
