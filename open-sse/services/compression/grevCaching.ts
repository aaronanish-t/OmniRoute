import type { GrevCachingConfig } from "./types.ts";

export type { GrevCachingConfig } from "./types.ts";

export interface GrevCachingRequestTarget {
  provider: string | null | undefined;
  model: string | null | undefined;
  routingComboIds: readonly string[];
  compatible?: boolean;
}

function normalized(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/** True when GrevCaching exclusively owns context handling for this request target. */
export function isGrevCachingTarget(
  config: GrevCachingConfig | null | undefined,
  target: GrevCachingRequestTarget
): boolean {
  if (!config?.enabled) return false;
  const modelKey = [normalized(target.provider), normalized(target.model)]
    .filter(Boolean)
    .join("/");
  const excludedModels = new Set(config.excludedModelKeys.map(normalized).filter(Boolean));
  return !excludedModels.has(modelKey);
}
