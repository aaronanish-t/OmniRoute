import test from "node:test";
import assert from "node:assert/strict";

const { createErrorResponse, createErrorResponseFromUnknown } =
  await import("../../src/lib/api/errorResponse.ts");

const SENSITIVE_MESSAGE =
  "Request failed at /srv/omniroute/provider.ts:44 api_key=sk-secret123456789";

test("createErrorResponse sanitizes client-visible messages without changing the envelope", async () => {
  const response = createErrorResponse({
    status: 503,
    message: SENSITIVE_MESSAGE,
    type: "server_error",
    details: { retryable: true },
  });
  const body = (await response.json()) as {
    error: { message: string; type: string; details: unknown };
    requestId: string;
  };

  assert.equal(response.status, 503);
  assert.equal(body.error.type, "server_error");
  assert.deepEqual(body.error.details, { retryable: true });
  assert.match(body.requestId, /^[0-9a-f-]{36}$/i);
  assert.doesNotMatch(body.error.message, /\/srv\/omniroute\/provider\.ts/i);
  assert.doesNotMatch(body.error.message, /sk-secret123456789/i);
});

test("createErrorResponseFromUnknown cannot bypass the shared sanitizer", async () => {
  const response = createErrorResponseFromUnknown({
    status: 500,
    message: SENSITIVE_MESSAGE,
    type: "server_error",
  });
  const body = (await response.json()) as { error: { message: string; type: string } };

  assert.equal(response.status, 500);
  assert.equal(body.error.type, "server_error");
  assert.doesNotMatch(body.error.message, /\/srv\/omniroute\/provider\.ts/i);
  assert.doesNotMatch(body.error.message, /sk-secret123456789/i);
});

test("createErrorResponse keeps normal public messages intact", async () => {
  const response = createErrorResponse({
    status: 409,
    message: "Conflict detected",
  });
  const body = (await response.json()) as { error: { message: string; type: string } };

  assert.equal(body.error.message, "Conflict detected");
  assert.equal(body.error.type, "conflict");
});
