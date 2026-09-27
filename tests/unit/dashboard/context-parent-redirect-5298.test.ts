import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_IDS } from "../../../open-sse/services/compression/engineCatalog.ts";

// #5298: `/dashboard/context` had only sub-routes and no parent page, so RSC
// prefetches of the bare parent 404'd. The new parent page redirects to a
// canonical sub-route; this guards the pure route resolver it uses.
const { resolveContextRoute } =
  await import("../../../src/app/(dashboard)/dashboard/context/page.tsx");

test("#5298: resolveContextRoute defaults the bare parent to the canonical sub-route", () => {
  assert.equal(resolveContextRoute(undefined), "/dashboard/context/settings");
  assert.equal(resolveContextRoute(""), "/dashboard/context/settings");
});

test("#5298: resolveContextRoute maps a known tab to its sub-route", () => {
  assert.equal(resolveContextRoute("ultra"), "/dashboard/context/ultra");
  assert.equal(resolveContextRoute("session-dedup"), "/dashboard/context/session-dedup");
  assert.equal(resolveContextRoute("llmlingua"), "/dashboard/context/llmlingua");
  assert.equal(resolveContextRoute("codex-responses"), "/dashboard/context/codex-responses");
  assert.equal(resolveContextRoute("relevance"), "/dashboard/context/relevance");
  assert.equal(resolveContextRoute("omniglyph"), "/dashboard/context/omniglyph");
});

test("every catalog compression engine has a redirect target and detail page", () => {
  for (const engineId of ENGINE_IDS) {
    assert.equal(resolveContextRoute(engineId), `/dashboard/context/${engineId}`);
    assert.equal(
      existsSync(join(process.cwd(), "src", "app", "(dashboard)", "dashboard", "context", engineId, "page.tsx")),
      true,
      `${engineId} is linked by CompressionPanel but has no detail page`
    );
  }
});

test("#5298: resolveContextRoute falls back to the default for an unknown tab", () => {
  assert.equal(resolveContextRoute("bogus"), "/dashboard/context/settings");
});
