import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enforceCacheControlLimit,
  ensureCacheControlOnLastUserMessage,
  finalizeClaudeBodyConstraints,
} from "../../open-sse/services/claudeCodeConstraints.ts";
const marker = () => ({ type: "ephemeral" });
function fixture(thread = true): Record<string, unknown> {
  return {
    ...(thread ? { thread: { id: "native-conversation" } } : {}),
    system: [
      { type: "text", text: "system-a", cache_control: marker() },
      { type: "text", text: "system-b", cache_control: marker() },
    ],
    tools: [{ name: "lookup", input_schema: { type: "object" }, cache_control: marker() }],
    messages: [
      { role: "user", content: [{ type: "text", text: "question", cache_control: marker() }] },
    ],
  };
}
function count(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n, x) => n + count(x), 0);
  if (value && typeof value === "object")
    return Object.entries(value).reduce(
      (n, [key, v]) => n + (key === "cache_control" ? 1 : count(v)),
      0
    );
  return 0;
}
test("native thread reserves one cache marker slot without changing prompt or thread", () => {
  const body = fixture();
  const before = JSON.parse(JSON.stringify(body));
  enforceCacheControlLimit(body);
  assert.equal(count(body), 3);
  assert.deepEqual(body.thread, before.thread);
  assert.equal(
    JSON.stringify(body).replace(/,"cache_control":\{"type":"ephemeral"\}/g, ""),
    JSON.stringify(before).replace(/,"cache_control":\{"type":"ephemeral"\}/g, "")
  );
});
test("requests without a native thread retain four explicit cache markers", () => {
  const body = fixture(false);
  const before = JSON.stringify(body);
  enforceCacheControlLimit(body);
  assert.equal(count(body), 4);
  assert.equal(JSON.stringify(body), before);
});
test("last user heuristic cannot refill the reserved thread marker slot", () => {
  const body = fixture();
  const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
  delete messages[0].content[0].cache_control;
  ensureCacheControlOnLastUserMessage(body);
  assert.equal(count(body), 3);
  assert.equal(messages[0].content[0].cache_control, undefined);
});
test("last user heuristic counts tool markers in the ordinary four-slot budget", () => {
  const body = fixture(false);
  (body.tools as Array<Record<string, unknown>>).push({ name: "other", cache_control: marker() });
  delete (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content[0]
    .cache_control;
  ensureCacheControlOnLastUserMessage(body);
  assert.equal(count(body), 4);
});
test("final wire constraints enforce the native thread marker budget", () => {
  const body = fixture();
  finalizeClaudeBodyConstraints(body);
  assert.equal(count(body), 3);
});
