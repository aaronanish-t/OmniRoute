import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";

test("native Bridge survives concurrency, cancellation and broken upstream responses", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-resilience-"));
  const dir = path.join(root, "mitm");
  fs.mkdirSync(dir);
  const model = "synthetic-model";
  fs.writeFileSync(
    path.join(dir, "targets.json"),
    JSON.stringify({ targets: [{ id: "claude-code", hosts: ["api.anthropic.com"] }] })
  );
  fs.writeFileSync(
    path.join(root, "db.json"),
    JSON.stringify({ mitmAlias: { "claude-code": { [model]: model } } })
  );
  const cert = path.join(dir, "server.crt");
  const key = path.join(dir, "server.key");
  assert.equal(
    spawnSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=api.anthropic.com",
      "-addext",
      "subjectAltName=DNS:api.anthropic.com",
    ]).status,
    0
  );
  fs.chmodSync(key, 0o600);
  const ca = fs.readFileSync(cert);
  const sockets = new Set<net.Socket>();
  let routedCancellation = false;
  let passthroughCancellation = false;
  const bytePayload = Buffer.from([0x00, 0x61, 0xff, 0xf0, 0x9f, 0x92]);
  const router = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const mode = body.messages[0].content;
    if (req.url === "/v1/messages/count_tokens?beta=true") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 123 }));
      return;
    }
    if (mode === "cancel") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {}\n\n");
      res.once("close", () => {
        routedCancellation = true;
      });
      return;
    }
    if (mode === "reset") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {}\n\n");
      setTimeout(() => res.destroy(), 30);
      return;
    }
    if (mode === "binary") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(bytePayload);
      return;
    }
    if (mode === "compressed-response") {
      const data = zlib.gzipSync(Buffer.from(JSON.stringify({ marker: "বাংলা সংরক্ষিত" })));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(data.length),
      });
      res.end(data);
      return;
    }
    if (mode.startsWith("status:")) {
      const status = Number(mode.split(":")[1]);
      res.writeHead(status, {
        "content-type": "application/json",
        "retry-after": "3",
        "request-id": "synthetic-id",
      });
      res.end(JSON.stringify({ error: { type: "synthetic_provider_error" } }));
      return;
    }
    if (mode === "large") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < 64; i++) res.write("x".repeat(32768));
      res.end("COMPLETE");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: message_start\ndata: ${JSON.stringify({ marker: mode })}\n\n`);
    setTimeout(
      () => res.end(`event: message_stop\ndata: ${JSON.stringify({ marker: mode })}\n\n`),
      10
    );
  });
  const native = https.createServer({ key: fs.readFileSync(key), cert: ca }, (req, res) => {
    if (req.url === "/cancel") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("native fixture open\n");
      res.once("close", () => {
        passthroughCancellation = true;
      });
      return;
    }
    if (req.url === "/reset") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("native fixture partial\n");
      setTimeout(() => res.destroy(), 30);
      return;
    }
    res.end(JSON.stringify({ authorization: req.headers.authorization, url: req.url }));
  });
  const listen = (server: net.Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port))
    );
  for (const server of [router, native])
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
  const routerPort = await listen(router);
  const nativePort = await listen(native);
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const preload = path.join(root, "fixture.cjs");
  fs.writeFileSync(
    preload,
    `
    const dns = require("node:dns");
    const originalResolve = dns.Resolver.prototype.resolve4;
    dns.Resolver.prototype.resolve4 = function(host, cb) {
      if (host === "api.anthropic.com") return setImmediate(() => cb(null, ["203.0.113.9"]));
      return originalResolve.call(this, host, cb);
    };
    const https = require("node:https");
    const request = https.request;
    https.request = function(options, ...rest) {
      if (options.hostname === "203.0.113.9") options = {...options, hostname: "127.0.0.1", port: ${nativePort}};
      return request.call(this, options, ...rest);
    };
  `
  );
  const child = spawn(process.execPath, [path.resolve("src/mitm/server.cjs")], {
    env: {
      ...process.env,
      DATA_DIR: root,
      NODE_OPTIONS: `--require=${preload}`,
      NODE_EXTRA_CA_CERTS: cert,
      MITM_CERT_MODE: "legacy",
      MITM_TARGET_AGENT: "claude-code",
      MITM_LOCAL_HOST: "127.0.0.1",
      MITM_LOCAL_PORT: String(port),
      OMNIROUTE_BASE_URL: `http://127.0.0.1:${routerPort}`,
      ROUTER_API_KEY: "synthetic-token",
      MITM_DISABLE_TLS_VERIFY: "0",
      INSPECTOR_INTERNAL_INGEST_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exit;
    }
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [router, native].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve()))
      )
    );
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture Bridge not ready")), 10000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("MITM ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(stderr));
    });
  });
  const request = (mode: string, pathname = "/v1/messages", abort = false) =>
    new Promise<{
      status?: number;
      body: Buffer;
      aborted: boolean;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port,
          servername: "api.anthropic.com",
          ca,
          path: pathname,
          method: pathname.startsWith("/v1/messages") ? "POST" : "GET",
          headers: { host: "api.anthropic.com", authorization: "Bearer native-fixture-token" },
          timeout: 5000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let settled = false;
          const finish = (aborted: boolean) => {
            if (!settled) {
              settled = true;
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks),
                aborted,
              });
            }
          };
          res.on("data", (chunk) => {
            chunks.push(chunk);
            if (abort) {
              res.destroy();
              req.destroy();
              finish(true);
            }
          });
          res.on("end", () => finish(false));
          res.on("error", () => finish(true));
          res.on("aborted", () => finish(true));
        }
      );
      req.on("timeout", () => req.destroy(new Error("Fixture request timeout")));
      req.on("error", reject);
      req.end(
        pathname.startsWith("/v1/messages")
          ? JSON.stringify({
              model,
              max_tokens: 32,
              stream: true,
              messages: [{ role: "user", content: mode }],
            })
          : undefined
      );
    });
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 30; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(predicate());
  };
  await t.test("24 concurrent streams finish with their own correlation marker", async () => {
    const responses = await Promise.all(
      Array.from({ length: 24 }, (_, i) => request(`stream-${i}`))
    );
    responses.forEach((res, i) => {
      assert.equal(res.status, 200);
      assert.equal(res.aborted, false);
      assert.match(res.body.toString(), /event: message_stop/);
      assert.match(res.body.toString(), new RegExp(`\"marker\":\"stream-${i}\"`));
    });
  });
  await t.test("native token counting keeps its own endpoint and query", async () => {
    const res = await request("token-count", "/v1/messages/count_tokens?beta=true");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body.toString()), { input_tokens: 123 });
  });
  await t.test("upstream error statuses and retry metadata survive", async () => {
    for (const status of [400, 401, 403, 429, 500, 502, 503, 529]) {
      const res = await request(`status:${status}`);
      assert.equal(res.status, status);
      assert.equal(res.headers["retry-after"], "3");
      assert.equal(JSON.parse(res.body.toString()).error.type, "synthetic_provider_error");
    }
  });
  await t.test("large response completes without truncation", async () => {
    const res = await request("large");
    assert.equal(res.body.length, 64 * 32768 + 8);
    assert.ok(res.body.toString().endsWith("COMPLETE"));
  });
  await t.test(
    "compressed response retains decoded data and drops stale compression headers",
    async () => {
      const res = await request("compressed-response");
      assert.deepEqual(JSON.parse(res.body.toString()), { marker: "বাংলা সংরক্ষিত" });
      assert.equal(res.headers["content-encoding"], undefined);
    }
  );
  await t.test("upstream bytes are forwarded without lossy UTF-8 conversion", async () => {
    assert.deepEqual((await request("binary")).body, bytePayload);
  });
  await t.test("routed client cancellation closes its upstream request", async () => {
    await request("cancel", "/v1/messages", true);
    await waitFor(() => routedCancellation);
  });
  await t.test("broken routed stream is aborted without appending foreign JSON", async () => {
    const res = await request("reset");
    assert.equal(res.aborted, true);
    assert.doesNotMatch(res.body.toString(), /mitm_error/);
    assert.equal(child.exitCode, null);
  });
  await t.test("passthrough preserves original native authentication and query", async () => {
    const res = await request("", "/auth?native=true");
    assert.deepEqual(JSON.parse(res.body.toString()), {
      authorization: "Bearer native-fixture-token",
      url: "/auth?native=true",
    });
  });
  await t.test("passthrough client cancellation closes its upstream request", async () => {
    await request("", "/cancel", true);
    await waitFor(() => passthroughCancellation);
  });
  await t.test("broken passthrough stream cannot kill the Bridge", async () => {
    const res = await request("", "/reset");
    assert.equal(res.aborted, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(child.exitCode, null, stderr);
  });
});
