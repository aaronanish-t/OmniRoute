// Simulate the dashboard pipeline on the real live payload:
// parseQuotaData -> computeAntigravityHeadline + computeAntigravityWindowSummaries
import { readFileSync } from "node:fs";
import {
  parseQuotaData,
  computeAntigravityHeadline,
  computeAntigravityWindowSummaries,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaParsing.ts";

const AGY_IDS = new Set(["acb7395b", "e6c4048", "19d78373", "f5098335"]);

const pl = JSON.parse(readFileSync("/tmp/pl.json", "utf8"));
const caches = pl.caches || {};
for (const [cid, entry] of Object.entries(caches)) {
  if (!AGY_IDS.has(cid.slice(0, 8))) continue;
  const quotas = parseQuotaData("antigravity", entry);
  const h = computeAntigravityHeadline(quotas);
  const w = computeAntigravityWindowSummaries(quotas);
  console.log(`\n== ${cid.slice(0, 8)} ==`);
  console.log(`headline: ${h ? `${h.usedPct.toFixed(1)}% used (${h.quota.name})` : "null"}`);
  console.log(
    `weekly:   ${w.weekly ? `${w.weekly.usedPct.toFixed(1)}% used — ${w.weekly.label}, resets ${w.weekly.resetAt}` : "null"}`
  );
  console.log(
    `fiveHour: ${w.fiveHour ? `${w.fiveHour.usedPct.toFixed(1)}% used — ${w.fiveHour.label}, resets ${w.fiveHour.resetAt}` : "null"}`
  );
}
