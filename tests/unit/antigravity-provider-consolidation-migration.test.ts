import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { setDbInstance } from "../../src/lib/db/singleton.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = path.join(repoRoot, "src/lib/db/migrations");
const migrationSql = fs.readFileSync(
  path.join(migrationsDir, "197_merge_agy_into_antigravity.sql"),
  "utf8"
);
const schemaMigrations = [
  "001_initial_schema.sql",
  "002_mcp_a2a_tables.sql",
  "008_registered_keys.sql",
  "013_quota_snapshots.sql",
  "017_version_manager_upstream_proxy.sql",
  "047_aggregation_tables.sql",
  "050_session_account_affinity.sql",
  "059_manifest_routing.sql",
  "064_create_session_model_history.sql",
  "066_api_key_groups.sql",
  "074_discovery_results.sql",
  "079_provider_plans.sql",
  "108_provider_quota_reset_events.sql",
  "110_model_context_overrides.sql",
  "119_model_capability_overrides.sql",
  "147_api_keys_model_access_mode.sql",
  "153_radar_local_model_state.sql",
  "157_exclusive_connection_leases.sql",
  "169_model_capabilities.sql",
];

function openDb(): Database.Database {
  const db = new Database(":memory:");
  for (const migration of schemaMigrations) {
    if (migration === "147_api_keys_model_access_mode.sql") {
      // 001 predates allowed_models; current core.ts creates this persisted JSON field.
      db.exec("ALTER TABLE api_keys ADD COLUMN allowed_models TEXT DEFAULT '[]'");
      // Match the current API-key schema fallback for per-key block patterns as well.
      db.exec("ALTER TABLE api_keys ADD COLUMN blocked_models TEXT");
    }
    db.exec(fs.readFileSync(path.join(migrationsDir, migration), "utf8"));
  }
  return db;
}

function applyMigration(db: Database.Database): void {
  db.transaction(() => db.exec(migrationSql))();
}

function insertKv(db: Database.Database, namespace: string, key: string, value: unknown): void {
  db.prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    namespace,
    key,
    JSON.stringify(value)
  );
}

function row<T extends object>(db: Database.Database, sql: string, ...params: unknown[]): T {
  const result = db.prepare(sql).get(...params);
  assert.ok(result, `expected a row for ${sql}`);
  return result as T;
}

test("consolidates persistent defaults, nested combo pins, model catalogs, and alias ACLs", async () => {
  const db = openDb();
  const { checkKeyModelAccess } = await import("../../src/lib/db/apiKeyGroups.ts");
  const { isModelAllowedForKey } = await import("../../src/lib/db/apiKeys.ts");
  const { isDeniedUnderCanonicalProvider } =
    await import("../../src/lib/db/apiKeys/publishedModelLookup.ts");
  try {
    setDbInstance(db as never);
    db.prepare(
      `INSERT INTO provider_connections
        (id, provider, default_model, provider_specific_data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      "conn-agy",
      "agy",
      "agy/gemini-cli-pro",
      JSON.stringify({ clientProfile: "ide", preserved: true }),
      "2026-01-01",
      "2026-01-01"
    );
    db.prepare(
      "INSERT INTO combos (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "combo-1",
      "Pinned combo",
      JSON.stringify(
        {
          models: [
            {
              kind: "model",
              providerId: "agy",
              model: "agy/gemini-cli-pro",
              label: "agy/custom-alias",
              prompt: "agy/custom-prompt",
            },
            "agy/gemini-flash",
            { kind: "model", provider: "agy", model: "gemini-classic" },
          ],
          description: "agy/custom-description",
          system_message: "agy/custom-system-prompt",
          allowedProviders: ["agy", "openai"],
        },
        null,
        2
      ),
      "2026-01-01",
      "2026-01-01"
    );

    insertKv(db, "modelAliases", "gemini-default", "agy/gemini-cli-pro");
    insertKv(db, "customModels", "agy", [
      { id: "shared", name: "legacy value" },
      { id: "agy-only", name: "Legacy custom" },
    ]);
    insertKv(db, "customModels", "antigravity", [
      { id: "shared", name: "destination value" },
      { id: "destination-only", name: "Canonical custom" },
    ]);
    insertKv(db, "modelCompatOverrides", "agy", [{ id: "compat-only", preserveVideoUrl: true }]);
    insertKv(db, "providerAliases", "agy", { fast: "agy/gemini-fast" });
    insertKv(db, "providerAliases", "antigravity", { custom: "antigravity/gemini-custom" });
    insertKv(db, "pricing", "agy", {
      "gemini-pro": { input: 1, output: 2 },
      "agy-only-model": { input: 3 },
    });
    insertKv(db, "pricing", "antigravity", {
      "gemini-pro": { input: 9, output: 8 },
      "canonical-model": { input: 4 },
    });
    insertKv(db, "syncedAvailableModels", "agy:conn-1", [
      { id: "shared-model", name: "legacy model" },
      { id: "agy-only-model", name: "Legacy discovered" },
    ]);
    insertKv(db, "syncedAvailableModels", "antigravity:conn-1", [
      { id: "shared-model", name: "destination model" },
      { id: "destination-model", name: "Canonical discovered" },
    ]);

    db.prepare(
      "INSERT INTO model_capabilities (provider, model_id, reasoning) VALUES (?, ?, ?)"
    ).run("agy", "gemini-cli-pro", 1);
    db.prepare("INSERT INTO key_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      "group-1",
      "agy users",
      "2026-01-01",
      "2026-01-01"
    );
    db.prepare(
      `INSERT INTO api_keys (id, name, key, allowed_models, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("key-1", "test", "secret", JSON.stringify(["agy/*", "openai/gpt-4"]), "2026-01-01");
    db.prepare(
      `INSERT INTO api_keys (id, name, key, allowed_models, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      "key-2",
      "canonical duplicate",
      "secret-2",
      JSON.stringify(["agy/*", "antigravity/*"]),
      "2026-01-01"
    );
    db.prepare(
      `INSERT INTO api_keys (id, name, key, allowed_models, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("key-3", "legacy allowlist", "secret-3", JSON.stringify(["agy/*"]), "2026-01-01");
    db.prepare(
      `INSERT INTO api_keys (id, name, key, allowed_models, blocked_models, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      "key-4",
      "legacy blocklist",
      "secret-4",
      JSON.stringify([]),
      JSON.stringify(["agy/gemini-secret"]),
      "2026-01-01"
    );
    db.prepare(
      `INSERT INTO api_keys (id, name, key, allowed_models, blocked_models, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      "key-5",
      "canonical block duplicate",
      "secret-5",
      JSON.stringify([]),
      JSON.stringify(["agy/gemini-secret", "antigravity/gemini-secret"]),
      "2026-01-01"
    );
    db.prepare("INSERT INTO key_group_members (key_id, group_id) VALUES (?, ?)").run(
      "key-1",
      "group-1"
    );
    db.prepare(
      `INSERT INTO group_model_permissions
        (id, group_id, model_pattern, provider, access_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("permission-agy", "group-1", "gemini-*", "agy", "allow", "2026-01-01");
    db.prepare(
      `INSERT INTO group_model_permissions
        (id, group_id, model_pattern, provider, access_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("permission-agy-clone", "group-1", "gemini-clone-*", "agy", "allow", "2026-01-01");
    db.prepare(
      `INSERT INTO group_model_permissions
        (id, group_id, model_pattern, provider, access_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      "permission-canonical-existing",
      "group-1",
      "gemini-*",
      "antigravity",
      "allow",
      "2026-01-02"
    );
    db.prepare(
      `INSERT INTO group_model_permissions
        (id, group_id, model_pattern, provider, access_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("permission-agy-deny", "group-1", "gemini-secret", "agy", "deny", "2026-01-01");

    applyMigration(db);

    const connection = row<{
      provider: string;
      default_model: string;
      provider_specific_data: string;
    }>(
      db,
      "SELECT provider, default_model, provider_specific_data FROM provider_connections WHERE id = ?",
      "conn-agy"
    );
    assert.equal(connection.provider, "antigravity");
    assert.equal(connection.default_model, "antigravity/gemini-cli-pro");
    assert.deepEqual(JSON.parse(connection.provider_specific_data), {
      clientProfile: "cli",
      preserved: true,
    });

    const combo = JSON.parse(
      row<{ data: string }>(db, "SELECT data FROM combos WHERE id = ?", "combo-1").data
    );
    assert.deepEqual(combo, {
      models: [
        {
          kind: "model",
          providerId: "antigravity",
          model: "antigravity/gemini-cli-pro",
          label: "agy/custom-alias",
          prompt: "agy/custom-prompt",
        },
        "antigravity/gemini-flash",
        { kind: "model", provider: "antigravity", model: "gemini-classic" },
      ],
      description: "agy/custom-description",
      system_message: "agy/custom-system-prompt",
      allowedProviders: ["agy", "openai", "antigravity"],
    });
    assert.equal(
      row<{ value: string }>(
        db,
        "SELECT value FROM key_value WHERE namespace = 'modelAliases' AND key = ?",
        "gemini-default"
      ).value,
      JSON.stringify("antigravity/gemini-cli-pro")
    );

    const customModels = JSON.parse(
      row<{ value: string }>(
        db,
        "SELECT value FROM key_value WHERE namespace = 'customModels' AND key = 'antigravity'"
      ).value
    ) as Array<{ id: string; name: string }>;
    assert.deepEqual(customModels, [
      { id: "shared", name: "destination value" },
      { id: "destination-only", name: "Canonical custom" },
      { id: "agy-only", name: "Legacy custom" },
    ]);
    assert.equal(
      row<{ value: string }>(
        db,
        "SELECT value FROM key_value WHERE namespace = 'modelCompatOverrides' AND key = 'antigravity'"
      ).value,
      JSON.stringify([{ id: "compat-only", preserveVideoUrl: true }])
    );
    assert.deepEqual(
      JSON.parse(
        row<{ value: string }>(
          db,
          "SELECT value FROM key_value WHERE namespace = 'providerAliases' AND key = 'antigravity'"
        ).value
      ),
      { custom: "antigravity/gemini-custom", fast: "antigravity/gemini-fast" }
    );
    assert.deepEqual(
      JSON.parse(
        row<{ allowed_models: string }>(
          db,
          "SELECT allowed_models FROM api_keys WHERE id = ?",
          "key-1"
        ).allowed_models
      ),
      ["agy/*", "openai/gpt-4", "antigravity/*"],
      "restricted per-key allowlists keep their agy pattern and gain a canonical equivalent"
    );
    assert.deepEqual(
      JSON.parse(
        row<{ allowed_models: string }>(
          db,
          "SELECT allowed_models FROM api_keys WHERE id = ?",
          "key-2"
        ).allowed_models
      ),
      ["agy/*", "antigravity/*"],
      "an existing canonical allowlist entry is not duplicated"
    );
    assert.deepEqual(
      JSON.parse(
        row<{ blocked_models: string }>(
          db,
          "SELECT blocked_models FROM api_keys WHERE id = ?",
          "key-4"
        ).blocked_models
      ),
      ["agy/gemini-secret", "antigravity/gemini-secret"],
      "per-key blocklists retain their agy pattern and gain a canonical equivalent"
    );
    assert.deepEqual(
      JSON.parse(
        row<{ blocked_models: string }>(
          db,
          "SELECT blocked_models FROM api_keys WHERE id = ?",
          "key-5"
        ).blocked_models
      ),
      ["agy/gemini-secret", "antigravity/gemini-secret"],
      "an existing canonical block pattern is not duplicated"
    );
    assert.deepEqual(
      JSON.parse(
        row<{ value: string }>(
          db,
          "SELECT value FROM key_value WHERE namespace = 'pricing' AND key = 'antigravity'"
        ).value
      ),
      {
        "gemini-pro": { input: 9, output: 8 },
        "canonical-model": { input: 4 },
        "agy-only-model": { input: 3 },
      }
    );
    const catalog = JSON.parse(
      row<{ value: string }>(
        db,
        "SELECT value FROM key_value WHERE namespace = 'syncedAvailableModels' AND key = 'antigravity:conn-1'"
      ).value
    ) as Array<{ id: string; name: string }>;
    assert.deepEqual(catalog, [
      { id: "shared-model", name: "destination model" },
      { id: "destination-model", name: "Canonical discovered" },
      { id: "agy-only-model", name: "Legacy discovered" },
    ]);
    assert.equal(
      row<{ reasoning: number }>(
        db,
        "SELECT reasoning FROM model_capabilities WHERE provider = 'antigravity' AND model_id = ?",
        "gemini-cli-pro"
      ).reasoning,
      1
    );

    const aliasCheck = checkKeyModelAccess("key-1", "gemini-cli-pro", "agy");
    const canonicalCheck = checkKeyModelAccess("key-1", "gemini-cli-pro", "antigravity");
    assert.equal(aliasCheck.allowed, true, "the existing agy-prefixed model ID remains authorized");
    assert.equal(
      canonicalCheck.allowed,
      true,
      "the canonical provider receives an equivalent allow rule"
    );
    assert.equal(checkKeyModelAccess("key-1", "gemini-clone-one", "agy").allowed, true);
    assert.equal(
      checkKeyModelAccess("key-1", "gemini-clone-one", "antigravity").allowed,
      true,
      "a legacy allow rule without a preexisting canonical equivalent is cloned"
    );
    const legacyDeny = checkKeyModelAccess("key-1", "gemini-secret", "agy");
    const canonicalDeny = checkKeyModelAccess("key-1", "gemini-secret", "antigravity");
    assert.equal(legacyDeny.allowed, false, "the existing agy deny still applies to legacy IDs");
    assert.equal(canonicalDeny.allowed, false, "the agy deny is cloned to canonical provider IDs");
    assert.equal(legacyDeny.deniedBy?.provider, "agy");
    assert.equal(canonicalDeny.deniedBy?.provider, "antigravity");
    assert.equal(
      await isDeniedUnderCanonicalProvider("key-1", "agy", "gemini-secret"),
      true,
      "canonical deny bridging keeps the agy-prefixed request restricted"
    );
    assert.equal(
      await isModelAllowedForKey("secret-3", "agy/gemini-cli-pro"),
      true,
      "legacy model allowlists continue to authorize agy/model requests"
    );
    assert.equal(
      await isModelAllowedForKey("secret-3", "antigravity/gemini-cli-pro"),
      true,
      "legacy model allowlists authorize migrated canonical model pins"
    );
    assert.equal(
      await isModelAllowedForKey("secret-4", "agy/gemini-secret"),
      false,
      "legacy model blocklists continue to deny agy/model requests"
    );
    assert.equal(
      await isModelAllowedForKey("secret-4", "antigravity/gemini-secret"),
      false,
      "legacy model blocklists continue to deny canonical model requests"
    );
    assert.equal(
      row<{ count: number }>(
        db,
        "SELECT count(*) AS count FROM group_model_permissions WHERE provider = 'agy' AND access_type = 'allow'"
      ).count,
      2,
      "the legacy provider allow rules remain available to agy/model requests"
    );
    assert.equal(
      row<{ id: string }>(
        db,
        "SELECT id FROM group_model_permissions WHERE group_id = 'group-1' AND provider = 'antigravity' AND model_pattern = 'gemini-*' AND access_type = 'allow'"
      ).id,
      "permission-canonical-existing",
      "the migration preserves an already-equivalent canonical permission"
    );
    const canonicalAllowCount = row<{ count: number }>(
      db,
      "SELECT count(*) AS count FROM group_model_permissions WHERE provider = 'antigravity' AND access_type = 'allow'"
    ).count;
    assert.equal(canonicalAllowCount, 2);
    applyMigration(db);
    assert.equal(
      row<{ count: number }>(
        db,
        "SELECT count(*) AS count FROM group_model_permissions WHERE provider = 'antigravity' AND access_type = 'allow'"
      ).count,
      canonicalAllowCount,
      "rerunning the migration does not duplicate cloned allow rules"
    );
  } finally {
    setDbInstance(null);
    db.close();
  }
});

test("unique-key collisions keep destination values and retain source-only rows", () => {
  const db = openDb();
  try {
    db.prepare(
      `INSERT INTO combo_adaptation_state
        (combo_id, provider_id, learned_score, request_count, success_count)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`
    ).run(
      "combo-shared",
      "agy",
      0.2,
      4,
      1,
      "combo-shared",
      "antigravity",
      0.9,
      10,
      9,
      "combo-legacy-only",
      "agy",
      0.4,
      3,
      2
    );
    db.prepare(
      `INSERT INTO upstream_proxy_config
        (provider_id, mode, cliproxyapi_model_mapping)
       VALUES (?, ?, ?), (?, ?, ?)`
    ).run(
      "agy",
      "cliproxyapi",
      JSON.stringify({ "agy/gemini-pro": "legacy-upstream" }),
      "antigravity",
      "native",
      JSON.stringify({ "antigravity/gemini-pro": "canonical-upstream" })
    );
    db.prepare(
      `INSERT INTO radar_local_model_state
        (provider, model_id, display_name, enabled, tombstoned, updated_at)
       VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`
    ).run(
      "agy",
      "shared-model",
      "legacy display",
      0,
      1,
      "legacy",
      "antigravity",
      "shared-model",
      "canonical display",
      1,
      0,
      "canonical",
      "agy",
      "legacy-only-model",
      "legacy-only display",
      0,
      0,
      "legacy-only"
    );

    db.prepare(
      `INSERT INTO provider_key_limits
        (provider, max_active_keys, daily_issued, hourly_issued, last_reset_day, last_reset_hour)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("agy", 1, 2, 3, "agy-day", "agy-hour");
    db.prepare(
      `INSERT INTO provider_key_limits
        (provider, max_active_keys, daily_issued, hourly_issued, last_reset_day, last_reset_hour)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("antigravity", 9, 8, 7, "destination-day", "destination-hour");

    db.prepare(
      `INSERT INTO tier_assignments (provider, model, tier, reason)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`
    ).run(
      "agy",
      "shared-model",
      "free",
      "legacy collision",
      "antigravity",
      "shared-model",
      "premium",
      "destination wins",
      "agy",
      "legacy-only-model",
      "cheap",
      "preserve this"
    );
    db.prepare(
      `INSERT INTO session_account_affinity
        (session_key, provider, connection_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`
    ).run(
      "shared-session",
      "agy",
      "legacy-connection",
      1,
      1,
      "shared-session",
      "antigravity",
      "destination-connection",
      2,
      2,
      "legacy-session",
      "agy",
      "legacy-only-connection",
      3,
      3
    );
    db.prepare(
      `INSERT INTO model_context_overrides
        (provider, model_id, real_context, source, refreshed_at)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`
    ).run(
      "agy",
      "shared-model",
      100,
      "manual",
      "legacy",
      "antigravity",
      "shared-model",
      900,
      "manual",
      "destination",
      "agy",
      "legacy-only-model",
      200,
      "manual",
      "legacy-only"
    );
    db.prepare(
      `INSERT INTO model_capability_overrides
        (provider, model_id, override_key, override_value, refreshed_at)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`
    ).run(
      "agy",
      "shared-model",
      "supportsVision",
      "false",
      "legacy",
      "antigravity",
      "shared-model",
      "supportsVision",
      "true",
      "destination",
      "agy",
      "legacy-only-model",
      "supportsTools",
      "true",
      "legacy-only"
    );
    db.prepare(
      `INSERT INTO model_capabilities (provider, model_id, reasoning, last_synced)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`
    ).run(
      "agy",
      "shared-model",
      0,
      "legacy",
      "antigravity",
      "shared-model",
      1,
      "destination",
      "agy",
      "legacy-only-model",
      1,
      "legacy-only"
    );
    db.prepare(
      `INSERT INTO discovery_results (provider_id, method, endpoint, notes)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`
    ).run(
      "agy",
      "public_api",
      "https://api.example.test/models",
      "legacy collision",
      "antigravity",
      "public_api",
      "https://api.example.test/models",
      "destination wins",
      "agy",
      "public_api",
      "https://legacy.example.test/models",
      "legacy only"
    );

    assert.doesNotThrow(() => applyMigration(db));

    assert.deepEqual(
      row<{ max_active_keys: number; daily_issued: number }>(
        db,
        "SELECT max_active_keys, daily_issued FROM provider_key_limits WHERE provider = 'antigravity'"
      ),
      { max_active_keys: 9, daily_issued: 8 }
    );
    assert.equal(
      row<{ learned_score: number }>(
        db,
        "SELECT learned_score FROM combo_adaptation_state WHERE combo_id = 'combo-shared' AND provider_id = 'antigravity'"
      ).learned_score,
      0.9,
      "canonical combo adaptation state wins the provider-key collision"
    );
    assert.equal(
      row<{ learned_score: number }>(
        db,
        "SELECT learned_score FROM combo_adaptation_state WHERE combo_id = 'combo-legacy-only' AND provider_id = 'antigravity'"
      ).learned_score,
      0.4,
      "legacy-only combo adaptation state survives under the canonical provider"
    );
    assert.deepEqual(
      row<{ mode: string; cliproxyapi_model_mapping: string }>(
        db,
        "SELECT mode, cliproxyapi_model_mapping FROM upstream_proxy_config WHERE provider_id = 'antigravity'"
      ),
      {
        mode: "native",
        cliproxyapi_model_mapping: JSON.stringify({
          "antigravity/gemini-pro": "canonical-upstream",
        }),
      },
      "canonical upstream routing settings win the provider-key collision"
    );
    assert.deepEqual(
      row<{ display_name: string; enabled: number; tombstoned: number }>(
        db,
        "SELECT display_name, enabled, tombstoned FROM radar_local_model_state WHERE provider = 'antigravity' AND model_id = 'shared-model'"
      ),
      { display_name: "canonical display", enabled: 1, tombstoned: 0 },
      "canonical Radar model state wins the provider/model collision"
    );
    assert.equal(
      row<{ display_name: string }>(
        db,
        "SELECT display_name FROM radar_local_model_state WHERE provider = 'antigravity' AND model_id = 'legacy-only-model'"
      ).display_name,
      "legacy-only display",
      "legacy-only Radar model state survives under the canonical provider"
    );
    assert.equal(
      row<{ tier: string; reason: string }>(
        db,
        "SELECT tier, reason FROM tier_assignments WHERE provider = 'antigravity' AND model = 'shared-model'"
      ).reason,
      "destination wins"
    );
    assert.equal(
      row<{ reason: string }>(
        db,
        "SELECT reason FROM tier_assignments WHERE provider = 'antigravity' AND model = 'legacy-only-model'"
      ).reason,
      "preserve this"
    );
    assert.equal(
      row<{ connection_id: string }>(
        db,
        "SELECT connection_id FROM session_account_affinity WHERE session_key = 'shared-session' AND provider = 'antigravity'"
      ).connection_id,
      "destination-connection"
    );
    assert.equal(
      row<{ connection_id: string }>(
        db,
        "SELECT connection_id FROM session_account_affinity WHERE session_key = 'legacy-session' AND provider = 'antigravity'"
      ).connection_id,
      "legacy-only-connection"
    );
    assert.equal(
      row<{ real_context: number }>(
        db,
        "SELECT real_context FROM model_context_overrides WHERE provider = 'antigravity' AND model_id = 'shared-model'"
      ).real_context,
      900
    );
    assert.equal(
      row<{ override_value: string }>(
        db,
        "SELECT override_value FROM model_capability_overrides WHERE provider = 'antigravity' AND model_id = 'shared-model' AND override_key = 'supportsVision'"
      ).override_value,
      "true"
    );
    assert.equal(
      row<{ override_value: string }>(
        db,
        "SELECT override_value FROM model_capability_overrides WHERE provider = 'antigravity' AND model_id = 'legacy-only-model' AND override_key = 'supportsTools'"
      ).override_value,
      "true"
    );
    assert.equal(
      row<{ reasoning: number }>(
        db,
        "SELECT reasoning FROM model_capabilities WHERE provider = 'antigravity' AND model_id = 'shared-model'"
      ).reasoning,
      1
    );
    assert.equal(
      row<{ reasoning: number }>(
        db,
        "SELECT reasoning FROM model_capabilities WHERE provider = 'antigravity' AND model_id = 'legacy-only-model'"
      ).reasoning,
      1
    );
    assert.equal(
      row<{ notes: string }>(
        db,
        "SELECT notes FROM discovery_results WHERE provider_id = 'antigravity' AND endpoint = 'https://api.example.test/models'"
      ).notes,
      "destination wins"
    );
    assert.equal(
      row<{ notes: string }>(
        db,
        "SELECT notes FROM discovery_results WHERE provider_id = 'antigravity' AND endpoint = 'https://legacy.example.test/models'"
      ).notes,
      "legacy only"
    );

    applyMigration(db);
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM model_capabilities WHERE provider = 'agy'").get()
        ?.count,
      0,
      "running the SQL again is idempotent"
    );
  } finally {
    db.close();
  }
});

test("a fresh current schema with no agy rows can apply the migration repeatedly", () => {
  const db = openDb();
  try {
    assert.doesNotThrow(() => applyMigration(db));
    assert.doesNotThrow(() => applyMigration(db));
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM provider_connections WHERE provider = 'agy'").get()
        ?.count,
      0
    );
  } finally {
    db.close();
  }
});

test("fresh core initialization heals blocked_models before running consolidation migration", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agy-core-init-"));
  const originalDataDir = process.env.DATA_DIR;
  const originalNextPhase = process.env.NEXT_PHASE;
  let resetDbInstance: (() => void) | undefined;

  try {
    process.env.DATA_DIR = dataDir;
    delete process.env.NEXT_PHASE;

    const coreUrl = pathToFileURL(path.join(repoRoot, "src/lib/db/core.ts")).href;
    const core = await import(
      `${coreUrl}?test=${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    resetDbInstance = core.resetDbInstance;
    const db = core.getDbInstance();

    assert.ok(
      db.prepare("SELECT version FROM _omniroute_migrations WHERE version = '197'").get(),
      "fresh core initialization must apply the consolidation migration"
    );
    assert.doesNotThrow(() => db.prepare("SELECT blocked_models FROM api_keys").all());
  } finally {
    resetDbInstance?.();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalNextPhase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = originalNextPhase;
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
