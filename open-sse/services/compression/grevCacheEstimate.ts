import { createHash } from "node:crypto";

interface PrefixSnapshot {
  fingerprints: string[];
  tokenCounts: number[];
}

const MAX_SESSIONS = 128;
const MAX_MESSAGES_PER_SESSION = 10_000;
const snapshots = new Map<string, PrefixSnapshot>();

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Estimates prompt tokens already present in the identical message prefix from
 * the previous request in this model/session. It is an estimate of potential KV
 * reuse, not proof the provider retained or reused those KV entries.
 */
export function prepareGrevCacheHitEstimate(
  sessionKey: string | null | undefined,
  messages: unknown,
  estimateMessageTokens: (message: unknown) => number
): { estimatedTokens: number; rememberSuccessfulRequest: () => void } {
  if (!sessionKey || !Array.isArray(messages) || messages.length > MAX_MESSAGES_PER_SESSION) {
    return { estimatedTokens: 0, rememberSuccessfulRequest: () => undefined };
  }

  const fingerprints: string[] = [];
  const tokenCounts: number[] = [];
  for (const message of messages) {
    const serialized = canonicalize(message);
    fingerprints.push(createHash("sha256").update(serialized).digest("hex"));
    const estimate = estimateMessageTokens(message);
    tokenCounts.push(Number.isFinite(estimate) ? Math.max(0, Math.floor(estimate)) : 0);
  }

  const previous = snapshots.get(sessionKey);
  let reusableTokens = 0;
  if (previous) {
    const commonLength = Math.min(previous.fingerprints.length, fingerprints.length);
    for (let index = 0; index < commonLength; index++) {
      if (previous.fingerprints[index] !== fingerprints[index]) break;
      reusableTokens += previous.tokenCounts[index] ?? 0;
    }
  }

  return {
    estimatedTokens: reusableTokens,
    rememberSuccessfulRequest: () => {
      snapshots.delete(sessionKey);
      snapshots.set(sessionKey, { fingerprints, tokenCounts });
      while (snapshots.size > MAX_SESSIONS) {
        const oldest = snapshots.keys().next().value;
        if (oldest === undefined) break;
        snapshots.delete(oldest);
      }
    },
  };
}

export function clearGrevCacheEstimateSnapshotsForTest(): void {
  snapshots.clear();
}
