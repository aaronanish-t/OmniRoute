// #8020: `peekCodexSseTransientError()`'s first-chunk read (open-sse/executors/codex.ts) had
// NO timeout wrapper — a 200 text/event-stream response whose body never emits a byte hung on a
// bare `reader.read()` for ~15 minutes (901399ms observed) before the platform killed the
// connection and surfaced a generic 502. This runs BEFORE chatCore's normal readiness/idle-timeout
// pipeline takes over, so FETCH_BODY_TIMEOUT_MS / STREAM_IDLE_TIMEOUT_MS never applied to it.
//
// Fix: every read in the peek loop and the re-assembled passthrough body is now bounded by a
// PER-READ timeout (open-sse/executors/codex/bodyTimeout.ts), so a stalled body settles fast
// instead of hanging, while a long-but-alive stream that keeps emitting chunks never trips it.
import test from "node:test";
import assert from "node:assert/strict";

import { peekCodexSseTransientError } from "../../open-sse/executors/codex.ts";

// Small, explicit override — never depends on the ~120s/600s production default, so this test
// settles fast and deterministically regardless of env configuration.
const TEST_TIMEOUT_MS = 200;

function stuckSseResponse(): Response {
  const stuck = new ReadableStream<Uint8Array>({
    pull() {
      // Never enqueue and never close — simulates an upstream body that goes silent.
    },
  });
  return new Response(stuck, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function sseResponse(...frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

async function readBody(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

test(
  "peekCodexSseTransientError does not hang forever on a silently stuck SSE body (#8020)",
  { timeout: 5000 },
  async () => {
    const start = Date.now();
    const peek = await peekCodexSseTransientError(stuckSseResponse(), TEST_TIMEOUT_MS);
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed < 2000,
      `expected peek to settle within 2000ms via a body timeout, took ${elapsed}ms`
    );
    assert.equal(peek.timedOut, true, "expected the peek to report timedOut on a stalled body");
    assert.equal(peek.matched, null);
    assert.equal(peek.replacementBody, null);
  }
);

test(
  "peekCodexSseTransientError still detects a transient error when the body responds promptly",
  async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(
            encoder.encode(
              'event: error\ndata: {"error":{"message":"Selected model is at capacity."}}\n\n'
            )
          );
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

    const peek = await peekCodexSseTransientError(response, TEST_TIMEOUT_MS);
    assert.equal(peek.timedOut ?? false, false);
    assert.match(peek.matched ?? "", /capacity/);
  }
);

test("peek hands lifecycle events to the normal readiness pipeline", async () => {
  const frame =
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n';
  const peek = await peekCodexSseTransientError(sseResponse(frame), TEST_TIMEOUT_MS);

  assert.equal(peek.timedOut ?? false, false);
  assert.equal(peek.matched, null);
  assert.ok(peek.replacementBody);
  assert.match(await readBody(peek.replacementBody), /response\.created/);
});

test("peek does not buffer reasoning or tool deltas until text output", async () => {
  const reasoning =
    'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}\n\n';
  const tool =
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.delta",
      delta: '{"x":',
    })}\n\n`;

  for (const frame of [reasoning, tool]) {
    const peek = await peekCodexSseTransientError(sseResponse(frame), TEST_TIMEOUT_MS);
    assert.equal(peek.timedOut ?? false, false);
    assert.equal(peek.matched, null);
    assert.ok(peek.replacementBody);
    assert.match(await readBody(peek.replacementBody), /response\.(reasoning|function_call)/);
  }
});

test("peek accepts valid Responses JSON with ordinary whitespace", async () => {
  const frame =
    'event: response.output_text.delta\ndata: {"type": "response.output_text.delta", "delta": "hello"}\n\n';
  const peek = await peekCodexSseTransientError(sseResponse(frame), TEST_TIMEOUT_MS);

  assert.equal(peek.timedOut ?? false, false);
  assert.equal(peek.matched, null);
  assert.ok(peek.replacementBody);
  assert.match(await readBody(peek.replacementBody), /hello/);
});
