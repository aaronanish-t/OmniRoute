import { test } from "node:test";
import assert from "node:assert/strict";
import {
  museSessionScope,
  claimMuseSession,
  bindMuseGeneration,
  recordMuseOutput,
} from "../../src/sse/services/museSessionOwnership.ts";
import { getDbInstance } from "../../src/lib/db/core.ts";

const candidates = [{ id: "account-a" }, { id: "account-b" }];
test("fresh sessions alternate while tool continuations preserve exact encrypted output and owner", async () => {
  getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = ?")
    .run("muse_session_ownership");
  const scope = museSessionScope({ prompt_cache_key: "session-a" }, undefined, "client");
  const other = museSessionScope({ prompt_cache_key: "session-b" }, undefined, "client");
  assert.equal(
    claimMuseSession(scope, { input: "read fixture" }, candidates).connectionId,
    "account-a"
  );
  assert.equal(
    claimMuseSession(other, { input: "read fixture" }, candidates).connectionId,
    "account-b"
  );
  const generation = bindMuseGeneration(scope, "account-a", "private-test-key-a", "identity-a");
  const output = [
    { type: "reasoning", encrypted_content: "opaque-test-a", summary: [] },
    { type: "function_call", call_id: "call-a", name: "read", arguments: "{}" },
  ];
  const wire =
    `data: ${JSON.stringify({ type: "response.output_item.done", item: output[0] })}\r\n\r\n` +
    `data: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\n` +
    "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(wire);
  const source = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7)
        controller.enqueue(bytes.slice(offset, offset + 7));
      controller.close();
    },
  });
  assert.equal(
    await recordMuseOutput(
      new Response(source, { headers: { "content-type": "text/event-stream" } }),
      scope,
      generation
    ).text(),
    wire
  );
  const input = [
    ...output,
    { type: "function_call_output", call_id: "call-a", output: "fixture result" },
  ];
  const before = structuredClone(input);
  assert.equal(claimMuseSession(scope, { input }, candidates).connectionId, "account-a");
  assert.deepEqual(input, before);
  assert.throws(() => claimMuseSession(other, { input }, candidates), /not issued/);
  assert.throws(() => claimMuseSession(scope, { input }, [candidates[1]]), /unavailable/);
  assert.throws(() => claimMuseSession(scope, { input }, candidates, "account-b"), /differs/);
  assert.throws(
    () => bindMuseGeneration(scope, "account-a", "replacement-key", "identity-a"),
    /generation changed/
  );
  assert.throws(
    () => bindMuseGeneration(scope, "account-a", "private-test-key-a", "identity-b"),
    /owner changed/
  );
  assert.equal(
    bindMuseGeneration(scope, "account-a", "private-test-key-a", "identity-a"),
    generation
  );
  assert.throws(
    () =>
      claimMuseSession(
        scope,
        { input: [{ type: "function_call_output", call_id: "foreign-call", output: "foreign" }] },
        candidates
      ),
    /not issued/
  );
});

test("reminted same-account key is adopted when no replayable history was recorded", () => {
  const scope = museSessionScope({ prompt_cache_key: "remint-session" }, undefined, "client");
  const owner = claimMuseSession(scope, { input: "fresh" }, candidates);
  const first = bindMuseGeneration(scope, owner.connectionId, "minted-key-1", "stable-identity");
  const second = bindMuseGeneration(scope, owner.connectionId, "minted-key-2", "stable-identity");
  assert.notEqual(first, second);
  assert.equal(
    bindMuseGeneration(scope, owner.connectionId, "minted-key-2", "stable-identity"),
    second
  );
});

test("unknown replay, missing identity and another API client cannot adopt encrypted reasoning", () => {
  assert.throws(
    () => museSessionScope({ input: "same prompt" }, undefined, "client"),
    /explicit session/
  );
  const scope = museSessionScope({ prompt_cache_key: "unknown-session" }, undefined, "client");
  for (const input of [
    [{ type: "reasoning", encrypted_content: "foreign" }],
    [{ type: "function_call_output", call_id: "old", output: "old result" }],
  ]) {
    assert.throws(() => claimMuseSession(scope, { input }, candidates), /no recorded owner/);
  }
  assert.throws(
    () => claimMuseSession(scope, { previous_response_id: "old" }, candidates),
    /no recorded owner/
  );
  assert.notEqual(
    museSessionScope({ prompt_cache_key: "session-a" }, undefined, "client"),
    museSessionScope({ prompt_cache_key: "session-a" }, undefined, "different-client")
  );
  assert.equal(
    museSessionScope({ input: "x" }, new Headers({ "x-session-id": "hdr-session" }), "client"),
    museSessionScope({ input: "x" }, { "x-session-id": "hdr-session" }, "client")
  );
});

test("JSON output records ownership, and upstream errors retain their original body/status", async () => {
  const scope = museSessionScope({ prompt_cache_key: "json-session" }, undefined, "client");
  const owner = claimMuseSession(scope, { input: "fresh" }, candidates);
  const generation = bindMuseGeneration(scope, owner.connectionId, "json-key", "json-identity");
  const output = [{ type: "reasoning", encrypted_content: "json-opaque" }];
  const wire = JSON.stringify({ output });
  assert.equal(await recordMuseOutput(new Response(wire), scope, generation).text(), wire);
  assert.equal(
    claimMuseSession(scope, { input: output }, candidates).connectionId,
    owner.connectionId
  );
  const failure = new Response("caller mismatch", { status: 400 });
  assert.equal(recordMuseOutput(failure, scope, generation), failure);
  assert.equal(await failure.text(), "caller mismatch");
});
