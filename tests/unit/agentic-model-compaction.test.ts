import assert from "node:assert/strict";
import test from "node:test";
import { compactAgenticBody } from "../../open-sse/services/agenticCompaction.ts";
import { handleAgenticPipelineChat } from "../../open-sse/services/agenticPipeline.ts";
import { comboRuntimeConfigSchema } from "../../src/shared/validation/schemas/combo.ts";

const config = {
  enabled: true,
  defaultMaxChars: 10_000,
  targetRatio: 0.72,
  toolResultMaxChars: 1_000,
};
const large = "x".repeat(20_000);
const source = () => ({
  messages: [
    { role: "system", content: "keep instructions" },
    { role: "user", content: large },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "current task" },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "read" },
        { type: "tool_use", id: "b", name: "read" },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: large },
        { type: "tool_result", tool_use_id: "b", content: large },
      ],
    },
  ],
  tools: [{ name: "read" }, { name: "read" }],
  stream: true,
});

test("per-model budget compacts history, keeps instructions and the parallel active tool boundary", () => {
  const body = source();
  const original = JSON.stringify(body);
  const small = compactAgenticBody(body, "p/small", {
    ...config,
    defaultMaxChars: 100_000,
    modelMaxChars: { "p/small": 10_000 },
  });
  assert.equal(small.compacted, true);
  assert.equal(small.overLimit, false);
  assert.ok(small.after <= 7_200);
  assert.equal(small.body.stream, true);
  assert.equal((small.body.tools as unknown[]).length, 1);
  assert.match(JSON.stringify(small.body), /keep instructions/);
  assert.match(JSON.stringify(small.body), /current task/);
  assert.match(JSON.stringify(small.body), /sha256=/);
  assert.equal(
    (small.body.messages as unknown[]).filter((item) => JSON.stringify(item).includes('"tool_use"'))
      .length,
    1
  );
  assert.equal(JSON.stringify(body), original);
  assert.equal(
    compactAgenticBody(body, "p/large", { ...config, defaultMaxChars: 100_000 }).body,
    body
  );
});
test("disabled compaction leaves the exact request untouched", () => {
  const body = source();
  assert.equal(compactAgenticBody(body, "p/small").body, body);
  assert.equal(compactAgenticBody(body, "p/small", { ...config, enabled: false }).body, body);
});
test("Chat Completions, Responses and Gemini retain call/result identifiers and valid result shapes", () => {
  const bodies = [
    {
      messages: [
        { role: "user", content: "task" },
        {
          role: "assistant",
          tool_calls: [{ id: "a", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "a", content: large },
      ],
    },
    {
      input: [
        { role: "user", content: "task" },
        { type: "function_call", call_id: "a", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "a", output: large },
      ],
    },
    {
      contents: [
        { role: "user", parts: [{ text: "instruction" }] },
        { role: "user", parts: [{ text: "task" }] },
        { role: "model", parts: [{ functionCall: { name: "read", args: {} } }] },
        {
          role: "user",
          parts: [{ functionResponse: { name: "read", response: { result: large } } }],
        },
      ],
    },
  ];
  for (const body of bodies) {
    const result = compactAgenticBody(body, "p/small", config);
    assert.equal(result.overLimit, false);
    assert.match(JSON.stringify(result.body), /read/);
    assert.match(JSON.stringify(result.body), /evidence compacted/);
  }
});
test("different tool schemas with the same name are preserved", () => {
  const body = {
    ...source(),
    tools: [
      { name: "read", description: "one" },
      { name: "read", description: "two" },
    ],
  };
  assert.equal((compactAgenticBody(body, "p/small", config).body.tools as unknown[]).length, 2);
});
test("uncompressible pinned context fails before upstream dispatch", async () => {
  let calls = 0;
  const noop = () => undefined;
  const result = await handleAgenticPipelineChat({
    body: { messages: [{ role: "user", content: large }] },
    steps: [{ model: "p/planner" }, { model: "p/executor" }],
    config: { contextCompaction: config },
    log: { info: noop, warn: noop, debug: noop },
    handleSingleModel: async () => {
      calls++;
      return new Response("unexpected");
    },
  });
  assert.equal(result.status, 413);
  assert.equal(calls, 0);
});
test("planner decision, executor and planner final use their own configured budgets", async () => {
  const seen: string[] = [];
  const noop = () => undefined;
  const run = async (route: string) =>
    handleAgenticPipelineChat({
      body: source(),
      steps: [{ model: "p/planner" }, { model: "p/executor" }],
      config: {
        contextCompaction: {
          ...config,
          modelMaxChars: { "p/planner": 12_000, "p/executor": 10_000 },
        },
      },
      log: { info: noop, warn: noop, debug: noop },
      handleSingleModel: async (body, model) => {
        seen.push(model);
        assert.ok(JSON.stringify(body).length <= (model === "p/planner" ? 12_000 : 10_000));
        return Response.json({
          choices: [{ message: { content: `OMNIROUTE_ROUTE: ${route}\nContinue.` } }],
        });
      },
    });
  await run("TOOLS");
  await run("FINAL");
  assert.deepEqual(seen, ["p/planner", "p/executor", "p/planner", "p/planner"]);
});
test("compaction configuration validates budgets and rejects unknown settings", () => {
  assert.equal(
    comboRuntimeConfigSchema.safeParse({ agenticOrchestration: { contextCompaction: config } })
      .success,
    true
  );
  for (const invalid of [
    { ...config, defaultMaxChars: 1 },
    { ...config, targetRatio: 1 },
    { ...config, mystery: true },
  ])
    assert.equal(
      comboRuntimeConfigSchema.safeParse({ agenticOrchestration: { contextCompaction: invalid } })
        .success,
      false
    );
});
