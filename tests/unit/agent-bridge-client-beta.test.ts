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
