import assert from "node:assert/strict";
import test from "node:test";
import { antigravityToOpenAIRequest } from "../../open-sse/translator/request/antigravity-to-openai.ts";

test("antigravityToOpenAIRequest strips toolConfig from translated tools", () => {
  const body = {
    request: {
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Get weather",
              parameters: { type: "OBJECT", properties: { location: { type: "STRING" } } }
            }
          ]
        }
      ],
      toolConfig: { functionCallingConfig: { mode: "VALIDATED" } }
    }
  };

  const res = antigravityToOpenAIRequest("gemini-2.5-flash", body, false);
  assert.equal(res.toolConfig, undefined);
  assert.equal(Array.isArray(res.tools), true);
  assert.equal(res.tools?.length, 1);
});
