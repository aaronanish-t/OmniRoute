// Simulate the exact dashboard pipeline on the real live payload:
// parseQuotaData(provider, cacheEntry) -> computeAntigravityHeadline(quotas)
import { readFileSync } from "node:fs";
import {
  parseQuotaData,
  computeAntigravityHeadline,
  isAntigravityHeadlineProvider,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaParsing.ts";

const AGY_IDS = new Set(["acb7395b", "e6c4048", "19d78373", "f5098335"]); // known antigravity/agy ids (prefix)

const pl = JSON.parse(readFileSync("/tmp/pl.json", "utf8"));
const caches = pl.caches || {};
for (const [cid, entry] of Object.entries(caches)) {
  const provider = AGY_IDS.has(cid.slice(0, 8)) ? "antigravity" : null;
  if (!provider) continue;
  console.log(`\n===== ${cid.slice(0, 8)} (treated as antigravity) =====`);
  const quotas = parseQuotaData(provider, entry);
  console.log(`parsed rows: ${quotas.length}`);
  for (const q of quotas.slice(0, 8)) {
    console.log(
      `  name=${q.name} used=${q.used} total=${q.total} rem%=${q.remainingPercentage} pctOnly=${q.isPercentageOnly ?? q.fractionReported} reset=${q.resetAt}`
    );
  }
  console.log(`isHeadlineProvider: ${isAntigravityHeadlineProvider(provider)}`);
  const h = computeAntigravityHeadline(quotas);
  console.log(
    `headline: ${h ? `label=${h.quota.name} usedPct=${h.usedPct.toFixed(2)} remainingPct=${h.remainingPct.toFixed(2)} resetAt=${h.resetAt}` : "NULL — would NOT render"}`
  );
}
