// Regression guard for #14853 — credentials flap must NOT auto-deactivate.
//
// Before this fix, writeTerminalStatus defaulted `isActive=false` for any
// terminal testStatus (banned/expired/deactivated/credits_exhausted). That
// permanently sidelined accounts on temporary unpaid / ban-looking flaps, so
// an operator could not pick them back up after a billing renew without a
// dashboard re-enable. The fix: never flip is_active unless the caller passes
// isActive explicitly (gated behind autoDisableBannedAccounts for true bans).
//
// RED before fix: `credits_exhausted` / `banned` without explicit isActive set
// is_active=0. GREEN after fix: is_active stays 1, testStatus still recorded.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-creds-flap-"));
process.env.DATA_DIR = DIR;
const core = await import("../../src/lib/db/core.ts");
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const { writeTerminalStatus } = await import("../../src/shared/utils/terminalStatus.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function row(id: string): { is_active: number; test_status: string } {
  const result = core
    .getDbInstance()
    .prepare("SELECT is_active, test_status FROM provider_connections WHERE id=?")
    .get(id);
  assert.ok(result && typeof result === "object");
  return result as { is_active: number; test_status: string };
}

async function makeConn(name: string): Promise<string> {
  const conn = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name,
    apiKey: `sk-${name}`,
    isActive: true,
    testStatus: "active",
  });
  return String(conn.id);
}

test("credits_exhausted without explicit isActive keeps is_active=1 (unpaid→renew recovers)", async () => {
  const id = await makeConn("flap-credits");
  await writeTerminalStatus(
    id,
    {
      testStatus: "credits_exhausted",
      lastError: "insufficient_quota",
      errorCode: "402",
      lastErrorType: "QUOTA_EXHAUSTED",
    },
    "production"
  );
  const r = row(id);
  assert.equal(r.is_active, 1, "credits_exhausted must NOT auto-deactivate");
  assert.equal(r.test_status, "credits_exhausted", "testStatus still recorded for skip + alert");
});

test("banned without explicit isActive records testStatus but keeps is_active=1", async () => {
  const id = await makeConn("flap-banned");
  await writeTerminalStatus(
    id,
    {
      testStatus: "banned",
      lastError: "real 403",
      errorCode: "403",
      lastErrorType: "FORBIDDEN",
    },
    "production"
  );
  const r = row(id);
  assert.equal(r.is_active, 1, "ban-looking flap must NOT ungated-deactivate");
  assert.equal(r.test_status, "banned");
});

test("explicit isActive=false still deactivates (gated auto-disable path is honored)", async () => {
  const id = await makeConn("flap-explicit");
  await writeTerminalStatus(
    id,
    {
      testStatus: "deactivated",
      isActive: false,
      lastError: "account closed",
      errorCode: "403",
      lastErrorType: "ACCOUNT_DEACTIVATED",
    },
    "production"
  );
  const r = row(id);
  assert.equal(r.is_active, 0, "explicit isActive=false must still deactivate");
  assert.equal(r.test_status, "deactivated");
});
