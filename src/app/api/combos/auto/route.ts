import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { isAutoComboId, materializeAutoCombo } from "@/lib/combos/autoVirtual";
import {
  VALID_VARIANTS,
  type AutoVariant,
} from "@omniroute/open-sse/services/autoCombo/autoPrefix";
import {
  AUTO_SUFFIX_VARIANTS,
  AUTO_TEMPLATE_VARIANTS,
  AUTO_FAMILY_IDS,
} from "@omniroute/open-sse/services/autoCombo/builtinCatalog";
import { parseAutoSuffix } from "@omniroute/open-sse/services/autoCombo/suffixComposition";

const ALL_VARIANTS: Array<{ variant: AutoVariant | undefined; name: string }> = [
  { variant: undefined, name: "Auto" },
  ...VALID_VARIANTS.map((v) => ({
    variant: v,
    name: `Auto ${v.charAt(0).toUpperCase() + v.slice(1)}`,
  })),
];

// GET /api/combos/auto - List available auto combo variants with candidate info.
// GET /api/combos/auto?id=<auto|auto/*> - Materialize ONE built-in auto combo as
// a control-center-shaped payload (models as combo steps). Virtual auto combos
// have no persisted row, so the UUID-keyed /api/combos/[id] route cannot serve
// them — this is the adapter the dashboard uses instead.
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const singleId = new URL(request.url).searchParams.get("id");
  if (singleId !== null) return getSingleAutoCombo(singleId);

  try {
    const { prepareVirtualAutoComboInputs, createVirtualAutoComboFromPrepared } =
      await import("@omniroute/open-sse/services/autoCombo/virtualFactory");

    // #14889: every variant below is built from the same candidate pool, so prepare
    // it once per request. createVirtualAutoCombo() prepares it again on each call,
    // which made this route rebuild the whole pool once per listed variant.
    const prepared = await prepareVirtualAutoComboInputs();

    const combos = [];
    const seenIds = new Set<string>();
    for (const { variant, name } of ALL_VARIANTS) {
      try {
        const virtual = await createVirtualAutoComboFromPrepared(prepared, variant);
        // A combo with no live candidates can never dispatch — don't list it.
        if (!virtual.candidatePool?.length) continue;
        const id = variant ? `auto/${variant}` : "auto";
        seenIds.add(id);
        combos.push({
          id,
          name,
          variant: variant ?? null,
          type: "auto",
          kind: "variant",
          isHidden: false,
          candidatePool: virtual.candidatePool ?? [],
          candidateCount: virtual.candidatePool?.length ?? 0,
          // MAX of candidates' windows — consumers (opencode plugin) need a
          // real value here: advertising 0 disables client auto-compaction.
          // #7662: mirror catalog.ts's established fallback (advertisedMaxOutputTokens
          // has no generic default in computeAdvertisedLimits() the way context length
          // does — an all-unregistered candidate pool, e.g. a no-auth provider's model,
          // otherwise advertises null and disables client auto-compaction).
          context_length: virtual.advertisedContextLength || 128000,
          max_output_tokens: virtual.advertisedMaxOutputTokens || 8192,
          config: virtual.config ?? {},
        });
      } catch {
        // Individual variant failure — skip, don't break the whole list
      }
    }

    // Phase B: enumerate template variants (auto/best-coding, auto/pro-*,
    // auto/claude-*, auto/best-free, etc.) that the backend already supports
    // via builtinCatalog.ts but were not exposed by this endpoint.
    // Run BEFORE suffix variants so template resolution wins for overlapping
    // ids (auto/reasoning, auto/vision), matching catalog.ts behavior.
    for (const modelStr of Object.keys(AUTO_TEMPLATE_VARIANTS)) {
      if (seenIds.has(modelStr)) continue;
      try {
        const variant = AUTO_TEMPLATE_VARIANTS[modelStr];
        const spec = modelStr === "auto/best-free" ? { tier: "free" as const } : undefined;
        const virtual = await createVirtualAutoComboFromPrepared(prepared, variant, spec);
        if (!virtual.candidatePool?.length) continue;

        const displayName = variant
          ? `Auto ${variant.charAt(0).toUpperCase() + variant.slice(1)}`
          : "Auto Chat";

        combos.push({
          id: modelStr,
          name: displayName,
          variant: null,
          type: "auto",
          kind: "template",
          isHidden: false,
          candidatePool: virtual.candidatePool ?? [],
          candidateCount: virtual.candidatePool?.length ?? 0,
          // #7662: mirror catalog.ts's established fallback (advertisedMaxOutputTokens
          // has no generic default in computeAdvertisedLimits() the way context length
          // does — an all-unregistered candidate pool, e.g. a no-auth provider's model,
          // otherwise advertises null and disables client auto-compaction).
          context_length: virtual.advertisedContextLength || 128000,
          max_output_tokens: virtual.advertisedMaxOutputTokens || 8192,
          config: virtual.config ?? {},
        });
        seenIds.add(modelStr);
      } catch {
        // Individual variant failure — skip, don't break the whole list
      }
    }

    // Phase C: enumerate tiered `auto/<category>[:<tier>]` variants
    // (e.g. auto/coding:free, auto/reasoning:pro) that the backend already
    // supports via suffixComposition.ts + virtualFactory.ts but were not
    // exposed by this endpoint.
    for (const modelStr of AUTO_SUFFIX_VARIANTS) {
      if (seenIds.has(modelStr)) continue;
      try {
        const suffix = modelStr.slice("auto/".length);
        const parsed = parseAutoSuffix(suffix);
        if (!parsed.valid) continue;

        const virtual = await createVirtualAutoComboFromPrepared(prepared, undefined, {
          category: parsed.category,
          tier: parsed.tier,
        });
        if (!virtual.candidatePool?.length) continue;

        // Build a human-readable name from the category and tier
        const catName = parsed.category
          ? parsed.category.charAt(0).toUpperCase() + parsed.category.slice(1)
          : "";
        const tierName = parsed.tier
          ? `${parsed.tier.charAt(0).toUpperCase() + parsed.tier.slice(1)}`
          : "";
        const displayName = tierName ? `${catName} ${tierName}` : catName;

        combos.push({
          id: modelStr,
          name: `Auto ${displayName}`,
          variant: null,
          type: "auto",
          kind: "category",
          isHidden: false,
          candidatePool: virtual.candidatePool ?? [],
          candidateCount: virtual.candidatePool?.length ?? 0,
          // #7662: mirror catalog.ts's established fallback (advertisedMaxOutputTokens
          // has no generic default in computeAdvertisedLimits() the way context length
          // does — an all-unregistered candidate pool, e.g. a no-auth provider's model,
          // otherwise advertises null and disables client auto-compaction).
          context_length: virtual.advertisedContextLength || 128000,
          max_output_tokens: virtual.advertisedMaxOutputTokens || 8192,
          config: virtual.config ?? {},
        });
        seenIds.add(modelStr);
      } catch {
        // Individual variant failure — skip, don't break the whole list
      }
    }

    // Phase D: enumerate family variants (auto/glm, auto/llama,
    // auto/gemini, etc.) that the backend already supports via modelFamily.ts
    // but were not exposed by this endpoint.
    for (const modelStr of AUTO_FAMILY_IDS) {
      if (seenIds.has(modelStr)) continue;
      try {
        const suffix = modelStr.slice("auto/".length);
        const virtual = await createVirtualAutoComboFromPrepared(prepared, undefined, {
          family: suffix,
        });
        if (!virtual.candidatePool?.length) continue;

        const displayName = `Auto ${suffix.charAt(0).toUpperCase() + suffix.slice(1)}`;

        combos.push({
          id: modelStr,
          name: displayName,
          variant: null,
          type: "auto",
          kind: "family",
          isHidden: false,
          candidatePool: virtual.candidatePool ?? [],
          candidateCount: virtual.candidatePool?.length ?? 0,
          // #7662: mirror catalog.ts's established fallback (advertisedMaxOutputTokens
          // has no generic default in computeAdvertisedLimits() the way context length
          // does — an all-unregistered candidate pool, e.g. a no-auth provider's model,
          // otherwise advertises null and disables client auto-compaction).
          context_length: virtual.advertisedContextLength || 128000,
          max_output_tokens: virtual.advertisedMaxOutputTokens || 8192,
          config: virtual.config ?? {},
        });
        seenIds.add(modelStr);
      } catch {
        // Individual variant failure — skip, don't break the whole list
      }
    }

    return NextResponse.json({ combos });
  } catch (error) {
    console.error("Error fetching auto combos:", error);
    return NextResponse.json({ combos: [] });
  }
}

/**
 * `?id=` handler — materialize a single built-in auto combo into the same
 * combo-shaped payload the control center consumes: `models` are the virtual
 * combo's live candidate steps ({kind:"model", providerId, model, weight,…}),
 * `strategy` is always "auto". Unknown/unresolvable ids → 404.
 */
async function getSingleAutoCombo(rawId: string) {
  const id = rawId.trim();
  if (!isAutoComboId(id)) {
    return NextResponse.json({ error: `Not an auto combo id: "${id}"` }, { status: 400 });
  }
  try {
    const virtual = await materializeAutoCombo(id);
    const models = Array.isArray(virtual.models) ? virtual.models : [];
    return NextResponse.json({
      id,
      name: id,
      strategy: "auto",
      models,
      isActive: true,
      type: "auto",
      config: virtual.config ?? {},
      candidateCount: models.length,
      context_length: virtual.advertisedContextLength || 128000,
      max_output_tokens: virtual.advertisedMaxOutputTokens || 8192,
    });
  } catch {
    return NextResponse.json({ error: `Unknown auto combo: "${id}"` }, { status: 404 });
  }
}
