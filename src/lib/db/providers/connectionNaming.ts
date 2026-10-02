/**
 * db/providers/connectionNaming.ts — cookie/web-session connection lookup and
 * the #15070 name-conflict guard. Extracted from providers.ts to keep that file
 * under the file-size cap.
 */

import { rowToCamel } from "../core";
import { decryptConnectionFields } from "../encryption";
import { toRecord, toStringOrNull } from "./columns";
import { webSessionCredentialKey, parseProviderSpecificData } from "../webSessionDedup";

type JsonRecord = Record<string, unknown>;

interface DbLike {
  prepare: <TRow = unknown>(
    sql: string
  ) => {
    get: (...params: unknown[]) => TRow | undefined;
    all: (...params: unknown[]) => TRow[];
  };
}

// #3368 PR6 — dedup web-session cookie/token credentials on connection create.
// Re-importing the same session (e.g. via bulk web-session import) under a
// different or blank name must update the existing connection instead of
// inserting a duplicate, mirroring the apikey dedup (#3023). Extracted from
// createProviderConnection to keep that function below the complexity baseline.
// provider_specific_data is plaintext JSON, so the value is compared directly
// without decryption.
export function findExistingCookieConnection(
  db: DbLike,
  provider: unknown,
  name: unknown,
  normalizedProviderSpecificData: unknown
): JsonRecord | null {
  // 1) Name-based upsert for parity with the apikey path.
  if (name) {
    const byName =
      (db
        .prepare(
          "SELECT * FROM provider_connections WHERE provider = ? AND auth_type = 'cookie' AND name = ?"
        )
        .get(provider, name) as JsonRecord | undefined) || null;
    if (byName) return byName;
  }
  // 2) Credential-value dedup against existing cookie rows.
  const newCredKey = webSessionCredentialKey(normalizedProviderSpecificData);
  if (!newCredKey) return null;
  const cookieRows = db
    .prepare("SELECT * FROM provider_connections WHERE provider = ? AND auth_type = 'cookie'")
    .all(provider) as JsonRecord[];
  for (const row of cookieRows) {
    const psd = parseProviderSpecificData(row.provider_specific_data);
    if (psd && webSessionCredentialKey(psd) === newCredKey) return row;
  }
  return null;
}

/**
 * #15070 — a typed name that matches an existing connection holding a
 * different credential. Raised only when the caller opts in with
 * `rejectNameConflict`; routes map it to HTTP 409.
 */
export class ProviderConnectionNameConflictError extends Error {
  readonly status = 409;
  readonly code = "PROVIDER_CONNECTION_NAME_CONFLICT";

  constructor(name: string) {
    super(
      `A connection named "${name}" already exists for this provider with a different credential`
    );
    this.name = "ProviderConnectionNameConflictError";
  }
}

/**
 * #15070 — true when `row` and the incoming data both carry a comparable
 * credential and no comparable pair agrees. A pair (decrypted apiKey, web-session
 * credential key) only counts when BOTH sides carry it, so rows stored before a
 * field existed keep updating in place.
 */
function holdsDifferentCredential(
  row: JsonRecord,
  incomingApiKey: unknown,
  incomingProviderSpecificData: unknown
): boolean {
  const stored = decryptConnectionFields(toRecord(rowToCamel(row)));
  const pairs: Array<[string | null, string | null]> = [
    [toStringOrNull(incomingApiKey)?.trim() || null, toStringOrNull(stored.apiKey)?.trim() || null],
    [
      webSessionCredentialKey(incomingProviderSpecificData),
      webSessionCredentialKey(parseProviderSpecificData(row.provider_specific_data)),
    ],
  ];
  const comparable = pairs.filter(([incoming, existing]) => incoming && existing);
  return comparable.length > 0 && comparable.every(([incoming, existing]) => incoming !== existing);
}

export function assertNoNameConflict(
  rejectNameConflict: boolean,
  existing: JsonRecord | null | undefined,
  data: JsonRecord,
  normalizedProviderSpecificData: unknown
): void {
  // A row found by credential value holds the same credential, so only a name match can trip this.
  if (
    rejectNameConflict &&
    existing &&
    (data.authType === "apikey" || data.authType === "cookie") &&
    data.name &&
    existing.name === data.name &&
    holdsDifferentCredential(existing, data.apiKey, normalizedProviderSpecificData)
  ) {
    throw new ProviderConnectionNameConflictError(String(data.name));
  }
}
