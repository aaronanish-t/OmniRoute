import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";
import {
  OMP_ROLES,
  parseModelRoles,
  parseOmniRouteModels,
  rewriteModelRolesBlock,
  writeFileAtomic,
  omniRouteModelIdOf,
} from "../../../src/lib/cli-helper/ompRoles.ts";

type Doc = {
  modelRoles?: Record<string, string>;
  modelRoleStorage?: string;
  theme?: { dark: string };
};

// A config shaped like a real omp 18.4 ~/.omp/agent/config.yml: comments, nested
// maps, block-style lists with 4-space indent, flow maps, and trailing keys.
const CONFIG = `symbolPreset: nerd
theme:
  dark: red-line
setupVersion: 2
modelRoles:
  slow: omniroute/cc/claude-opus-5-5
  task: omniroute/cf/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b:off
  plan: omniroute/cc/claude-sonnet-5
  default: omniroute/cc/claude-opus-5-5
# keep this comment
disabledExtensions:
    - remote
    - handoff
retry:
  fallbackChains:
    {}
modelRoleStorage: project
bash:
  allowCompoundCommands: true`;

const MODELS = `providers:
  omniroute:
    baseUrl: http://127.0.0.1:20219/v1
    apiKey: sk-test
    models:
      - id: cc/claude-opus-5-5
        name: cc/claude-opus-5-5
        reasoning: true
        input: [text, image]
        contextWindow: 1000000
      - id: cc/claude-sonnet-5-5
        input: [text, image]
      - id: thinking
`;

test("OMP_ROLES matches omp 18.4 chat roles (no removed designer role)", () => {
  assert.deepEqual([...OMP_ROLES].sort(), [
    "advisor",
    "commit",
    "default",
    "memory",
    "plan",
    "slow",
    "smol",
    "task",
    "tiny",
    "vision",
  ]);
});

test("parseModelRoles reads the modelRoles map", () => {
  const roles = parseModelRoles(CONFIG);
  assert.equal(roles.default, "omniroute/cc/claude-opus-5-5");
  assert.equal(roles.task, "omniroute/cf/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b:off");
});

test("parseOmniRouteModels lists omniroute models with capabilities", () => {
  const models = parseOmniRouteModels(MODELS);
  assert.deepEqual(
    models.map((m) => m.id),
    ["cc/claude-opus-5-5", "cc/claude-sonnet-5-5", "thinking"]
  );
  assert.equal(models[0].contextWindow, 1000000);
  assert.equal(models[0].reasoning, true);
  assert.deepEqual(models[2].input, ["text"]);
});

test("omniRouteModelIdOf strips provider and thinking suffix", () => {
  assert.equal(omniRouteModelIdOf("omniroute/cc/claude-opus-5-5:high"), "cc/claude-opus-5-5");
  assert.equal(omniRouteModelIdOf("minimax-code/MiniMax-M3"), null);
});

test("rewriteModelRolesBlock changes only the modelRoles block, byte-for-byte elsewhere", () => {
  const roles = { ...parseModelRoles(CONFIG), task: "omniroute/cc/claude-sonnet-5-5" };
  const out = rewriteModelRolesBlock(CONFIG, roles);
  const before = CONFIG.split("\n");
  const after = out.split("\n");
  assert.equal(after.length, before.length);
  const changed = before.filter((l, i) => l !== after[i]);
  assert.deepEqual(changed, [
    "  task: omniroute/cf/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b:off",
  ]);
  assert.ok(out.includes("# keep this comment\n"));
  assert.ok(out.includes("    - remote\n"));
  assert.equal((yamlLoad(out) as Doc).modelRoles.task, "omniroute/cc/claude-sonnet-5-5");
});

test("rewriteModelRolesBlock removes a role and can drop the whole block", () => {
  const roles = parseModelRoles(CONFIG);
  delete roles.plan;
  assert.ok(!rewriteModelRolesBlock(CONFIG, roles).includes("  plan:"));
  const empty = rewriteModelRolesBlock(CONFIG, {});
  assert.equal((yamlLoad(empty) as Doc).modelRoles, undefined);
  assert.equal((yamlLoad(empty) as Doc).modelRoleStorage, "project");
});

test("rewriteModelRolesBlock appends a block when none exists", () => {
  const out = rewriteModelRolesBlock("theme:\n  dark: x", {
    default: "omniroute/cc/claude-opus-5-5",
  });
  assert.deepEqual((yamlLoad(out) as Doc).modelRoles, { default: "omniroute/cc/claude-opus-5-5" });
  assert.equal((yamlLoad(out) as Doc).theme.dark, "x");
});

test("rewriteModelRolesBlock rejects unsafe selectors instead of writing them", () => {
  assert.throws(
    () => rewriteModelRolesBlock(CONFIG, { default: "x\n  evil: 1" }),
    /Invalid model selector/
  );
  assert.throws(
    () => rewriteModelRolesBlock(CONFIG, { "bad role": "omniroute/x" }),
    /Invalid role name/
  );
});

test("writeFileAtomic round-trips on a real file and preserves 0600", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-roles-"));
  const file = path.join(dir, "config.yml");
  await fs.writeFile(file, CONFIG, { mode: 0o600 });
  const next = rewriteModelRolesBlock(CONFIG, { default: "omniroute/cc/claude-opus-5-5" });
  await writeFileAtomic(file, next);
  assert.equal(await fs.readFile(file, "utf8"), next);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.rm(dir, { recursive: true, force: true });
});
