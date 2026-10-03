import assert from "node:assert/strict";
import test from "node:test";
import { stalledToolLoopReason } from "../../open-sse/services/agenticLoopGuard.ts";
import { handleAgenticPipelineChat } from "../../open-sse/services/agenticPipeline.ts";

const round = (id: string, result = "unchanged", error = false) => [
  { role: "assistant", content: [{ type: "tool_use", id, name: "read", input: { path: "a" } }] },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: result, is_error: error }],
  },
];
test("repeated rounds require unchanged evidence, and fresh requests reset detection", () => {
  assert.match(
    stalledToolLoopReason({ messages: [...round("a"), ...round("b")] }) ?? "",
    /same tool/
  );
  assert.equal(
    stalledToolLoopReason({ messages: [...round("a"), ...round("b", "changed")] }),
    null
  );
  assert.equal(
    stalledToolLoopReason({
      messages: [...round("a"), { role: "user", content: "new task" }, ...round("b")],
    }),
    null
  );
  assert.match(
    stalledToolLoopReason({
      messages: [...round("a", "error1", true), ...round("b", "error2", true)],
    }) ?? "",
    /failed/
  );
});
test("native Chat Completions, Responses and Gemini histories are supported", () => {
  const chat = (id: string) => [
    {
      role: "assistant",
      tool_calls: [{ id, function: { name: "read", arguments: '{"path":"a"}' } }],
    },
    { role: "tool", tool_call_id: id, content: "same" },
  ];
  const responses = (id: string) => [
    { type: "function_call", call_id: id, name: "read", arguments: '{"path":"a"}' },
    { type: "function_call_output", call_id: id, output: "same" },
  ];
  const gemini = () => [
    { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a" } } }] },
    { role: "user", parts: [{ functionResponse: { name: "read", response: { result: "same" } } }] },
  ];
  for (const body of [
    { messages: [...chat("a"), ...chat("b")] },
    { input: [...responses("a"), ...responses("b")] },
    { contents: [...gemini(), ...gemini()] },
  ])
    assert.ok(stalledToolLoopReason(body));
});
test("parallel identical calls in a single round do not count as a stalled loop", () => {
  const first = round("a");
  const second = round("b");
  assert.equal(
    stalledToolLoopReason({
      messages: [
        { role: "assistant", content: [...first[0].content, ...second[0].content] },
        { role: "user", content: [...first[1].content, ...second[1].content] },
      ],
    }),
    null
  );
});
test("stalled continuation forces planner final even if planner requests more tools", async () => {
  const seen: string[] = [];
  const noop = () => undefined;
  await handleAgenticPipelineChat({
    body: { messages: [...round("a"), ...round("b")], tools: [{ name: "read" }] },
    steps: [{ model: "p/planner" }, { model: "p/executor" }],
    log: { info: noop, warn: noop, debug: noop },
    handleSingleModel: async (body, model) => {
      seen.push(model);
      assert.match(JSON.stringify(body), /same tool calls/);
      return Response.json({
        choices: [{ message: { content: "OMNIROUTE_ROUTE: TOOLS\nRetry." } }],
      });
    },
  });
  assert.deepEqual(seen, ["p/planner", "p/planner"]);
});
