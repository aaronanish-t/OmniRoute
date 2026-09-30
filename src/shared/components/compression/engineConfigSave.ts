import type { EngineConfigField } from "@omniroute/open-sse/services/compression/engines/types";

type FormValues = Record<string, unknown>;

function asRecord(value: unknown): FormValues {
  return value && typeof value === "object" ? (value as FormValues) : {};
}

// The settings schemas reject an empty string, so an emptied text field means "not set".
function isEmptyText(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "";
}

/** Form values an engine page shows on load: schema defaults, then the stored sub-object. */
export function seedEngineForm(
  engineId: string,
  schema: EngineConfigField[],
  stored: unknown
): FormValues {
  const current = asRecord(stored);
  const defaults: FormValues = Object.fromEntries(schema.map((f) => [f.key, f.defaultValue]));
  // Do not seed lite.maxToolLength from the schema default. Persisting 2000
  // would freeze the cap in settings and hide OMNIROUTE_LITE_MAX_TOOL_LENGTH.
  // The form still shows 2000 via field.defaultValue until the operator edits it.
  if (engineId === "lite" && current.maxToolLength === undefined) {
    delete defaults.maxToolLength;
  }
  return { ...defaults, ...current };
}

/**
 * The sub-object an engine page PUTs on save. The server replaces the whole sub-object row, so
 * the body starts from the copy stored at save time and applies only the fields edited since
 * `loaded`. `enabled` belongs to the compression panel and is never written here. An emptied
 * text field removes its key.
 */
export function buildEngineDetailUpdate(
  loaded: FormValues,
  edited: FormValues,
  stored: unknown
): FormValues {
  const next = { ...asRecord(stored) };
  for (const [key, value] of Object.entries(edited)) {
    if (key === "enabled" || Object.is(value, loaded[key])) continue;
    if (isEmptyText(value)) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

/** Form values without emptied text fields, so a preview config passes the settings schema. */
export function withoutEmptyText(values: FormValues): FormValues {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => !isEmptyText(value)));
}
