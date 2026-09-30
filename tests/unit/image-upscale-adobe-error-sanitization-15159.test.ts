import assert from "node:assert/strict";
import { test } from "node:test";

// Regression guard for audit #15159 / Hard Rule #12 — E-15 (adobe-firefly upscale).
//
// `open-sse/handlers/imageUpscale/adobeFirefly.ts:132-140` passed `AdobeFireflyError.message`
// directly to `saveUpscaleErrorResult` without sanitization.
//
// This test verifies that a fetch error with hostile content is sanitized
// when it propagates through the handler's generic catch block.

async function makeHandler(body: Record<string, unknown>, credentials: { apiKey?: string } = {}) {
  const { handleAdobeFireflyImageUpscale } = await import("../../open-sse/handlers/imageUpscale/adobeFirefly.ts");
  return handleAdobeFireflyImageUpscale({
    model: "topaz-standard",
    provider: "adobe-firefly",
    body,
    credentials,
    log: console,
  });
}

test("E-15: adobe-firefly upscale never surfaces raw upstream error text", async () => {
  const raw = "adobe upscale failed at /srv/app/client.ts:44:15 api_key=sk-1234567890abcdef";
  
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: string | URL, _opts?: RequestInit) => {
    const urlStr = String(_url);
    if (urlStr.includes("/auth/token")) {
      return new Response(JSON.stringify({ access_token: "mock-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("/images")) {
      return new Response("uploaded", { status: 200 });
    }
    if (urlStr.includes("/upsample")) {
      return new Response(raw, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response("ok", { status: 200 });
  };

  try {
    const result = await makeHandler({
      image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    }, { apiKey: "test-key" });

    const errorStr = String(result.error);
    assert.ok(!errorStr.includes("at /srv/app/client.ts:44:15"), "stack frame leaked");
    assert.ok(!errorStr.includes("/srv/app/"), "absolute path leaked");
    assert.ok(!errorStr.includes("sk-1234567890abcdef"), "api key leaked");
  } finally {
    globalThis.fetch = originalFetch;
  }
});