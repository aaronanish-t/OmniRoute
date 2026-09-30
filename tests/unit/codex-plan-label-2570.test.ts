// Port of upstream decolua/9router PR #2570 (feat(ui): show Codex plan labels
// in provider and quota views).
//
// Two independent gaps this closes:
//
// 1. providerPageHelpers.getCodexPlanLabel — the provider-detail ConnectionRow
//    never surfaced the Codex subscription plan (persisted at OAuth import
//    time in providerSpecificData.chatgptPlanType — see
//    src/lib/oauth/services/codexImport.ts) anywhere in the row UI.
//
// 2. ProviderLimits/utils.resolvePlanValue — the quota-view plan badge
//    machinery already existed (tierByConnection / QuotaCardHeader), but its
//    persisted-metadata fallback list did not include chatgptPlanType. When
//    the live Codex usage endpoint does not return a plan_type field (usage
//    service falls back to the literal string "unknown" — see
//    open-sse/services/usage/codex.ts), the badge fell through to "Unknown"
//    instead of the plan captured at login.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { getCodexUsage } from "../../open-sse/services/usage/codex.ts";
import { getCodexPlanLabel } from "@/app/(dashboard)/dashboard/providers/[id]/codexPlanLabel";
import {
  buildProviderLimitsResolvedPlans,
  normalizePlanTier,
  resolvePlanValue,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils";

const codexProPlans = [
  ["prolite", "Pro Standard"],
  ["pro", "Pro Extra"],
  ["promax", "Pro Max"],
] as const;

for (const [plan, label] of codexProPlans) {
  test(`Codex ${plan} has the same readable label for import and OAuth metadata`, () => {
    for (const raw of [plan, `  ${plan.toUpperCase()}  `]) {
      assert.equal(getCodexPlanLabel(true, { chatgptPlanType: raw }), label);
      assert.equal(getCodexPlanLabel(true, { workspacePlanType: raw }), label);
    }
  });

  test(`Codex ${plan} belongs to Pro without losing its raw plan`, () => {
    const raw = `  ${plan.toUpperCase()}  `;
    assert.deepEqual(normalizePlanTier(raw, " CODEX "), {
      key: "pro",
      label,
      variant: "success",
      rank: 3,
      raw: raw.trim(),
    });
  });

  test(`live Codex ${plan} survives usage resolution over stale Pro metadata`, async (t) => {
    const psd = Object.freeze({ workspacePlanType: "pro", chatgptPlanType: "pro" });
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({ plan_type: plan, rate_limit: {} })
    );
    const usage = await getCodexUsage("fixture-token", psd);
    assert.ok("plan" in usage);
    assert.equal(usage.plan, plan);
    const connection = { id: "codex-fixture", provider: "codex", providerSpecificData: psd };
    const resolved = buildProviderLimitsResolvedPlans([connection], { [connection.id]: usage });
    assert.equal(resolved[connection.id], plan);
    const tier = normalizePlanTier(resolved[connection.id], connection.provider);
    assert.equal(tier.key, "pro");
    assert.equal(tier.label, label);
    assert.equal(tier.raw, plan);
    assert.deepEqual(psd, { workspacePlanType: "pro", chatgptPlanType: "pro" });
  });
}

test("Codex OAuth workspace metadata takes precedence, with a valid import fallback", () => {
  assert.equal(
    getCodexPlanLabel(true, { workspacePlanType: "promax", chatgptPlanType: "pro" }),
    "Pro Max"
  );
  for (const invalid of [undefined, null, "", "  ", 42, false, {}, []]) {
    assert.equal(
      getCodexPlanLabel(true, { workspacePlanType: invalid, chatgptPlanType: "prolite" }),
      "Pro Standard"
    );
    assert.equal(
      getCodexPlanLabel(true, { workspacePlanType: invalid, chatgptPlanType: invalid }),
      ""
    );
    assert.equal(normalizePlanTier(invalid, "codex").key, "unknown");
  }
  for (const invalid of [undefined, null, 42, false, "pro", []]) {
    assert.equal(getCodexPlanLabel(true, invalid), "");
  }
});

test("Codex Pro naming does not change generic providers or business plan classification", () => {
  for (const provider of [undefined, null, 42, {}, "claude", "gemini", "antigravity"]) {
    assert.equal(normalizePlanTier("pro", provider).label, "Pro");
    assert.equal(normalizePlanTier("prolite", provider).key, "unknown");
    assert.equal(normalizePlanTier("promax", provider).key, "unknown");
  }
  const business = normalizePlanTier("self_serve_business_prolite", "codex");
  assert.equal(business.key, "business");
  assert.equal(business.label, "Business");
  assert.equal(normalizePlanTier("default_claude_max_20x", "claude").label, "Max 20x");
});

test("unrecognized Codex plans retain their raw value and existing safe fallback", () => {
  for (const raw of [
    "Future_Plan-V2",
    "constructor",
    "__proto__",
    "self_serve_business_prolite",
    "plus",
  ]) {
    assert.equal(getCodexPlanLabel(true, { chatgptPlanType: `  ${raw}  ` }), raw);
    assert.equal(normalizePlanTier(raw, "codex").raw, raw);
    assert.deepEqual(normalizePlanTier(raw, "codex"), normalizePlanTier(raw));
  }
});

test("missing live usage resolves both Codex metadata shapes into the Pro filter bucket", () => {
  const connections = codexProPlans.flatMap(([plan]) =>
    ["workspacePlanType", "chatgptPlanType"].map((field) => ({
      id: `${field}-${plan}`,
      provider: "codex",
      providerSpecificData: { [field]: plan },
    }))
  );
  const resolved = buildProviderLimitsResolvedPlans(connections, {});
  const tiers = connections.map((connection) =>
    normalizePlanTier(resolved[connection.id], connection.provider)
  );
  assert.equal(tiers.filter((tier) => tier.key === "pro").length, connections.length);
  assert.equal(tiers.filter((tier) => tier.key === "unknown").length, 0);
  assert.deepEqual(
    [...new Set(tiers.map((tier) => tier.label))],
    codexProPlans.map(([, label]) => label)
  );
});

test("quota cards and page tier stats forward provider identity to plan normalization", () => {
  const root = "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/";
  for (const [file, provider] of [
    ["utils.tsx", "providerId"],
    ["QuotaCard.tsx", "connection.provider"],
    ["index.tsx", "conn.provider"],
  ]) {
    const source = ts.createSourceFile(
      file,
      readFileSync(new URL(root + file, import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "normalizePlanTier")
        calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(calls.length > 0, `${file} must exercise plan normalization`);
    for (const call of calls) assert.equal(call.arguments[1]?.getText(source), provider, file);
  }
});

test("getCodexPlanLabel returns empty string when not a codex connection", () => {
  assert.equal(getCodexPlanLabel(false, { chatgptPlanType: "Pro" }), "");
});

test("getCodexPlanLabel returns empty string when chatgptPlanType is missing/blank", () => {
  assert.equal(getCodexPlanLabel(true, {}), "");
  assert.equal(getCodexPlanLabel(true, { chatgptPlanType: "   " }), "");
  assert.equal(getCodexPlanLabel(true, undefined), "");
});

test("resolvePlanValue falls back to the persisted Codex chatgptPlanType when the live plan is unknown", () => {
  // Reproduces the exact shape open-sse/services/usage/codex.ts returns when
  // the upstream Codex usage endpoint omits plan_type/planType.
  assert.equal(resolvePlanValue("unknown", { chatgptPlanType: "Pro" }, "codex"), "Pro");
});

test("resolvePlanValue still prefers a real live plan over the persisted Codex fallback", () => {
  assert.equal(resolvePlanValue("Team", { chatgptPlanType: "Pro" }, "codex"), "Team");
});

test("resolvePlanValue returns null when neither live nor persisted Codex plan is available", () => {
  assert.equal(resolvePlanValue("unknown", {}, "codex"), null);
  assert.equal(resolvePlanValue(null, null, "codex"), null);
});
