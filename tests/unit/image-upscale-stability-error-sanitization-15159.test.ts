import assert from "node:assert/strict";
import { test } from "node:test";

import { handleStabilityImageUpscale } from "../../open-sse/handlers/imageUpscale/stability.ts";

// Regression guard for audit #15159 / Hard Rule #12 — E-15 (stability upscale).
//
// `open-sse/handlers/imageUpscale/stability.ts` has two live leak sites:
// 1. Line 162-172: raw upstream response.text() passed directly to saveUpscaleErrorResult
// 2. Line 279-286: pollStabilityResult reads raw response.text() and throws it
//
// Both leak raw upstream error text (stack frames, credentials) to clients.

async function makeHandler(body: Record<string, unknown>, credentials: { apiKey?: string } = {}) {
  const { handleStabilityImageUpscale } = await import("../../open-sse/handlers/imageUpscale/stability.ts");
  return handleStabilityImageUpscale({
    model: "conservative",
    provider: "stability-ai",
    providerConfig: { baseUrl: "https://api.stability.ai" },
    body,
    credentials,
    log: console,
  });
}

test("E-15: stability upscale never surfaces raw upstream response.text() in 502", async () => {
  const raw = "upstream failed at /srv/app/client.ts:44:15 api_key=sk-1234567890abcdef";
  
  // Mock fetch to return a non-ok response with hostile body
  const original = globalThis.fetch;
  globalThis.fetch = async (url: string | URL, opts?: RequestInit) => {
    return new Response(raw, {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await makeHandler({
      image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      prompt: "test",
    }, { apiKey: "test-key" });

    assert.equal(result.status, 502);
    assert.ok(!String(result.error).includes("at /srv/app/client.ts:44:15"), "stack frame leaked");
    assert.ok(!String(result.error).includes("/srv/app/"), "absolute path leaked");
    assert.ok(!String(result.error).includes("sk-1234567890abcdef"), "api key leaked");
  } finally {
    globalThis.fetch = original;
  }
});

test("E-15: stability upscale never surfaces raw upstream error from pollStabilityResult", async () => {
  const raw = "auth failed: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
  
  const original = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url: string | URL, opts?: RequestInit) => {
    callCount++;
    const urlStr = String(url);
    if (callCount === 1) {
      // First call - POST /upscale/conservative
      return new Response(JSON.stringify({ id: "job-123" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Second call - GET /results/job-123 - use 400 (non-retryable)
    return new Response(raw, {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await makeHandler({
      image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      prompt: "test",
    }, { apiKey: "test-key" });

    // Just verify the error is sanitized - status may vary based on error path
    const errorStr = String(result.error);
    assert.ok(!errorStr.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "JWT leaked");
    assert.ok(!errorStr.includes("Bearer"), "Bearer token leaked");
  } finally {
    globalThis.fetch = original;
  }
});