import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-bundle-lifecycle-"));

const first = await import(new URL("../../src/mitm/manager.ts?bundle=first", import.meta.url).href);
const second = await import(
  new URL("../../src/mitm/manager.ts?bundle=second", import.meta.url).href
);

test("separate runtime bundles share the live Bridge child and reject a duplicate start", async () => {
  const proc = Object.assign(new EventEmitter(), { killed: false, pid: process.pid });
  first.__setServerProcessForTest(proc as ChildProcess, process.pid);
  try {
    const status = await second.getMitmStatus();
    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
    await assert.rejects(second.startMitm("fixture-key", ""), /already running/);
  } finally {
    first.__setServerProcessForTest(null, null);
    second.__setServerProcessForTest(null, null);
  }
});

test("separate runtime bundles share the start lock before DNS or spawn side effects", () => {
  first.releaseMitmStartLock();
  second.releaseMitmStartLock();
  try {
    assert.equal(first.tryAcquireMitmStartLock(), true);
    assert.equal(second.tryAcquireMitmStartLock(), false);
  } finally {
    first.releaseMitmStartLock();
    second.releaseMitmStartLock();
  }
});

test("an exited older child cannot clear a newer child or unlink its PID file", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { releaseExitedBridgeChild } = await import("../../src/mitm/processLifecycle.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pid-ownership-"));
  const file = path.join(dir, ".mitm.pid");
  const oldChild = { pid: 101 } as ChildProcess;
  const liveChild = { pid: 202 } as ChildProcess;
  const state = {
    serverProcess: liveChild,
    serverPid: 202,
    starting: false,
    stopping: false,
    cleanupInstalled: false,
  };
  fs.writeFileSync(file, "202");
  releaseExitedBridgeChild(state, oldChild, file);
  assert.equal(state.serverProcess, liveChild);
  assert.equal(state.serverPid, 202);
  assert.equal(fs.readFileSync(file, "utf8"), "202");
  releaseExitedBridgeChild(state, liveChild, file);
  assert.equal(state.serverProcess, null);
  assert.equal(state.serverPid, null);
  assert.equal(fs.existsSync(file), false);
});

test("an unrelated live PID cannot block recovery or be killed by Stop", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { resolveMitmDataDir } = await import("../../src/mitm/dataDir.ts");
  const file = path.join(resolveMitmDataDir(), "mitm", ".mitm.pid");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(process.pid));
  first.__setServerProcessForTest(null, null);
  try {
    const status = await first.getMitmStatus();
    assert.equal(status.running, false);
    assert.equal(fs.existsSync(file), false);
    assert.equal(process.kill(process.pid, 0), true);
    assert.equal(first.tryAcquireMitmStartLock(), true);
  } finally {
    first.releaseMitmStartLock();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

test("a Stop in one runtime bundle blocks Start in another until teardown completes", async () => {
  const { getBridgeProcessState } = await import("../../src/mitm/processLifecycle.ts");
  const state = getBridgeProcessState();
  state.stopping = true;
  try {
    await assert.rejects(second.startMitm("fixture-key", ""), /already stopping/);
  } finally {
    state.stopping = false;
  }
});

test("a living child without a ready listener cannot pass startup", async () => {
  const { waitForBridgeReady } = await import("../../src/mitm/processLifecycle.ts");
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  assert.equal(await waitForBridgeReady(child as unknown as ChildProcess, 8443, 20), false);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
});

test("readiness requires the selected listener and accepts split stdout chunks", async () => {
  const { waitForBridgeReady } = await import("../../src/mitm/processLifecycle.ts");
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  const ready = waitForBridgeReady(child as unknown as ChildProcess, 8443, 100);
  child.stdout.emit("data", Buffer.from("MITM ready on :443\nMITM rea"));
  child.stdout.emit("data", Buffer.from("dy on :8443 → synthetic"));
  assert.equal(await ready, true);
  assert.equal(child.stdout.listenerCount("data"), 0);
});

test("shutdown escalates despite killed=true until actual child exit", async () => {
  const { terminateBridgeChild } = await import("../../src/mitm/processLifecycle.ts");
  const signals: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    killed: false,
    exitCode: null,
    signalCode: null,
    kill(signal: string) {
      this.killed = true;
      signals.push(signal);
      return true;
    },
  });
  await terminateBridgeChild(child as unknown as ChildProcess, 20);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.listenerCount("exit"), 0);
});

test("shutdown waits for actual exit and avoids unnecessary force kill", async () => {
  const { terminateBridgeChild } = await import("../../src/mitm/processLifecycle.ts");
  const signals: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    killed: false,
    exitCode: null as number | null,
    signalCode: null,
    kill(signal: string) {
      this.killed = true;
      signals.push(signal);
      setTimeout(() => {
        this.exitCode = 0;
        this.emit("exit", 0);
      }, 5);
      return true;
    },
  });
  await terminateBridgeChild(child as unknown as ChildProcess, 100);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("owned process command requires the exact node and Bridge script", async () => {
  const { isOwnedBridgeCommand, isOwnedBridgePid } =
    await import("../../src/mitm/processLifecycle.ts");
  const script = path.join(os.tmpdir(), "synthetic runtime", "src/mitm/server.cjs");
  assert.equal(isOwnedBridgeCommand(`${process.execPath} ${script}`, script), true);
  assert.equal(isOwnedBridgeCommand(`\"${process.execPath}\" \"${script}\"`, script), true);
  assert.equal(isOwnedBridgeCommand(`${process.execPath} ${script}.other`, script), false);
  assert.equal(isOwnedBridgeCommand(`${process.execPath} --eval \"${script}\"`, script), false);
  assert.equal(isOwnedBridgePid(process.pid, script), false);
});
