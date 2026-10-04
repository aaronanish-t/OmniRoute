import { normalizeUsageQuotaKey } from "../../src/lib/usage/providerLimits/quotaNormalize.ts";

for (const k of [
  "gemini_weekly",
  "claude_gpt_weekly",
  "gemini_5h",
  "claude_gpt_5h",
  "gemini-3.1-pro-low",
]) {
  console.log(k, "=>", normalizeUsageQuotaKey("antigravity", k));
}
