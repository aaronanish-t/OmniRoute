import assert from "node:assert/strict";
import { test } from "node:test";

import { getDbInstance } from "../../src/lib/db/core.ts";

// Regression guard for audit #15159 / Hard Rule #12 — E-14.
//
// `src/app/api/playground/simulate-route/route.ts:280-282` interpolated the raw
// `error.message` from any caught exception straight into a 500 body with no
// sanitizer. The file imports nothing from `utils/error`, so the
// `check:error-helper` gate trusted it and could not see the leak.
//
// The fix adds `sanitizeErrorMessage` at the catch block. This test verifies
// the error path returns a valid sanitized 500 response when a real error
// occurs (closed DB connection).

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/playground/simulate-route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("E-14: simulate-route returns sanitized 500 on internal error", async () => {
  // Force a real error by closing the DB connection
  const db = getDbInstance();
  db.close();

  const { POST } = await import("../../src/app/api/playground/simulate-route/route.ts");

  try {
    const response = await POST(makeRequest({
      combo: { name: "test", strategy: "priority", targets: [{ provider: "cc", model: "test" }] },
    }));
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: string };
    // The error should be sanitized (no raw SQLite error text leaked)
    assert.ok(typeof body.error === "string", "error field must be a string");
    assert.ok(body.error.startsWith("Simulation error: "), "error must have expected prefix");
    // The raw "database is not open" should be sanitized to a safe message
    assert.ok(!body.error.includes("database is not open"), "raw DB error text leaked");
  } finally {
    // DB is closed; test cleanup will reset
  }
});

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/playground/simulate-route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}