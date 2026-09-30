// #15070 — a typed connection name that matches an existing cookie connection with a DIFFERENT
// credential should be rejected (ProviderConnectionNameConflictError), not silently overwritten.
// Same name + same credential must still update in place (the normal rotation case).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-name-conflict-15070-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");

async function resetStorage() {
  core.resetDbInstance();
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (fs.existsSync(TEST_DATA_DIR)) {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      break;
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      if ((code === "EBUSY" || code === "EPERM") && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      } else {
        throw error;
      }
    }
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ─── (a) cookie: same name + different cookie → reject ───────────────────────
test("#15070 (a) cookie: same name + different cookie → rejects with ProviderConnectionNameConflictError", async () => {
  // Insert first connection.
  await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "work",
    apiKey: null,
    providerSpecificData: { cookie: "sso=ACCOUNT_A_COOKIE" },
    isActive: true,
  });

  // Attempt to add a second connection with the same name but a different cookie.
  await assert.rejects(
    () =>
      providersDb.createProviderConnection({
        provider: "grok-web",
        authType: "cookie",
        name: "work",
        apiKey: null,
        providerSpecificData: { cookie: "sso=ACCOUNT_B_COOKIE" },
        isActive: true,
        rejectNameConflict: true,
      }),
    providersDb.ProviderConnectionNameConflictError,
    "should throw ProviderConnectionNameConflictError"
  );

  // The original row must be untouched.
  const conns = await providersDb.getProviderConnections({ provider: "grok-web" });
  assert.equal(conns.length, 1, "row count must stay 1");
  const psd = conns[0].providerSpecificData as Record<string, unknown> | null;
  assert.equal(psd?.cookie, "sso=ACCOUNT_A_COOKIE", "original cookie must be preserved");
});

// ─── (b) cookie: same name + same cookie → updates in place ──────────────────
test("#15070 (b) cookie: same name + same cookie → resolves, same id, count 1", async () => {
  const first = await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "work",
    apiKey: null,
    providerSpecificData: { cookie: "sso=SAME_COOKIE" },
    isActive: true,
  });

  const second = await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "work",
    apiKey: null,
    providerSpecificData: { cookie: "sso=SAME_COOKIE" },
    isActive: true,
    rejectNameConflict: true,
  });

  assert.ok(second, "should resolve successfully");
  assert.equal(second!.id, first!.id, "must update the same row");
  assert.equal(
    "rejectNameConflict" in second!,
    false,
    "the opt-in flag must not leak into the row"
  );
  const conns = await providersDb.getProviderConnections({ provider: "grok-web" });
  assert.equal(conns.length, 1, "must stay at 1 row");
});

// ─── (c) cookie: different name + same cookie → dedup (#3368 regression) ─────
test("#15070 (c) cookie: different name + same cookie → dedupes to existing row", async () => {
  const first = await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "Account A",
    apiKey: null,
    providerSpecificData: { cookie: "sso=SHARED_COOKIE" },
    isActive: true,
  });

  const second = await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "Account B (same cookie)",
    apiKey: null,
    providerSpecificData: { cookie: "sso=SHARED_COOKIE" },
    isActive: true,
    rejectNameConflict: true,
  });

  assert.ok(second, "should resolve successfully");
  assert.equal(second!.id, first!.id, "must dedup to the existing row");
  const conns = await providersDb.getProviderConnections({ provider: "grok-web" });
  assert.equal(conns.length, 1, "must be 1 row after dedup");
});

// ─── (d) apikey on a web-session provider: same name + different key → reject ─
test("#15070 (d) apikey on web-session provider: same name + different apiKey → rejects, original preserved", async () => {
  // grok-web requires a web session credential. Using authType: "apikey" because
  // the single-add dashboard modal always sends authType "apikey" (per issue notes).
  const first = await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "apikey",
    name: "work",
    apiKey: "sso=ORIGINAL_KEY",
    isActive: true,
  });

  await assert.rejects(
    () =>
      providersDb.createProviderConnection({
        provider: "grok-web",
        authType: "apikey",
        name: "work",
        apiKey: "sso=DIFFERENT_KEY",
        isActive: true,
        rejectNameConflict: true,
      }),
    providersDb.ProviderConnectionNameConflictError,
    "should throw ProviderConnectionNameConflictError"
  );

  // The original apiKey must still be intact.
  const conns = await providersDb.getProviderConnections({ provider: "grok-web" });
  assert.equal(conns.length, 1, "row count must stay 1");
  assert.equal(conns[0].id, first!.id, "original row id must be preserved");
  assert.equal(conns[0].apiKey, "sso=ORIGINAL_KEY", "original apiKey must be preserved");
});

// ─── (e) apikey: same name + same apiKey → updates in place ──────────────────
test("#15070 (e) apikey: same name + same apiKey → updates in place, count 1", async () => {
  const first = await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "apikey",
    name: "work",
    apiKey: "sso=SAME_KEY",
    isActive: true,
  });

  const second = await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "apikey",
    name: "work",
    apiKey: "sso=SAME_KEY",
    isActive: true,
    rejectNameConflict: true,
  });

  assert.ok(second, "should resolve");
  assert.equal(second!.id, first!.id, "must be the same row");
  const conns = await providersDb.getProviderConnections({ provider: "grok-web" });
  assert.equal(conns.length, 1, "count must remain 1");
});

// ─── (f) without the flag — same name + different cookie still upserts ────────
test("#15070 (f) default behavior (rejectNameConflict absent): same name + different cookie still upserts", async () => {
  await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "work",
    apiKey: null,
    providerSpecificData: { cookie: "sso=FIRST_COOKIE" },
    isActive: true,
  });

  // No flag — should NOT throw, should silently overwrite (legacy behavior).
  const second = await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "work",
    apiKey: null,
    providerSpecificData: { cookie: "sso=SECOND_COOKIE" },
    isActive: true,
    // rejectNameConflict intentionally absent
  });

  assert.ok(second, "should resolve without throwing");
  const conns = await providersDb.getProviderConnections({ provider: "grok-web" });
  assert.equal(conns.length, 1, "must still be 1 row (upserted, not inserted)");
});

// ─── (g) the name of A with the credential of B → reject, both rows intact ───
test("#15070 (g) cookie: A's name with B's cookie → rejects, both rows unchanged", async () => {
  await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "work",
    apiKey: null,
    providerSpecificData: { cookie: "sso=ACCOUNT_A_COOKIE" },
    isActive: true,
  });
  await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "home",
    apiKey: null,
    providerSpecificData: { cookie: "sso=ACCOUNT_B_COOKIE" },
    isActive: true,
  });

  await assert.rejects(
    () =>
      providersDb.createProviderConnection({
        provider: "grok-web",
        authType: "cookie",
        name: "work",
        apiKey: null,
        providerSpecificData: { cookie: "sso=ACCOUNT_B_COOKIE" },
        isActive: true,
        rejectNameConflict: true,
      }),
    providersDb.ProviderConnectionNameConflictError
  );

  const conns = await providersDb.getProviderConnections({ provider: "grok-web" });
  const byName = new Map(
    conns.map((c) => [c.name, (c.providerSpecificData as Record<string, unknown> | null)?.cookie])
  );
  assert.equal(byName.get("work"), "sso=ACCOUNT_A_COOKIE", "A keeps its cookie");
  assert.equal(byName.get("home"), "sso=ACCOUNT_B_COOKIE", "B keeps its cookie");
});

// ─── (h) stored row without a credential → nothing to compare, update in place ─
test("#15070 (h) cookie: stored row without a credential still updates in place", async () => {
  const first = await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "work",
    apiKey: null,
    providerSpecificData: {},
    isActive: true,
  });

  const second = await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    name: "work",
    apiKey: null,
    providerSpecificData: { cookie: "sso=NEW_COOKIE" },
    isActive: true,
    rejectNameConflict: true,
  });

  assert.equal(second!.id, first!.id, "must update the same row");
  const conns = await providersDb.getProviderConnections({ provider: "grok-web" });
  assert.equal(conns.length, 1);
});
