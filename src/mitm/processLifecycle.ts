import fs from "node:fs";
import { execFileSync, type ChildProcess } from "node:child_process";

export type BridgeProcessState = {
  serverProcess: ChildProcess | null;
  serverPid: number | null;
  starting: boolean;
  stopping: boolean;
  cleanupInstalled: boolean;
};

const key = Symbol.for("omniroute.mitm.process-lifecycle.v1");

/** Route bundles and instrumentation must share the same child and start lock. */
export function getBridgeProcessState(): BridgeProcessState {
  const registry = globalThis as typeof globalThis & { [key]?: BridgeProcessState };
  return (registry[key] ??= {
    serverProcess: null,
    serverPid: null,
    starting: false,
    stopping: false,
    cleanupInstalled: false,
  });
}

/** An old or failed child cannot remove a newer listener's PID record. */
export function removeOwnedBridgePid(file: string, pid: number | undefined | null): void {
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) return;
  try {
    if (fs.readFileSync(file, "utf8").trim() === String(pid)) fs.unlinkSync(file);
  } catch {
    // A missing record requires no cleanup.
  }
}

export function releaseExitedBridgeChild(
  state: BridgeProcessState,
  child: ChildProcess,
  file: string
): void {
  if (state.serverProcess === child) {
    state.serverProcess = null;
    state.serverPid = null;
  }
  removeOwnedBridgePid(file, child.pid);
}

/** Survival alone is not readiness: the child must confirm its bound listener. */
export function waitForBridgeReady(
  child: ChildProcess,
  port: number,
  timeoutMs = 10000
): Promise<boolean> {
  return new Promise((resolve) => {
    let output = "";
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      child.off("exit", failed);
      child.off("error", failed);
      child.stdout?.off("data", onOutput);
      child.stderr?.off("data", onErrorOutput);
      resolve(ready);
    };
    const failed = () => finish(false);
    const onOutput = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
      if (output.includes(`MITM ready on :${port} →`)) finish(true);
    };
    const onErrorOutput = (chunk: Buffer) => {
      if (chunk.toString().includes("❌")) finish(false);
    };
    const timer = setTimeout(failed, timeoutMs);
    child.once("exit", failed);
    child.once("error", failed);
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onErrorOutput);
  });
}

/** ChildProcess.killed records a sent signal, rather than an exited process. */
export async function terminateBridgeChild(child: ChildProcess, timeoutMs = 2000): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
  child.kill("SIGTERM");
  if (!(await exited)) child.kill("SIGKILL");
}

export function isOwnedBridgeCommand(command: string, serverPath: string): boolean {
  const escape = (value: string) =>
    value.replaceAll("\\", "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const node = escape(process.execPath);
  const script = escape(serverPath);
  return new RegExp(
    `^\\s*"?${node}"?\\s+"?${script}"?\\s*$`,
    process.platform === "win32" ? "i" : ""
  ).test(command.replaceAll("\\", "/"));
}

/** A reused PID must neither block recovery nor receive a Stop signal. */
export function isOwnedBridgePid(pid: number, serverPath: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    const command =
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
            ],
            { encoding: "utf8", timeout: 1500, maxBuffer: 8192, windowsHide: true }
          )
        : execFileSync("ps", ["-p", String(pid), "-o", "command="], {
            encoding: "utf8",
            timeout: 1500,
            maxBuffer: 8192,
          });
    return isOwnedBridgeCommand(command, serverPath);
  } catch {
    return false;
  }
}
