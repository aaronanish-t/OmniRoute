import test from "node:test";
import assert from "node:assert/strict";

import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";
import { syncFromHealth } from "../../open-sse/executors/opencodeAccountScope.ts";

const log = { debug() {}, info() {}, warn() {}, error() {} };
const BLOCKED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIRECT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("accounts whose required proxy is unavailable are omitted while unconfigured accounts remain direct", () => {
  const accounts = syncFromHealth(new Map(), {
    providerSpecificData: {
      fingerprints: [BLOCKED, DIRECT],
      accountProxies: [
        { fingerprint: BLOCKED, proxy: null, proxyUnavailable: true },
        { fingerprint: DIRECT, proxy: null },
      ],
    },
  } as never);

  assert.deepEqual(
    accounts.map((account) => ({ fingerprint: account.fingerprint, proxy: account.proxy })),
    [{ fingerprint: DIRECT, proxy: null }]
  );
});

test("an unresolved required binding cannot become the synthetic direct account", () => {
  const accounts = syncFromHealth(new Map(), {
    providerSpecificData: {
      accountProxies: [{ fingerprint: BLOCKED, proxy: null, proxyUnavailable: true }],
    },
  } as never);

  assert.deepEqual(accounts, []);
});

test("all accounts blocked by required proxies return 503 without an upstream fetch", async () => {
  const exec = new OpencodeExecutor("opencode-zen");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  try {
    const result = await exec.execute({
      model: "deepseek-v4-flash-free",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      signal: null,
      credentials: {
        connectionId: "fixture-connection",
        providerSpecificData: {
          fingerprints: [BLOCKED],
          accountProxies: [{ fingerprint: BLOCKED, proxy: null, proxyUnavailable: true }],
        },
      } as never,
      log,
    });
    assert.equal((result as { response: Response }).response.status, 503);
    const body = (await (result as { response: Response }).response.json()) as {
      error?: { code?: string };
    };
    assert.equal(body.error?.code, "proxy_unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 0, "required-proxy failure must not dispatch direct");
});

test("an account with no proxy configured preserves direct dispatch", async () => {
  const exec = new OpencodeExecutor("opencode-zen");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  try {
    const result = await exec.execute({
      model: "deepseek-v4-flash-free",
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      signal: null,
      credentials: {
        connectionId: "fixture-connection",
        providerSpecificData: { fingerprints: [DIRECT] },
      } as never,
      log,
    });
    assert.equal((result as { response: Response }).response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 1);
});
