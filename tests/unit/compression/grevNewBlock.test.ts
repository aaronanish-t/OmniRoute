import test from "node:test";
import assert from "node:assert/strict";

import {
  applyGrevNewBlockPipeline,
  findCurrentGrevPromptIndex,
} from "../../../open-sse/services/compression/grevNewBlock.ts";

test("GrevCaching only normalizes whitespace in the newest user turn", async () => {
  const history = { role: "user", content: "old   history" };
  const tool = { role: "tool", content: "tool   output" };
  const current = { role: "user", content: "new   prompt\n\n\nwith trailing spaces  \n" };
  const body = { messages: [history, tool, current] };

  const result = await applyGrevNewBlockPipeline(body, ["lite"]);
  const messages = result.body.messages as typeof body.messages;

  assert.equal(result.compressed, true);
  assert.deepEqual(messages[0], history);
  assert.deepEqual(messages[1], tool);
  assert.equal(messages[2].content, "new   prompt\n\nwith trailing spaces\n");
  assert.deepEqual(result.stats?.techniquesUsed, ["whitespace"]);
  assert.deepEqual(
    result.stats?.engineBreakdown?.map((pass) => pass.engine),
    ["lite"]
  );
});

test("GrevCaching with no selected pass leaves the prompt unchanged", async () => {
  const body = { messages: [{ role: "user", content: "Keep  this exactly." }] };
  const result = await applyGrevNewBlockPipeline(body, []);
  assert.equal(result.compressed, false);
  assert.equal(result.body, body);
  assert.ok(result.stats);
});

test("GrevCaching recognizes a current multimodal user message that contains text", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Large pasted prompt" }, { type: "image" }] },
  ];
  assert.equal(findCurrentGrevPromptIndex(messages), 0);
});
