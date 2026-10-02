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

test("native messages retain protocol, compressed bodies, status and selected host owner", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-native-transport-"));
  const mitm = path.join(root, "mitm");
  fs.mkdirSync(mitm);
  const model = "synthetic-claude-model";
  fs.writeFileSync(
    path.join(mitm, "targets.json"),
    JSON.stringify({
      targets: [
        { id: "kiro", hosts: ["api.anthropic.com"] },
        { id: "claude-code", hosts: ["api.anthropic.com"] },
      ],
    })
  );
  fs.writeFileSync(
    path.join(root, "db.json"),
    JSON.stringify({
      mitmAlias: { "claude-code": { [model]: model }, kiro: { [model]: "wrong-provider" } },
    })
  );
  const cert = path.join(mitm, "server.crt");
  const key = path.join(mitm, "server.key");
  const generated = spawnSync("openssl", [
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
  ]);
  assert.equal(generated.status, 0);
  fs.chmodSync(key, 0o600);
  const payload = {
    model,
    max_tokens: 16,
    stream: false,
    messages: [{ role: "user", content: "Synthetic test" }],
    system: [{ type: "text", text: "Synthetic system", cache_control: { type: "ephemeral" } }],
    tools: [
      {
        name: "synthetic_tool",
        description: "Fixture",
        input_schema: { type: "object", properties: {} },
      },
    ],
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    thread: { type: "create" },
    diagnostics: { previous_message_id: null },
  };
  let mode = "json";
  let heldResponse: http.ServerResponse | undefined;
  const received: { url?: string; headers: http.IncomingHttpHeaders; body: unknown }[] = [];
  const router = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(mode === "error" ? 429 : 200, {
      "content-type":
        mode === "sse" || mode === "held-sse" ? "text/event-stream" : "application/json",
      "request-id": "synthetic-id",
      "retry-after": "12",
    });
    if (mode === "held-sse") {
      heldResponse = res;
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      return;
    }
    res.end(
      mode === "sse"
        ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        : JSON.stringify({ type: mode === "error" ? "error" : "message" })
    );
  });
  const listen = (server: net.Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port))
    );
  const routerPort = await listen(router);
  t.after(() => new Promise<void>((resolve) => router.close(() => resolve())));
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const dnsFixture = path.join(root, "dns-fixture.cjs");
  fs.writeFileSync(
    dnsFixture,
    `
    const dns = require("node:dns");
    const resolve4 = dns.Resolver.prototype.resolve4;
    dns.Resolver.prototype.resolve4 = function(host, callback) {
      if (host === "missing-bridge-fixture.invalid") {
        return setImmediate(() => callback(Object.assign(new Error("synthetic DNS failure"), { code: "ENOTFOUND" })));
      }
      return resolve4.call(this, host, callback);
    };
  `
  );
  const child = spawn(process.execPath, [path.resolve("src/mitm/server.cjs")], {
    env: {
      ...process.env,
      DATA_DIR: root,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${dnsFixture}`,
      ROUTER_API_KEY: "synthetic-router-token",
      OMNIROUTE_BASE_URL: `http://127.0.0.1:${routerPort}`,
      MITM_LOCAL_PORT: String(port),
      MITM_LOCAL_HOST: "127.0.0.1",
      MITM_TARGET_AGENT: "claude-code",
      MITM_CERT_MODE: "legacy",
      MITM_DISABLE_TLS_VERIFY: "0",
      INSPECTOR_INTERNAL_INGEST_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    }
  });
  await new Promise<void>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error("Bridge did not start")), 10_000);
    child.stdout.on("data", (chunk) => {
      log += chunk;
      if (log.includes("MITM ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Bridge exited before ready"));
    });
  });
  for (const kind of [
    "json",
    "sse",
    "error",
    "gzip",
    "deflate",
    "br",
    ...(zlib.zstdCompressSync ? ["zstd"] : []),
  ]) {
    await t.test(kind, async () => {
      mode = kind === "sse" || kind === "error" ? kind : "json";
      payload.stream = mode === "sse";
      const encoders: Record<string, (input: Buffer) => Buffer> = {
        gzip: zlib.gzipSync,
        deflate: zlib.deflateSync,
        br: zlib.brotliCompressSync,
        zstd: zlib.zstdCompressSync,
      };
      const encoding = encoders[kind] ? kind : undefined;
      const bytes = Buffer.from(JSON.stringify(payload));
      const response = await new Promise<{
        status?: number;
        headers: http.IncomingHttpHeaders;
        body: string;
      }>((resolve, reject) => {
        const request = https.request(
          {
            hostname: "127.0.0.1",
            port,
            servername: "api.anthropic.com",
            ca: fs.readFileSync(cert),
            path: "/v1/messages?beta=true",
            method: "POST",
            headers: {
              host: "api.anthropic.com",
              authorization: "Bearer synthetic-native-token",
              "x-api-key": "synthetic-native-key",
              "anthropic-version": "2023-06-01",
              "anthropic-beta": "synthetic-beta",
              "x-session-id": "synthetic-session",
              ...(encoding ? { "content-encoding": encoding } : {}),
            },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
          }
        );
        request.on("error", reject);
        request.end(encoding ? encoders[kind](bytes) : bytes);
      });
      const forwarded = received.at(-1)!;
      assert.equal(forwarded.headers["x-omniroute-agent"], "claude-code");
      assert.equal(forwarded.url, "/v1/messages?beta=true");
      assert.equal(forwarded.headers.authorization, "Bearer synthetic-router-token");
      assert.equal(forwarded.headers["x-api-key"], undefined);
      assert.equal(forwarded.headers["content-encoding"], undefined);
      assert.equal(forwarded.headers["anthropic-beta"], "synthetic-beta");
      assert.equal(forwarded.headers["anthropic-version"], "2023-06-01");
      assert.equal(forwarded.headers["x-session-id"], "synthetic-session");
      assert.deepEqual(forwarded.body, payload);
      assert.equal(response.status, mode === "error" ? 429 : 200);
      assert.equal(response.headers["request-id"], "synthetic-id");
      assert.equal(
        response.headers["content-type"],
        mode === "sse" ? "text/event-stream" : "application/json"
      );
      if (mode === "error") assert.equal(response.headers["retry-after"], "12");
      if (mode === "sse") assert.match(response.body, /event: message_stop/);
      else assert.doesNotThrow(() => JSON.parse(response.body));
    });
  }
  await t.test(
    "a failed passthrough DNS lookup returns 502 without killing other sessions",
    async () => {
      mode = "held-sse";
      let streamStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        streamStarted = resolve;
      });
      const activeStream = new Promise<string>((resolve, reject) => {
        const request = https.request(
          {
            hostname: "127.0.0.1",
            port,
            servername: "api.anthropic.com",
            ca: fs.readFileSync(cert),
            method: "POST",
            path: "/v1/messages",
            headers: { host: "api.anthropic.com" },
            timeout: 5000,
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
              streamStarted();
            });
            res.on("end", () => resolve(body));
            res.on("error", reject);
          }
        );
        request.on("error", reject);
        request.on("timeout", () => request.destroy(new Error("Held stream timed out")));
        request.end(JSON.stringify({ ...payload, stream: true }));
      });
      // Avoid an unhandled rejection in the failing baseline, before the final assertion.
      void activeStream.catch(() => {});
      t.after(() => heldResponse?.end());
      await started;
      const response = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
        const request = https.get(
          {
            hostname: "127.0.0.1",
            port,
            servername: "api.anthropic.com",
            ca: fs.readFileSync(cert),
            path: "/fixture",
            headers: { host: "missing-bridge-fixture.invalid" },
            timeout: 3000,
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode, body }));
          }
        );
        request.on("timeout", () => request.destroy(new Error("DNS fixture request timed out")));
        request.on("error", reject);
      });
      assert.equal(response.status, 502);
      assert.equal(child.exitCode, null);
      heldResponse!.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      const completed = await activeStream;
      assert.match(completed, /event: message_start/);
      assert.match(completed, /event: message_stop/);
      assert.equal(JSON.parse(response.body).error.type, "mitm_error");
      assert.doesNotMatch(
        response.body,
        /ENOTFOUND|synthetic DNS failure|stack|missing-bridge-fixture/
      );
    }
  );
  await t.test("TLS health identifies the selected native transport", async () => {
    const health = await new Promise<string>((resolve, reject) => {
      const request = https.get(
        {
          hostname: "127.0.0.1",
          port,
          servername: "api.anthropic.com",
          ca: fs.readFileSync(cert),
          path: "/__omniroute_bridge_health",
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        }
      );
      request.on("error", reject);
    });
    assert.deepEqual(JSON.parse(health), {
      ok: true,
      transportVersion: 1,
      port,
      targetAgent: "claude-code",
    });
  });
});
