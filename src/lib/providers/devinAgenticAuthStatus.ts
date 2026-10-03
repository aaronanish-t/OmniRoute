import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildDevinChildEnv } from "@omniroute/open-sse/executors/devin-cli-agentic";

const execFileAsync = promisify(execFile);
const STATUS_TIMEOUT_MS = 8_000;
const STATUS_MAX_BUFFER = 16 * 1024;
const CACHE_TTL_MS = 10_000;

export type DevinAgenticAuthStatus = "authenticated" | "unauthenticated" | "unavailable";

let cachedStatus: { status: DevinAgenticAuthStatus; checkedAt: number } | null = null;

/**
 * Checks the isolated Devin CLI login without returning CLI output (which
 * contains account PII) to the dashboard. The short cache avoids spawning a
 * CLI process for repeated provider-card renders.
 */
export async function getDevinAgenticAuthStatus(
  source: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): Promise<DevinAgenticAuthStatus> {
  if (cachedStatus && now - cachedStatus.checkedAt < CACHE_TTL_MS) {
    return cachedStatus.status;
  }

  let status: DevinAgenticAuthStatus = "unavailable";
  try {
    const env = buildDevinChildEnv({}, source);
    const bin =
      source.CLI_DEVIN_AGENTIC_BIN?.trim() || source.CLI_DEVIN_BIN?.trim() || "devin";
    const { stdout, stderr } = await execFileAsync(bin, ["auth", "status"], {
      cwd: env.HOME,
      env,
      timeout: STATUS_TIMEOUT_MS,
      maxBuffer: STATUS_MAX_BUFFER,
      encoding: "utf8",
      windowsHide: true,
    });
    status = parseDevinAuthStatus(`${stdout}\n${stderr}`);
  } catch (error) {
    const result = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    const output = [result.stdout, result.stderr]
      .map((part) => (Buffer.isBuffer(part) ? part.toString("utf8") : part || ""))
      .join("\n");
    status = parseDevinAuthStatus(output);
  }

  cachedStatus = { status, checkedAt: now };
  return status;
}

export function parseDevinAuthStatus(output: string): DevinAgenticAuthStatus {
  if (/\bnot logged in\b/i.test(output)) return "unauthenticated";
  if (/\blogged in\b/i.test(output)) return "authenticated";
  return "unavailable";
}

export function clearDevinAgenticAuthStatusCache(): void {
  cachedStatus = null;
}
