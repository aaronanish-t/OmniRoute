import test from "node:test";
import assert from "node:assert/strict";
import {
  openAiChatCompletionChunkSchema,
  openAiChatCompletionRequestSchema,
  openAiChatCompletionResponseSchema,
  openAiErrorSchema,
  openAiModelListSchema,
} from "../../src/shared/contracts/openai.ts";

test("OpenAI request contract accepts standard fields and extensions", () => {
  const result = openAiChatCompletionRequestSchema.safeParse({
    model: "demo/model",
    messages: [{ role: "developer", content: "Be concise" }, { role: "user", content: "Hi" }],
    stream: true,
    provider_options: { effort: "high" },
  });
  assert.equal(result.success, true);
});

test("OpenAI response contracts distinguish complete responses from chunks", () => {
  const common = { id: "chatcmpl-test", created: 1, model: "demo/model", choices: [] };
  assert.equal(
    openAiChatCompletionResponseSchema.safeParse({ ...common, object: "chat.completion" }).success,
    true
  );
  assert.equal(
    openAiChatCompletionChunkSchema.safeParse({ ...common, object: "chat.completion.chunk" }).success,
    true
  );
  assert.equal(
    openAiChatCompletionResponseSchema.safeParse({ ...common, object: "chat.completion.chunk" }).success,
    false
  );
});

test("OpenAI error and model-list envelopes are stable", () => {
  assert.equal(
    openAiErrorSchema.safeParse({ error: { message: "bad", type: "invalid_request_error" } }).success,
    true
  );
  assert.equal(
    openAiModelListSchema.safeParse({ object: "list", data: [] }).success,
    true
  );
});

