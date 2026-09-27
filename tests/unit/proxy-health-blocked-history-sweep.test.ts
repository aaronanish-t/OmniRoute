/**
 * Blocked-verdict history: functional sweep part (refused egress 3 sweeps).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-blocked-history-sweep-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";
process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES = "true";
process.env.PROXY_HEALTH_TEST_STAGGER_MS = "0";
delete process.env.PROXY_AUTO_REMOVE;
delete process.env.PROXY_AUTO_DISABLE;
delete process.env.PROXY_HEALTH_BLOCKED_RESETS_STREAK;

const target = http.createServer((_req, res) => {
  res.writeHead(403);
  res.end();
});
await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
const targetPort = (target.address() as net.AddressInfo).port;
process.env.PROXY_HEALTH_TEST_URL = `http://127.0.0.1:${targetPort}/probe`;

const history = await import("../../src/lib/proxyHealth/blockedHistory.ts");
const { getBlockedHistory, deleteBlockedHistory, clearBlockedHistoryForTesting } = history;

const core = await import("../../src/lib/db/core.ts");
const proxiesDb = await import("../../src/lib/db/proxies.ts");
const scheduler = await import("../../src/lib/proxyHealth/scheduler.ts");
const verdicts = await import("../../src/lib/proxyHealth/sweepVerdict.ts");

test.after(async () => {
  delete process.env.PROXY_HEALTH_BLOCKED_RESETS_STREAK;
  await new Promise<void>((resolve) => target.close(() => resolve()));
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const tunnelSockets = new Set<net.Socket>();

function startRelay(port: number): Promise<http.Server> {
  const relay = http.createServer((req, res) => {
    const upstream = http.request(
      { host: "127.0.0.1", port: targetPort, method: req.method, path: "/probe" },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502);
        answer.pipe(res);
      }
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  relay.on("connect", (_req, client, head) => {
    tunnelSockets.add(client as net.Socket);
    const socket = net.connect(targetPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.write(head);
      socket.pipe(client);
      client.pipe(socket);
    });
    tunnelSockets.add(socket);
    socket.on("error", () => client.destroy());
    client.on("error", () => socket.destroy());
  });
  return new Promise((resolve) => relay.listen(port, "127.0.0.1", () => resolve(relay)));
}

function stopRelay(relay: http.Server): Promise<void> {
  for (const socket of tunnelSockets) socket.destroy();
  tunnelSockets.clear();
  relay.closeAllConnections();
  return new Promise((resolve) => relay.close(() => resolve()));
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function threeRefusedSweeps(): Promise<{
  proxyId: string;
  status: string | undefined;
}> {
  const port = await freePort();
  const created = await proxiesDb.createProxy({
    name: `refused ${port}`,
    type: "http",
    host: "127.0.0.1",
    port,
  });
  const relay = await startRelay(port);
  try {
    await scheduler.forceProxyHealthSweep();
    await scheduler.forceProxyHealthSweep();
    await scheduler.forceProxyHealthSweep();
  } finally {
    await stopRelay(relay);
  }
  const row = await proxiesDb.getProxyById(created!.id, { includeSecrets: false });
  return { proxyId: created!.id, status: (row as { status?: string } | null)?.status };
}

for (const flag of ["off", "on"] as const) {
  test(`functional (opt-in ${flag}): refused egress 3 sweeps running, history readable, selection unchanged`, async () => {
    clearBlockedHistoryForTesting();
    verdicts.clearSweepVerdicts();
    if (flag === "on") process.env.PROXY_HEALTH_BLOCKED_RESETS_STREAK = "true";
    else delete process.env.PROXY_HEALTH_BLOCKED_RESETS_STREAK;
    const { proxyId, status } = await threeRefusedSweeps();
    try {
      const entry = getBlockedHistory(proxyId);
      assert.equal(entry?.count, 3);
      assert.equal(entry?.lastCause, "unproven");
      assert.equal(entry?.lastStatus, 403);
      // Selection neutrality: a refused relay never flips the operator status.
      assert.notEqual(status, "dead");
      assert.equal(verdicts.getSweepVerdict(proxyId)?.verdict, "blocked");
    } finally {
      delete process.env.PROXY_HEALTH_BLOCKED_RESETS_STREAK;
      await proxiesDb.deleteProxyById(proxyId, { force: true });
      deleteBlockedHistory(proxyId);
      verdicts.clearSweepVerdicts();
    }
  });
}
