// With PII response sanitization off (the default, Hard Rule #20) the log-payload PII
// walk still deep-copied every payload and resolved the flag from SQLite once per string. On the
// pending-request preview path that was ~32% of the router's main thread at peak. The walk must
// be skipped entirely when the flag is off, without changing what gets logged.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pii-walk-"));
process.env.DATA_DIR = tmpDir;

const core = await import("../../src/lib/db/core.ts");
const { protectPayloadForLog, sanitizePayloadPII } = await import("../../src/lib/logPayloads.ts");
const { setFeatureFlagOverride, removeFeatureFlagOverride } =
  await import("../../src/lib/db/featureFlags.ts");

const PII_FLAG = "PII_RESPONSE_SANITIZATION";
const savedEnv = process.env[PII_FLAG];

function withPiiEnv(value: string | undefined, fn: () => void) {
  if (value === undefined) delete process.env[PII_FLAG];
  else process.env[PII_FLAG] = value;
  try {
    fn();
  } finally {
    if (savedEnv === undefined) delete process.env[PII_FLAG];
    else process.env[PII_FLAG] = savedEnv;
  }
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("sanitizePayloadPII returns the payload itself when PII sanitization is off", () => {
  withPiiEnv(undefined, () => {
    const payload = { input: [{ content: "reach me at jane@example.com" }], n: 1 };
    assert.equal(sanitizePayloadPII(payload), payload);
  });
});

test("protectPayloadForLog output is unchanged when PII sanitization is off", () => {
  withPiiEnv(undefined, () => {
    const payload = {
      authorization: "Bearer secret-token-value",
      headers: { "x-api-key": "sk-live-secret" },
      token: "opaque-token",
      note: "Bearer another-secret",
      binary: new Uint8Array(3),
      reasoning: { effort: "high", encrypted_content: "E".repeat(40) },
      input: [{ role: "user", content: "reach me at jane@example.com" }],
    };
    assert.deepEqual(protectPayloadForLog(payload), {
      authorization: "[REDACTED]",
      headers: { "x-api-key": "[REDACTED]" },
      token: "[REDACTED]",
      note: "Bearer [REDACTED]",
      binary: "[binary 3 bytes]",
      reasoning: { effort: "high", encrypted_content: "[omitted: encrypted reasoning, 40 chars]" },
      input: [{ role: "user", content: "reach me at jane@example.com" }],
    });
  });
});

test("sanitizePayloadPII still redacts nested strings when enabled through the env", () => {
  withPiiEnv("true", () => {
    const payload = { input: [{ content: "reach me at jane@example.com" }] };
    const sanitized = sanitizePayloadPII(payload);
    assert.notEqual(sanitized, payload);
    assert.ok(!JSON.stringify(sanitized).includes("jane@example.com"));
  });
});

test("sanitizePayloadPII honours a DB override of the flag", () => {
  withPiiEnv(undefined, () => {
    const payload = { input: [{ content: "reach me at jane@example.com" }] };
    setFeatureFlagOverride(PII_FLAG, "true");
    try {
      assert.ok(!JSON.stringify(sanitizePayloadPII(payload)).includes("jane@example.com"));
    } finally {
      removeFeatureFlagOverride(PII_FLAG);
    }
    assert.equal(sanitizePayloadPII(payload), payload);
  });
});
