export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import { z } from "zod";
import { requireCliToolsAuth } from "@/lib/api/requireCliToolsAuth";
import {
  OMP_PROVIDER_ID,
  OMP_ROLES,
  getOmpConfigPath,
  getOmpModelsPath,
  omniRouteModelIdOf,
  parseModelRoles,
  parseOmniRouteModels,
  readTextIfPresent,
  rewriteModelRolesBlock,
  writeFileAtomic,
  type OmpRole,
} from "@/lib/cli-helper/ompRoles";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

const ompRoleIds = OMP_ROLES as unknown as [OmpRole, ...OmpRole[]];

const ompRolesSchema = z.object({
  selections: z
    .array(
      z.object({
        role: z.enum(ompRoleIds),
        // "" clears the role so omp falls back to its built-in chain.
        model: z.string().max(200),
      })
    )
    .min(1, "selections must be a non-empty array of { role, model }"),
  preview: z.boolean().optional(),
});

/**
 * Oh My Pi model roles (~/.omp/agent/config.yml → modelRoles).
 *
 * GET  -> current roles, the omniroute models omp can resolve (from models.yml), paths.
 * POST -> { selections: [{ role, model }], preview? } — validates every model against
 *         models.yml, backs up config.yml, rewrites only the modelRoles block, then
 *         re-reads the file and returns the roles actually on disk.
 */
export async function GET(request: Request) {
  const authError = await requireCliToolsAuth(request);
  if (authError) return authError;
  try {
    const [configText, modelsText] = await Promise.all([
      readTextIfPresent(getOmpConfigPath()),
      readTextIfPresent(getOmpModelsPath()),
    ]);
    const models = parseOmniRouteModels(modelsText);
    return NextResponse.json({
      success: true,
      installed: configText.length > 0 || modelsText.length > 0,
      configPath: getOmpConfigPath(),
      modelsPath: getOmpModelsPath(),
      provider: OMP_PROVIDER_ID,
      roleIds: OMP_ROLES,
      roles: parseModelRoles(configText),
      models,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: sanitizeErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const authError = await requireCliToolsAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = ompRolesSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    );
  }

  try {
    const configPath = getOmpConfigPath();
    const [configText, modelsText] = await Promise.all([
      readTextIfPresent(configPath),
      readTextIfPresent(getOmpModelsPath()),
    ]);
    const known = new Set(parseOmniRouteModels(modelsText).map((m) => m.id));
    const roles = parseModelRoles(configText);

    for (const { role, model } of parsed.data.selections) {
      const value = model.trim();
      if (!value) {
        delete roles[role];
        continue;
      }
      const selector = value.startsWith(`${OMP_PROVIDER_ID}/`)
        ? value
        : `${OMP_PROVIDER_ID}/${value}`;
      const id = omniRouteModelIdOf(selector);
      if (!id || !known.has(id)) {
        return NextResponse.json(
          {
            success: false,
            error: `Model "${value}" is not in ${getOmpModelsPath()} under providers.${OMP_PROVIDER_ID}; omp could not resolve it.`,
          },
          { status: 400 }
        );
      }
      roles[role] = selector;
    }

    const nextText = rewriteModelRolesBlock(configText, roles);
    const block = Object.keys(roles).length
      ? `modelRoles:\n${Object.entries(roles)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n")}\n`
      : "# modelRoles removed — omp uses its built-in defaults\n";

    if (parsed.data.preview) {
      return NextResponse.json({ success: true, preview: true, yaml: block, roles });
    }

    let backupPath: string | null = null;
    if (configText) {
      backupPath = `${configPath}.bak-omniroute-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await fs.writeFile(backupPath, configText, { encoding: "utf8", mode: 0o600 });
    }
    await writeFileAtomic(configPath, nextText);

    // Confirm by reading back what is actually on disk.
    const onDisk = parseModelRoles(await readTextIfPresent(configPath));
    const verified = OMP_ROLES.every((r) => (onDisk[r] ?? null) === (roles[r] ?? null));

    return NextResponse.json({
      success: true,
      verified,
      configPath,
      backupPath,
      roles: onDisk,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: sanitizeErrorMessage(error) },
      { status: 500 }
    );
  }
}
