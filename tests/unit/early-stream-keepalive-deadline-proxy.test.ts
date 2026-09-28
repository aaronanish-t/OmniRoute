/**
 * @file early-stream-keepalive-deadline-proxy.test.ts
 * @description Regression test for withDeadlineSignal on Node >=26.10 when the input
 * Request is a Proxy (as Next.js 16 route handlers hand in).
 * makes undici read a private #state field on the proxy, which does not tunnel through
 * Proxy traps and throws TypeError: Cannot read private member #state from an object
 * whose class did not declare it. The fix rebuilds via new Request(url, init) using
 * url/method/headers/body instead of passing the Request object as input.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  getDeadlineController,
  withDeadlineSignal,
} from "../../open-sse/utils/earlyStreamKeepalive.ts";

const OriginalRequest = globalThis.Request;

const proxiedInputs = new WeakSet<object>();

class GuardedRequest extends OriginalRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === "object" && input !== null && proxiedInputs.has(input)) {
      throw new TypeError(
        "Cannot read private member #state from an object whose class did not declare it"
      );
    }
    super(input, init);
  }
}

function wrapAsProxy(request: Request): Request {
  const proxy = new Proxy(request, {});
  proxiedInputs.add(proxy);
  return proxy as unknown as Request;
}

test.before(() => {
  // @ts-expect-error test-only override
  globalThis.Request = GuardedRequest;
});

test.after(() => {
  globalThis.Request = OriginalRequest;
});

test("withDeadlineSignal wraps a Proxy-wrapped POST request without throwing", async () => {
  const bodyText = JSON.stringify({ hello: "world" });
  const inner = new OriginalRequest("https://example.test/v1/chat/completions", {
    method: "POST",
    headers: { "x-my-header": "abc" },
    body: bodyText,
  });
  const proxied = wrapAsProxy(inner);

  const { wrappedReq, deadlineController } = withDeadlineSignal(proxied);

  assert.equal(wrappedReq.url, "https://example.test/v1/chat/completions");
  assert.equal(wrappedReq.method, "POST");
  assert.equal(wrappedReq.headers.get("x-my-header"), "abc");
  assert.ok(wrappedReq.headers.get("x-deadline-token"), "deadline token header must be set");
  assert.equal(await wrappedReq.text(), bodyText);
  assert.equal(getDeadlineController(wrappedReq), deadlineController);
});

test("withDeadlineSignal wraps a Proxy-wrapped GET request without a body", async () => {
  const inner = new OriginalRequest("https://example.test/v1/models", { method: "GET" });
  const proxied = wrapAsProxy(inner);

  const { wrappedReq } = withDeadlineSignal(proxied);

  assert.equal(wrappedReq.method, "GET");
  assert.equal(wrappedReq.url, "https://example.test/v1/models");
  assert.equal(await wrappedReq.text(), "");
});
