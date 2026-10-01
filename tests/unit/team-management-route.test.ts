import test from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_DATA_DIR = fs.mkdtempSync(join(os.tmpdir(), "omniroute-team-routes-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_DISABLE_BACKUP = process.env.DISABLE_SQLITE_AUTO_BACKUP;
const ORIGINAL_DISABLE_REDIS_AUTH_CACHE = process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.API_KEY_SECRET = "team-management-route-test-secret";

const core = await import("../../src/lib/db/core.ts");
const settings = await import("../../src/lib/db/settings.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const teams = await import("../../src/lib/db/teams.ts");
const teamListRoute = await import("../../src/app/api/teams/route.ts");
const teamDetailRoute = await import("../../src/app/api/teams/[id]/route.ts");
const teamMembersRoute = await import("../../src/app/api/teams/[id]/members/route.ts");
const teamUsageRoute = await import("../../src/app/api/teams/[id]/usage/route.ts");
const exportJsonRoute = await import("../../src/app/api/settings/export-json/route.ts");
const importJsonRoute = await import("../../src/app/api/settings/import-json/route.ts");
const { TeamUpdateSchema } = await import("../../src/shared/validation/schemas/teams.ts");

async function resetStorage(): Promise<void> {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await settings.updateSettings({ requireLogin: false });
}

function request(pathname: string, method = "GET", body?: string, managementKey?: string): Request {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (managementKey) headers.set("authorization", `Bearer ${managementKey}`);
  return new Request(`http://localhost${pathname}`, { method, headers, body });
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

test.after(() => {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_DISABLE_BACKUP === undefined) delete process.env.DISABLE_SQLITE_AUTO_BACKUP;
  else process.env.DISABLE_SQLITE_AUTO_BACKUP = ORIGINAL_DISABLE_BACKUP;
  if (ORIGINAL_DISABLE_REDIS_AUTH_CACHE === undefined) {
    delete process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE;
  } else {
    process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = ORIGINAL_DISABLE_REDIS_AUTH_CACHE;
  }
  if (ORIGINAL_API_KEY_SECRET === undefined) delete process.env.API_KEY_SECRET;
  else process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
});

const paths = [
  "src/app/api/teams/route.ts",
  "src/app/api/teams/[id]/route.ts",
  "src/app/api/teams/[id]/members/route.ts",
  "src/app/api/teams/[id]/usage/route.ts",
];

for (const relativePath of paths) {
  test(`${relativePath} is management-authenticated and sanitizes errors`, () => {
    const source = readFileSync(join(ROOT, relativePath), "utf8");
    assert.match(source, /requireManagementAuth/);
    assert.match(source, /if \(authError\) return authError/);
    assert.match(source, /buildErrorBody/);
    assert.doesNotMatch(source, /err\.stack|error\.stack/);
  });
}

test("team routes validate mutations and expose CRUD, assignment, and usage operations", () => {
  const list = readFileSync(join(ROOT, paths[0]), "utf8");
  const detail = readFileSync(join(ROOT, paths[1]), "utf8");
  const members = readFileSync(join(ROOT, paths[2]), "utf8");
  const usage = readFileSync(join(ROOT, paths[3]), "utf8");
  assert.match(list, /TeamCreateSchema/);
  assert.match(detail, /TeamUpdateSchema/);
  assert.match(detail, /archived teams cannot be updated/i);
  assert.match(members, /TeamMemberAssignmentSchema/);
  assert.match(list, /export async function GET/);
  assert.match(list, /export async function POST/);
  assert.match(detail, /export async function GET/);
  assert.match(detail, /export async function PATCH/);
  assert.match(detail, /export async function DELETE/);
  assert.match(members, /export async function GET/);
  assert.match(members, /export async function PUT/);
  assert.match(members, /export async function DELETE/);
  assert.match(usage, /getTeamUsageReport/);
});

test("OpenAPI defines every Team schema referenced by Team routes", () => {
  const openapi = readFileSync(join(ROOT, "public/openapi.yaml"), "utf8");
  for (const schema of ["TeamCreate", "TeamUpdate"]) {
    assert.match(openapi, new RegExp(`^    ${schema}:`, "m"));
    assert.match(openapi, new RegExp(`#/components/schemas/${schema}`));
  }
});

test("Team and JSON backup handlers reject anonymous requests when login is disabled", async () => {
  await resetStorage();
  const team = teams.createTeam({ name: "Auth boundary" });
  const routeParams = params(team.id);
  const cases: Array<[string, () => Promise<Response>]> = [
    ["GET /api/teams", () => teamListRoute.GET(request("/api/teams"))],
    ["POST /api/teams", () => teamListRoute.POST(request("/api/teams", "POST", "not-json"))],
    [
      "GET /api/teams/{id}",
      () => teamDetailRoute.GET(request(`/api/teams/${team.id}`), routeParams),
    ],
    [
      "PATCH /api/teams/{id}",
      () =>
        teamDetailRoute.PATCH(request(`/api/teams/${team.id}`, "PATCH", "not-json"), routeParams),
    ],
    [
      "GET /api/teams/{id}/members",
      () => teamMembersRoute.GET(request(`/api/teams/${team.id}/members`), routeParams),
    ],
    [
      "PUT /api/teams/{id}/members",
      () =>
        teamMembersRoute.PUT(
          request(`/api/teams/${team.id}/members`, "PUT", "not-json"),
          routeParams
        ),
    ],
    [
      "DELETE /api/teams/{id}/members",
      () =>
        teamMembersRoute.DELETE(request(`/api/teams/${team.id}/members`, "DELETE"), routeParams),
    ],
    [
      "GET /api/teams/{id}/usage",
      () => teamUsageRoute.GET(request(`/api/teams/${team.id}/usage`), routeParams),
    ],
    [
      "DELETE /api/teams/{id}",
      () => teamDetailRoute.DELETE(request(`/api/teams/${team.id}`, "DELETE"), routeParams),
    ],
    [
      "GET /api/settings/export-json",
      () => exportJsonRoute.GET(request("/api/settings/export-json")),
    ],
    [
      "POST /api/settings/import-json",
      () => importJsonRoute.POST(request("/api/settings/import-json", "POST", "not-json")),
    ],
  ];

  for (const [label, invoke] of cases) {
    const response = await invoke();
    assert.equal(response.status, 401, `${label} must authenticate before parsing or lookup`);
  }

  assert.equal(teams.getTeam(team.id)?.status, "active", "anonymous DELETE must not archive");
});

test("manage-scoped API keys can use Team and JSON backup handlers", async () => {
  await resetStorage();
  const managementKey = await apiKeys.createApiKey(
    "Team route administrator",
    "machine-team-route-admin",
    ["manage"]
  );
  const authRequest = (pathname: string, method = "GET", body?: string) =>
    request(pathname, method, body, managementKey.key);

  const createdResponse = await teamListRoute.POST(
    authRequest("/api/teams", "POST", JSON.stringify({ name: "Managed Team" }))
  );
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()) as { team: { id: string } };
  const teamId = created.team.id;
  const routeParams = params(teamId);

  assert.equal((await teamListRoute.GET(authRequest("/api/teams"))).status, 200);
  assert.equal(
    (await teamDetailRoute.GET(authRequest(`/api/teams/${teamId}`), routeParams)).status,
    200
  );
  assert.equal(
    (
      await teamDetailRoute.PATCH(
        authRequest(
          `/api/teams/${teamId}`,
          "PATCH",
          JSON.stringify({ name: "Managed Team Updated" })
        ),
        routeParams
      )
    ).status,
    200
  );
  assert.equal(
    (
      await teamMembersRoute.PUT(
        authRequest(
          `/api/teams/${teamId}/members`,
          "PUT",
          JSON.stringify({ apiKeyId: managementKey.id })
        ),
        routeParams
      )
    ).status,
    200
  );
  assert.equal(
    (await teamMembersRoute.GET(authRequest(`/api/teams/${teamId}/members`), routeParams)).status,
    200
  );
  assert.equal(
    (await teamUsageRoute.GET(authRequest(`/api/teams/${teamId}/usage`), routeParams)).status,
    200
  );
  assert.equal(
    (
      await teamMembersRoute.DELETE(
        authRequest(`/api/teams/${teamId}/members?apiKeyId=${managementKey.id}`, "DELETE"),
        routeParams
      )
    ).status,
    200
  );
  assert.equal(
    (await teamDetailRoute.DELETE(authRequest(`/api/teams/${teamId}`, "DELETE"), routeParams))
      .status,
    200
  );

  const exported = await exportJsonRoute.GET(authRequest("/api/settings/export-json"));
  assert.equal(exported.status, 200);
  const exportedBody = await exported.text();
  assert.equal(
    (await importJsonRoute.POST(authRequest("/api/settings/import-json", "POST", exportedBody)))
      .status,
    200
  );
});

test("authenticated Team PATCH rejects single-null and incomplete initial budgets", async () => {
  await resetStorage();
  const admin = await apiKeys.createApiKey("budget patch admin", "machine-budget-patch", [
    "manage",
  ]);
  const team = teams.createTeam({ name: "Budget PATCH", maxBudgetUsd: 1, budgetDuration: "1d" });
  const bare = teams.createTeam({ name: "Bare PATCH" });
  for (const payload of [{ maxBudgetUsd: null }, { budgetDuration: null }]) {
    assert.equal(TeamUpdateSchema.safeParse(payload).success, false);
    const response = await teamDetailRoute.PATCH(
      request(`/api/teams/${team.id}`, "PATCH", JSON.stringify(payload), admin.key),
      params(team.id)
    );
    assert.equal(response.status, 400);
  }
  assert.equal(
    (
      await teamDetailRoute.PATCH(
        request(`/api/teams/${bare.id}`, "PATCH", JSON.stringify({ maxBudgetUsd: 2 }), admin.key),
        params(bare.id)
      )
    ).status,
    400
  );
  for (const payload of [{ maxBudgetUsd: 2 }, { budgetDuration: "7d" }]) {
    assert.equal(TeamUpdateSchema.safeParse(payload).success, true);
    assert.equal(
      (
        await teamDetailRoute.PATCH(
          request(`/api/teams/${team.id}`, "PATCH", JSON.stringify(payload), admin.key),
          params(team.id)
        )
      ).status,
      200
    );
  }
  assert.equal(
    (
      await teamDetailRoute.PATCH(
        request(
          `/api/teams/${team.id}`,
          "PATCH",
          JSON.stringify({ maxBudgetUsd: null, budgetDuration: null }),
          admin.key
        ),
        params(team.id)
      )
    ).status,
    200
  );
  assert.equal(teams.getTeam(team.id)?.maxBudgetUsd, null);
});

test("JSON backup and restore guard before reading input and preserve Team data", () => {
  const exportSource = readFileSync(
    join(ROOT, "src/app/api/settings/export-json/route.ts"),
    "utf8"
  );
  const importSource = readFileSync(
    join(ROOT, "src/app/api/settings/import-json/route.ts"),
    "utf8"
  );
  for (const source of [exportSource, importSource]) {
    assert.match(source, /requireManagementAuth/);
    assert.match(source, /if \(authError\) return authError/);
  }
  assert.ok(
    importSource.indexOf("if (authError) return authError") < importSource.indexOf("request.text()")
  );
  assert.match(exportSource, /teams: listTeams\(\{ includeArchived: true \}\)/);
  assert.match(exportSource, /apiKeyBillingTeamHistory: listAllApiKeyBillingHistory\(\)/);
  assert.match(exportSource, /exportData\.dailyTeamUsageSummary = getAllDailyTeamUsageSummary\(\)/);
});
