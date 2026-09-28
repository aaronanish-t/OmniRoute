/**
 * Provider family aggregation — call_logs rows for members of a declared
 * connection family (e.g. kimi-coding + kimi-coding-apikey) collapse into a
 * single canonical group. DB handles are released in test.after to prevent
 * Node native test runner from hanging.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-db-family-agg-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const mod = await import("../../../src/lib/db/callLogStats.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idSeq = 0;
function insertCallLog(row: Record<string, unknown>) {
  const db = core.getDbInstance();
  const full = {
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "m",
    requested_model: null,
    provider: "openai",
    account: null,
    connection_id: null,
    duration: 100,
    tokens_in: 10,
    tokens_out: 20,
    cache_source: "upstream",
    source_format: null,
    target_format: null,
    api_key_id: null,
    api_key_name: null,
    combo_name: null,
    combo_step_id: null,
    combo_execution_key: null,
    error_summary: null,
    detail_state: "none",
    artifact_relpath: null,
    artifact_size_bytes: null,
    artifact_sha256: null,
    has_request_body: 0,
    has_response_body: 0,
    has_pipeline_details: 0,
    request_summary: null,
    request_type: null,
    ...row,
    id: row.id ?? `log-family-${++_idSeq}`,
    timestamp: row.timestamp ?? "2025-07-02T12:00:00.000Z",
  };
  db.prepare(
    `INSERT INTO call_logs (
      id, timestamp, method, path, status, model, requested_model, provider, account,
      connection_id, duration, tokens_in, tokens_out, cache_source, source_format, target_format,
      api_key_id, api_key_name, combo_name, combo_step_id, combo_execution_key,
      error_summary, detail_state, artifact_relpath, artifact_size_bytes, artifact_sha256,
      has_request_body, has_response_body, has_pipeline_details, request_summary, request_type
    ) VALUES (
      @id, @timestamp, @method, @path, @status, @model, @requested_model, @provider, @account,
      @connection_id, @duration, @tokens_in, @tokens_out, @cache_source, @source_format, @target_format,
      @api_key_id, @api_key_name, @combo_name, @combo_step_id, @combo_execution_key,
      @error_summary, @detail_state, @artifact_relpath, @artifact_size_bytes, @artifact_sha256,
      @has_request_body, @has_response_body, @has_pipeline_details, @request_summary, @request_type
    )`
  ).run(full);
}

function seedConnection(provider: string) {
  const now = new Date().toISOString();
  core
    .getDbInstance()
    .prepare(
      `INSERT OR IGNORE INTO provider_connections (id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)`
    )
    .run(`conn-family-${provider}`, provider, now, now);
}

const CUTOFF = "2025-07-01T00:00:00.000Z";

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// Resolution table checks without a database
// ---------------------------------------------------------------------------

test("family aggregation — resolution table maps every member to its canonical id", () => {
  const table = mod.buildFamilyCanonicalOf();
  assert.equal(table.get("xao"), "xai-oauth");
  assert.equal(table.get("xai-oauth"), "xai-oauth");
  assert.equal(table.get("xai"), "xai");
  assert.equal(table.get("kimi-coding-apikey"), "kimi-coding");
  assert.equal(table.get("kimi-coding"), "kimi-coding");
  assert.equal(table.get("alibaba-cn"), "alibaba");
  assert.equal(table.get("freepik"), "magnific");
  assert.equal(table.get("magnific"), "magnific");
});

test("family aggregation — canonical CASE sql only branches on non-canonical members", () => {
  const sql = mod.getFamilyCanonicalSql("c.provider");
  assert.ok(sql.startsWith("CASE c.provider"), "expression scoped to the given column");
  assert.ok(sql.includes("WHEN 'xao' THEN 'xai-oauth'"), "special branch wins over the map");
  assert.ok(
    sql.includes("WHEN 'kimi-coding-apikey' THEN 'kimi-coding'"),
    "family member branch present"
  );
  assert.ok(!sql.includes("WHEN 'xai'"), "canonical ids emit no branch");
  assert.ok(sql.endsWith("ELSE c.provider END"), "unknown providers pass through");
});

// ---------------------------------------------------------------------------
// GREEN — kimi-coding family collapses into one group
// ---------------------------------------------------------------------------

test("family aggregation — xai-oauth and xao form one xai-oauth group", () => {
  seedConnection("xai-oauth");
  seedConnection("xao");
  insertCallLog({ provider: "xai-oauth", status: 200, duration: 100 });
  insertCallLog({ provider: "xao", status: 200, duration: 200 });

  const usage = mod.getProviderUsageSince(CUTOFF);
  assert.deepEqual(
    usage.filter((r) => r.provider === "xao"),
    [],
    "no separate alias group"
  );
  const row = usage.find((r) => r.provider === "xai-oauth");
  assert.ok(row, "canonical group present");
  assert.equal(row.requests, 2, "requests are summed across members");
  assert.equal(row.avgLatencyMs, 150, "ROUND((100+200)/2)");

  const metrics = mod.getProviderMetrics();
  assert.ok(
    metrics.some((r) => r.provider === "xai-oauth"),
    "metrics group present"
  );
  assert.ok(!metrics.some((r) => r.provider === "xao"), "no alias metrics group");
});

test("family aggregation — member without a live connection is excluded (#10714)", () => {
  seedConnection("kimi-coding");
  // No seedConnection("kimi-coding-apikey") on purpose.
  insertCallLog({ provider: "kimi-coding", status: 200, duration: 100 });
  insertCallLog({ provider: "kimi-coding-apikey", status: 200, duration: 100 });

  const row = mod.getProviderUsageSince(CUTOFF).find((r) => r.provider === "kimi-coding");
  assert.ok(row, "canonical group present");
  assert.equal(row.requests, 1, "the member without a connection must not resurface");
});

test("family aggregation — lastStatus subquery shape is canonical", () => {
  // Placeholder for the cross-member lastStatus proof, now folded into the
  // kimi-coding GREEN test (lastStatus/lastErrorStatus asserts). Kept as a
  // direct shape check on an isolated member pair instead of a duplicate DB
  // scenario that collides with shared file-DB state.
  seedConnection("kimi-coding-apikey-ls");
  insertCallLog({
    provider: "kimi-coding-apikey-ls",
    status: 500,
    duration: 100,
    error_summary: "boom",
    timestamp: "2025-07-02T11:00:00.000Z",
    id: "log-family-ls-1",
  });

  const plain = mod.getProviderMetrics().find((r) => r.provider === "kimi-coding-apikey-ls");
  assert.ok(plain, "member group present");
  assert.equal(plain.lastStatus, 500);
});

test("family aggregation — planner keeps using the provider index for selection", () => {
  const db = core.getDbInstance();
  const plan = (
    db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT provider, COUNT(*) FROM call_logs WHERE timestamp >= '2025-07-01T00:00:00.000Z' GROUP BY 1"
      )
      .all() as Array<{ detail: string }>
  )
    .map((r) => r.detail)
    .join(" | ");
  assert.ok(!plan.includes("SCAN TABLE"), `must not table-scan, got: ${plan}`);
});

test("family aggregation — kimi-coding and kimi-coding-apikey form one group", () => {
  seedConnection("kimi-coding");
  seedConnection("kimi-coding-apikey");
  const before =
    mod.getProviderUsageSince(CUTOFF).find((r) => r.provider === "kimi-coding")?.requests ?? 0;
  const beforeSuccesses =
    mod.getProviderUsageSince(CUTOFF).find((r) => r.provider === "kimi-coding")?.successes ?? 0;
  insertCallLog({ provider: "kimi-coding", status: 200, duration: 100, id: "log-family-green-1" });
  insertCallLog({
    provider: "kimi-coding-apikey",
    status: 500,
    duration: 300,
    error_summary: "upstream error",
    id: "log-family-green-2",
  });

  const usage = mod.getProviderUsageSince(CUTOFF);
  assert.deepEqual(
    usage.filter((r) => r.provider === "kimi-coding-apikey"),
    [],
    "no separate member group"
  );
  const row = usage.find((r) => r.provider === "kimi-coding");
  assert.ok(row, "canonical group present");
  assert.equal(row.requests, before + 2, "requests are summed across members");
  assert.equal(row.successes, beforeSuccesses + 1, "successes are summed across members");

  const metrics = mod.getProviderMetrics();
  const metric = metrics.find((r) => r.provider === "kimi-coding");
  assert.ok(metric, "canonical metrics group present");
  assert.ok(metric.totalRequests >= 2);
  assert.equal(metric.lastStatus, 500, "newest member row wins across members");
  assert.equal(metric.lastErrorStatus, 500);
});
