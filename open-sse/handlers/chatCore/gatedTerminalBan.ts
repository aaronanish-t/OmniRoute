import { shouldIsolateProbeFailures } from "@/shared/utils/probeOrigin";
import { writeTerminalStatus } from "@/shared/utils/terminalStatus";
import { maybeAutoDisableBannedAccount } from "@/sse/services/autoDisableBannedAccount";

/**
 * chatCore leaf for the two terminal-ban classifications that share one shape:
 * FORBIDDEN (testStatus=banned) and ACCOUNT_DEACTIVATED (testStatus=deactivated).
 *
 * #14853 invariant: record the terminal testStatus for selection skip + alerts,
 * but NEVER ungated-flip isActive on a ban-looking flap. Permanent deactivation
 * is opt-in only, gated behind autoDisableBannedAccounts (+ scope) via
 * maybeAutoDisableBannedAccount — the same gate auth.ts uses. Probe-origin
 * failures (dashboard test-all) are recorded but never deactivate (#9817),
 * unless the operator opts into probeCanDisable.
 */
export async function recordGatedBanTerminalStatus(params: {
  connectionId: string;
  testStatus: "banned" | "deactivated";
  errorType: string;
  statusCode: number;
  persistentMessage: string;
  provider?: string | null;
  authType?: string | null;
  connectionProvider?: string | null;
}): Promise<void> {
  const probeIsolated = await shouldIsolateProbeFailures();
  await writeTerminalStatus(
    params.connectionId,
    {
      testStatus: params.testStatus,
      lastError: params.persistentMessage,
      lastErrorType: params.errorType,
      errorCode: String(params.statusCode),
    },
    probeIsolated ? "probe" : "production"
  );
  if (probeIsolated) {
    console.warn(
      `[provider] Node ${params.connectionId} probe ${params.errorType} (${params.statusCode}) -- connection stays active`
    );
    return;
  }
  await maybeAutoDisableBannedAccount({
    connectionId: params.connectionId,
    provider: params.provider,
    authType: params.authType,
    connectionProvider: params.connectionProvider,
    permanent: true,
  });
  const label = params.testStatus === "banned" ? "banned" : "account deactivated";
  console.warn(
    `[provider] Node ${params.connectionId} ${label} (${params.statusCode}) -- testStatus=${params.testStatus}; isActive gated by autoDisableBannedAccounts`
  );
}
