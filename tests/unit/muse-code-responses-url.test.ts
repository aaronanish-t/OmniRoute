import test from "node:test";
import assert from "node:assert/strict";

import { DefaultExecutor } from "../../open-sse/executors/default.ts";

// Native muse-code OAuth connections persist providerSpecificData.baseUrl from the
// mint response ("https://api.meta.ai/v1"). The custom-baseUrl branch normalized
// that to /chat/completions while chatCore sent a Responses body (registry
// targetFormat openai-responses), so Meta rejected every request with
// "unknown parameter `input`" / "unknown parameter `include`".

const museCredentials = {
  accessToken: "minted-key",
  providerSpecificData: { baseUrl: "https://api.meta.ai/v1" },
};

test("muse-code Responses models with a stored baseUrl route to /responses", () => {
  const executor = new DefaultExecutor("muse-code");
  for (const model of ["muse-spark-1.3", "muse-spark-1.2-contributor", "llama-4-maverick"]) {
    assert.equal(
      executor.buildUrl(model, true, 0, museCredentials),
      "https://api.meta.ai/v1/responses",
      model
    );
  }
});

test("muse-code without a stored baseUrl keeps the registry Responses endpoint", () => {
  const executor = new DefaultExecutor("muse-code");
  assert.equal(
    executor.buildUrl("muse-spark-1.3", true, 0, { accessToken: "minted-key" }),
    "https://api.meta.ai/v1/responses"
  );
});

test("chat-format models behind a custom baseUrl still use /chat/completions", () => {
  const executor = new DefaultExecutor("openrouter");
  assert.equal(
    executor.buildUrl("openai/gpt-4o-mini", true, 0, {
      apiKey: "k",
      providerSpecificData: { baseUrl: "https://gateway.example/v1" },
    }),
    "https://gateway.example/v1/chat/completions"
  );
});
