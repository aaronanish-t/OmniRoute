import fs from "node:fs";
import type { ChildProcess } from "node:child_process";

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
