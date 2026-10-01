import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { load as yamlLoad } from "js-yaml";

/**
 * Oh My Pi (`omp`) model-role management.
 *
 * omp resolves every model role (`default`, `smol`, `task`, …) from the top-level
 * `modelRoles` map in `~/.omp/agent/config.yml`. This module reads that map and
 * rewrites ONLY that block — every other byte of the user's config (comments,
 * key order, list style) is preserved, and the write is verified by re-parsing.
 *
 * Role ids and behaviour mirror omp 18.4 (`packages/coding-agent/src/config/model-roles.ts`).
 */
export const OMP_ROLES = [
  "default",
  "smol",
  "slow",
  "plan",
  "vision",
  "task",
  "advisor",
  "commit",
  "tiny",
  "memory",
] as const;

export type OmpRole = (typeof OMP_ROLES)[number];

export const OMP_PROVIDER_ID = "omniroute";

export interface OmpModelInfo {
  id: string;
  name: string;
  input: string[];
  contextWindow: number | null;
  reasoning: boolean;
}

export function getOmpAgentDir(): string {
  return path.join(os.homedir(), ".omp", "agent");
}

export function getOmpConfigPath(): string {
  return path.join(getOmpAgentDir(), "config.yml");
}

export function getOmpModelsPath(): string {
  return path.join(getOmpAgentDir(), "models.yml");
}

export async function readTextIfPresent(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Parse the `modelRoles` map out of config.yml text. Throws on unparseable YAML. */
export function parseModelRoles(configText: string): Record<string, string> {
  const doc = asRecord(configText.trim() ? yamlLoad(configText) : {});
  const roles = asRecord(doc.modelRoles);
  const out: Record<string, string> = {};
  for (const [role, value] of Object.entries(roles)) {
    if (typeof value === "string" && value.trim()) out[role] = value.trim();
  }
  return out;
}

/** The models omp can resolve through the `omniroute` provider in models.yml. */
export function parseOmniRouteModels(modelsText: string): OmpModelInfo[] {
  const doc = asRecord(modelsText.trim() ? yamlLoad(modelsText) : {});
  const provider = asRecord(asRecord(doc.providers)[OMP_PROVIDER_ID]);
  const models = Array.isArray(provider.models) ? provider.models : [];
  return models
    .map((raw) => asRecord(raw))
    .filter((m) => typeof m.id === "string" && m.id)
    .map((m) => ({
      id: m.id as string,
      name: typeof m.name === "string" && m.name ? m.name : (m.id as string),
      input: Array.isArray(m.input) ? (m.input as string[]) : ["text"],
      contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : null,
      reasoning: m.reasoning === true,
    }));
}

/** `omniroute/<id>[:suffix]` → `<id>`; other providers → null. */
export function omniRouteModelIdOf(selector: string): string | null {
  const bare = selector.split(":")[0];
  const prefix = `${OMP_PROVIDER_ID}/`;
  return bare.startsWith(prefix) ? bare.slice(prefix.length) : null;
}

/**
 * Return config text with the top-level `modelRoles` block replaced by `roles`
 * (roles in insertion order; an empty map removes the block). Everything outside
 * the block is left untouched, and the result is verified by re-parsing: the
 * non-role content must be deep-equal to the original and `modelRoles` must equal
 * `roles` exactly. Throws if either check fails.
 */
export function rewriteModelRolesBlock(configText: string, roles: Record<string, string>): string {
  for (const [role, value] of Object.entries(roles)) {
    if (!/^[a-z][a-z0-9_-]*$/i.test(role)) throw new Error(`Invalid role name: ${role}`);
    if (!/^[\w@./:+-]+$/.test(value)) throw new Error(`Invalid model selector for ${role}`);
  }
  const lines = configText.length ? configText.split(/(?<=\n)/) : [];
  const block =
    Object.keys(roles).length === 0
      ? []
      : ["modelRoles:\n", ...Object.entries(roles).map(([k, v]) => `  ${k}: ${v}\n`)];

  const start = lines.findIndex((l) => l.trimEnd() === "modelRoles:");
  let next: string[];
  if (start === -1) {
    const tail = lines.length && !lines[lines.length - 1].endsWith("\n") ? ["\n"] : [];
    next = [...lines, ...tail, ...block];
  } else {
    let end = start + 1;
    while (end < lines.length && (lines[end].startsWith(" ") || lines[end].trim() === "")) end++;
    next = [...lines.slice(0, start), ...block, ...lines.slice(end)];
  }
  const out = next.join("");

  const before = asRecord(configText.trim() ? yamlLoad(configText) : {});
  const after = asRecord(out.trim() ? yamlLoad(out) : {});
  const strip = (d: Record<string, unknown>) => {
    const copy = { ...d };
    delete copy.modelRoles;
    return copy;
  };
  if (!isDeepStrictEqual(strip(before), strip(after))) {
    throw new Error("Refusing to write: content outside modelRoles would change");
  }
  if (!isDeepStrictEqual(asRecord(after.modelRoles), roles)) {
    throw new Error("Refusing to write: modelRoles did not round-trip");
  }
  return out;
}

/** Write via temp file + rename, preserving the existing file mode (default 0600). */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  let mode = 0o600;
  try {
    mode = (await fs.stat(filePath)).mode & 0o777;
  } catch {
    // new file keeps 0600
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, content, { encoding: "utf8", mode });
    await fs.chmod(tempPath, mode);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}
