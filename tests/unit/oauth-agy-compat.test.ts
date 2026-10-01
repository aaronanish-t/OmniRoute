import assert from "node:assert/strict";
import test from "node:test";

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const { getProvider, resolveBrowserOAuthRedirectUri } =
  await import("../../src/lib/oauth/providers.ts");
const route = await import("../../src/app/api/oauth/[provider]/[action]/route.ts");
const { getProviderConnections } = await import("../../src/models/index.ts");

const originalFetch = globalThis.fetch;

test.before(async () => {
  await settingsDb.updateSettings({ requireLogin: false });
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
});

test("agy remains an OAuth alias for the single antigravity handler", () => {
  assert.strictEqual(getProvider("agy"), getProvider("antigravity"));

  const redirectUri = resolveBrowserOAuthRedirectUri("agy", "http://localhost:8080/callback", {
    ANTIGRAVITY_OAUTH_CLIENT_ID: "custom-client.apps.googleusercontent.com",
    ANTIGRAVITY_OAUTH_CLIENT_SECRET: "custom-secret",
    NEXT_PUBLIC_BASE_URL: "https://omniroute.example.test",
  });
  assert.equal(redirectUri, "https://omniroute.example.test/callback");
});

test("GET /api/oauth/agy/authorize still returns the Antigravity authorization URL", async () => {
  const response = await route.GET(new Request("http://localhost/api/oauth/agy/authorize"), {
    params: Promise.resolve({ provider: "agy", action: "authorize" }),
  } as never);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.authUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.equal(
    new URL(body.authUrl).searchParams.get("redirect_uri"),
    "http://localhost:8080/callback"
  );
});

test("POST /api/oauth/agy/exchange saves the new connection under antigravity", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return Response.json({
        access_token: "agy-access",
        refresh_token: "agy-refresh",
        expires_in: 3600,
      });
    }
    if (url.includes("userinfo")) return Response.json({ email: "agy@example.test" });
    if (url.includes("loadCodeAssist")) {
      return Response.json({
        cloudaicompanionProject: "agy-project",
        allowedTiers: [{ id: "legacy-tier", isDefault: true }],
      });
    }
    if (url.includes("onboardUser")) return Response.json({ done: true });
    throw new Error(`Unexpected OAuth fetch: ${url}`);
  }) as typeof fetch;

  const request = new Request("http://localhost/api/oauth/agy/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "agy-code", redirectUri: "http://localhost:8080/callback" }),
  });
  const response = await route.POST(request, {
    params: Promise.resolve({ provider: "agy", action: "exchange" }),
  } as never);

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.connection.provider, "antigravity");

  const savedConnections = await getProviderConnections({ provider: "antigravity" });
  assert.equal(savedConnections.length, 1);
  assert.equal(savedConnections[0].provider, "antigravity");
  assert.equal(savedConnections[0].email, "agy@example.test");
});
