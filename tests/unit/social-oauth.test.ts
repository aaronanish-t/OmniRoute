import test from "node:test";
import assert from "node:assert/strict";
import {
  isEmailAllowed,
  getGoogleOAuthConfig,
  getGitHubOAuthConfig,
  getRequestOrigin,
  timingSafeCompare,
  createDashboardSessionJwt,
} from "../../src/lib/auth/socialOAuth.ts";
import { verifyDashboardSessionToken } from "../../src/shared/utils/dashboardSessionToken.ts";

test("timingSafeCompare properly checks string equality in constant time", () => {
  assert.equal(timingSafeCompare("abcdef123", "abcdef123"), true);
  assert.equal(timingSafeCompare("abcdef123", "abcdef124"), false);
  assert.equal(timingSafeCompare("abcdef123", "abcdef"), false);
  assert.equal(timingSafeCompare("", ""), true);
  assert.equal(timingSafeCompare(null, null), true);
  assert.equal(timingSafeCompare("a", null), false);
  assert.equal(timingSafeCompare(undefined, "b"), false);
});

test("isEmailAllowed validates emails against configured allowlists", () => {
  // Empty or undefined allowlist allows any email (self-hosted open default)
  assert.equal(isEmailAllowed("developer@example.com", []), true);
  assert.equal(isEmailAllowed("developer@example.com", undefined), true);
  assert.equal(isEmailAllowed("developer@example.com", "*"), true);

  // Exact matching with case insensitivity
  const allowedList = ["admin@company.com", "CTO@Company.com", "DevOps@CLOUD.io"];
  assert.equal(isEmailAllowed("admin@company.com", allowedList), true);
  assert.equal(isEmailAllowed("ADMIN@COMPANY.COM", allowedList), true);
  assert.equal(isEmailAllowed("cto@company.com", allowedList), true);
  assert.equal(isEmailAllowed("devops@cloud.io", allowedList), true);
  assert.equal(isEmailAllowed("stranger@company.com", allowedList), false);

  // Comma-separated string format
  const csvAllowed = "admin@example.com, test@example.com";
  assert.equal(isEmailAllowed("admin@example.com", csvAllowed), true);
  assert.equal(isEmailAllowed("test@example.com", csvAllowed), true);
  assert.equal(isEmailAllowed("other@example.com", csvAllowed), false);

  // Wildcard domain matching: *@domain.com or @domain.com
  const domainAllowed = ["*@trusted.org", "@corp.local"];
  assert.equal(isEmailAllowed("alice@trusted.org", domainAllowed), true);
  assert.equal(isEmailAllowed("bob@trusted.org", domainAllowed), true);
  assert.equal(isEmailAllowed("charlie@corp.local", domainAllowed), true);
  assert.equal(isEmailAllowed("hacker@untrusted.org", domainAllowed), false);

  // Invalid inputs
  assert.equal(isEmailAllowed("", allowedList), false);
  assert.equal(isEmailAllowed(null, allowedList), false);
  assert.equal(isEmailAllowed(undefined, allowedList), false);
});

test("getGoogleOAuthConfig resolves credentials from settings and env", () => {
  // From settings
  const settings = {
    googleAuthEnabled: true,
    googleClientId: "g-client-123",
    googleClientSecret: "g-secret-456",
    googleRedirectPath: "/custom/callback",
  };
  const config = getGoogleOAuthConfig(settings);
  assert.equal(config.enabled, true);
  assert.equal(config.clientId, "g-client-123");
  assert.equal(config.clientSecret, "g-secret-456");
  assert.equal(config.redirectPath, "/custom/callback");

  // Fallback to env
  process.env.AUTH_GOOGLE_CLIENT_ID = "env-g-client";
  process.env.AUTH_GOOGLE_CLIENT_SECRET = "env-g-secret";
  const envConfig = getGoogleOAuthConfig({});
  assert.equal(envConfig.enabled, true);
  assert.equal(envConfig.clientId, "env-g-client");
  assert.equal(envConfig.clientSecret, "env-g-secret");
  assert.equal(envConfig.redirectPath, "/api/auth/google/callback");
  delete process.env.AUTH_GOOGLE_CLIENT_ID;
  delete process.env.AUTH_GOOGLE_CLIENT_SECRET;
});

test("getGitHubOAuthConfig resolves credentials from settings and env", () => {
  // From settings
  const settings = {
    githubAuthEnabled: true,
    githubClientId: "gh-client-123",
    githubClientSecret: "gh-secret-456",
  };
  const config = getGitHubOAuthConfig(settings);
  assert.equal(config.enabled, true);
  assert.equal(config.clientId, "gh-client-123");
  assert.equal(config.clientSecret, "gh-secret-456");
  assert.equal(config.redirectPath, "/api/auth/github/callback");

  // Fallback to env
  process.env.AUTH_GITHUB_CLIENT_ID = "env-gh-client";
  process.env.AUTH_GITHUB_CLIENT_SECRET = "env-gh-secret";
  const envConfig = getGitHubOAuthConfig({});
  assert.equal(envConfig.enabled, true);
  assert.equal(envConfig.clientId, "env-gh-client");
  assert.equal(envConfig.clientSecret, "env-gh-secret");
  delete process.env.AUTH_GITHUB_CLIENT_ID;
  delete process.env.AUTH_GITHUB_CLIENT_SECRET;
});

test("getRequestOrigin extracts forwarded proto and host", () => {
  const req = new Request("http://internal-docker:3000/api/auth/google/login", {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "omniroute.example.com",
    },
  });
  const origin = getRequestOrigin(req);
  assert.equal(origin, "https://omniroute.example.com");

  const localReq = new Request("http://localhost:20128/api/auth/github/login");
  assert.equal(getRequestOrigin(localReq), "http://localhost:20128");
});

test("createDashboardSessionJwt mints a valid session token that passes verifyDashboardSessionToken", async () => {
  const testSecret = new TextEncoder().encode("super-secure-test-jwt-secret-at-least-32-chars");
  const jwt = await createDashboardSessionJwt(testSecret);

  assert.ok(jwt && typeof jwt === "string", "JWT must be a non-empty string");

  // Verifier requires matching secret and authenticated: true claim
  const payload = await verifyDashboardSessionToken(jwt, testSecret);
  assert.ok(payload !== null, "Session token must verify successfully");
  assert.equal(payload.authenticated, true, "Payload must carry authenticated: true");

  // Wrong secret must reject
  const wrongSecret = new TextEncoder().encode("wrong-secret-key-32-characters-long!!");
  const invalidPayload = await verifyDashboardSessionToken(jwt, wrongSecret);
  assert.equal(invalidPayload, null, "Wrong secret must fail verification");
});
