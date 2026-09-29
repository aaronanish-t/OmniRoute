import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyDashboardSessionToken } from "../../src/shared/utils/dashboardSessionToken.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-social-auth-test-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "test-jwt-secret-social-oauth-routes-32chars";

// Dynamic imports matching repo's auth test harness pattern
// @ts-ignore
const core = await import("../../src/lib/db/core.ts");
// @ts-ignore
const { updateSettings } = await import("@/lib/db/settings");
// @ts-ignore
const googleLoginRoute = await import("../../src/app/api/auth/google/login/route.ts");
// @ts-ignore
const googleCallbackRoute = await import("../../src/app/api/auth/google/callback/route.ts");
// @ts-ignore
const githubLoginRoute = await import("../../src/app/api/auth/github/login/route.ts");
// @ts-ignore
const githubCallbackRoute = await import("../../src/app/api/auth/github/callback/route.ts");

interface CapturedCookie {
  value: string;
  options?: Record<string, unknown>;
}

let capturedCookies: Record<string, CapturedCookie> = {};

function makeTestCookieStore() {
  return {
    get(name: string) {
      const c = capturedCookies[name];
      return c ? { value: c.value } : undefined;
    },
    set(name: string, value: string, options?: Record<string, unknown>) {
      capturedCookies[name] = { value, options };
    },
    delete(name: string) {
      delete capturedCookies[name];
    },
  };
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  capturedCookies = {};
}

test.beforeEach(async () => {
  await resetStorage();
  googleCallbackRoute.googleCallbackInternals.getCookieStore = async () => makeTestCookieStore() as any;
  githubCallbackRoute.githubCallbackInternals.getCookieStore = async () => makeTestCookieStore() as any;
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("Google Login: returns 400 when not configured", async () => {
  await updateSettings({ googleAuthEnabled: false, googleClientId: "", googleClientSecret: "" });
  const req = new Request("http://localhost/api/auth/google/login");
  const res = await googleLoginRoute.GET(req);
  assert.equal(res.status, 400);
});

test("Google Login: redirects to accounts.google.com with valid params and sets state cookie", async () => {
  await updateSettings({
    googleAuthEnabled: true,
    googleClientId: "g-test-client-id",
    googleClientSecret: "g-test-client-secret",
    googleRedirectPath: "/api/auth/google/callback",
  });

  const req = new Request("http://localhost/api/auth/google/login", {
    headers: { "x-forwarded-proto": "https", host: "app.example.com" },
  });
  const res = await googleLoginRoute.GET(req);
  assert.equal(res.status, 307);

  const location = res.headers.get("location");
  assert.ok(location);
  const authUrl = new URL(location);
  assert.equal(authUrl.origin, "https://accounts.google.com");
  assert.equal(authUrl.pathname, "/o/oauth2/v2/auth");
  assert.equal(authUrl.searchParams.get("client_id"), "g-test-client-id");
  assert.equal(authUrl.searchParams.get("redirect_uri"), "https://app.example.com/api/auth/google/callback");
  assert.equal(authUrl.searchParams.get("response_type"), "code");
  assert.ok(authUrl.searchParams.get("state"));

  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie?.includes("google_oauth_state="));
});

test("Google Callback: rejects missing or mismatched state", async () => {
  await updateSettings({
    googleAuthEnabled: true,
    googleClientId: "g-test-client-id",
    googleClientSecret: "g-test-client-secret",
  });

  // Missing state
  const req1 = new Request("http://localhost/api/auth/google/callback?code=123");
  const res1 = await googleCallbackRoute.GET(req1);
  assert.equal(res1.status, 307);
  assert.ok(res1.headers.get("location")?.includes("error=missing_code"));

  // Mismatched state
  capturedCookies["google_oauth_state"] = { value: "expected-state-value" };
  const req2 = new Request("http://localhost/api/auth/google/callback?code=123&state=wrong-state");
  const res2 = await googleCallbackRoute.GET(req2);
  assert.equal(res2.status, 307);
  assert.ok(res2.headers.get("location")?.includes("error=invalid_state"));
});

test("Google Callback: exchanges code, checks allowlist, and sets auth_token cookie", async () => {
  await updateSettings({
    googleAuthEnabled: true,
    googleClientId: "g-test-client-id",
    googleClientSecret: "g-test-client-secret",
    authAllowedEmails: ["allowed@company.com"],
  });

  const stateVal = "correct-test-state-999";
  capturedCookies["google_oauth_state"] = { value: stateVal };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input.toString();
    if (urlStr.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "mock-google-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("googleapis.com/oauth2/v3/userinfo")) {
      return new Response(
        JSON.stringify({
          email: "allowed@company.com",
          email_verified: true,
          name: "Test Admin",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not Found", { status: 404 });
  }) as any;

  try {
    const req = new Request(`http://localhost/api/auth/google/callback?code=auth-code-123&state=${stateVal}`, {
      headers: { host: "app.example.com" },
    });
    const res = await googleCallbackRoute.GET(req);
    assert.equal(res.status, 307);
    assert.equal(res.headers.get("location"), "http://app.example.com/dashboard");

    // auth_token session cookie must be set
    const sessionCookie = capturedCookies["auth_token"];
    assert.ok(sessionCookie?.value, "auth_token cookie must be set");

    // Verify minted token passes verifyDashboardSessionToken
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const verified = await verifyDashboardSessionToken(sessionCookie.value, secret);
    assert.ok(verified !== null);
    assert.equal(verified.authenticated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google Callback: blocks email not in allowlist", async () => {
  await updateSettings({
    googleAuthEnabled: true,
    googleClientId: "g-test-client-id",
    googleClientSecret: "g-test-client-secret",
    authAllowedEmails: ["admin@company.com"],
  });

  const stateVal = "correct-test-state-888";
  capturedCookies["google_oauth_state"] = { value: stateVal };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const urlStr = typeof input === "string" ? input : input.toString();
    if (urlStr.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "mock-google-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr.includes("googleapis.com/oauth2/v3/userinfo")) {
      return new Response(
        JSON.stringify({
          email: "intruder@other.com",
          email_verified: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not Found", { status: 404 });
  }) as any;

  try {
    const req = new Request(`http://localhost/api/auth/google/callback?code=auth-code-123&state=${stateVal}`);
    const res = await googleCallbackRoute.GET(req);
    assert.equal(res.status, 307);
    assert.ok(res.headers.get("location")?.includes("error=unauthorized_email"));
    assert.equal(capturedCookies["auth_token"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub Login: redirects to github.com/login/oauth/authorize and sets state cookie", async () => {
  await updateSettings({
    githubAuthEnabled: true,
    githubClientId: "gh-test-client-id",
    githubClientSecret: "gh-test-client-secret",
  });

  const req = new Request("http://localhost/api/auth/github/login", {
    headers: { host: "myhub.test" },
  });
  const res = await githubLoginRoute.GET(req);
  assert.equal(res.status, 307);

  const location = res.headers.get("location");
  assert.ok(location);
  const authUrl = new URL(location);
  assert.equal(authUrl.origin, "https://github.com");
  assert.equal(authUrl.pathname, "/login/oauth/authorize");
  assert.equal(authUrl.searchParams.get("client_id"), "gh-test-client-id");
  assert.equal(authUrl.searchParams.get("redirect_uri"), "http://myhub.test/api/auth/github/callback");
  assert.ok(authUrl.searchParams.get("state"));

  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie?.includes("github_oauth_state="));
});

test("GitHub Callback: exchanges code, resolves verified email, and mints session", async () => {
  await updateSettings({
    githubAuthEnabled: true,
    githubClientId: "gh-test-client-id",
    githubClientSecret: "gh-test-client-secret",
    authAllowedEmails: ["github-user@domain.com"],
  });

  const stateVal = "github-state-xyz-777";
  capturedCookies["github_oauth_state"] = { value: stateVal };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const urlStr = typeof input === "string" ? input : input.toString();
    if (urlStr.includes("github.com/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "mock-gh-access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (urlStr === "https://api.github.com/user") {
      return new Response(
        JSON.stringify({
          login: "octocat",
          id: 1,
          name: "The Octocat",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (urlStr === "https://api.github.com/user/emails") {
      return new Response(
        JSON.stringify([
          { email: "unverified@domain.com", primary: false, verified: false },
          { email: "github-user@domain.com", primary: true, verified: true },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not Found", { status: 404 });
  }) as any;

  try {
    const req = new Request(`http://localhost/api/auth/github/callback?code=gh-code-456&state=${stateVal}`, {
      headers: { host: "myhub.test" },
    });
    const res = await githubCallbackRoute.GET(req);
    assert.equal(res.status, 307);
    assert.equal(res.headers.get("location"), "http://myhub.test/dashboard");

    const sessionCookie = capturedCookies["auth_token"];
    assert.ok(sessionCookie?.value, "auth_token cookie must be set");

    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const verified = await verifyDashboardSessionToken(sessionCookie.value, secret);
    assert.ok(verified !== null);
    assert.equal(verified.authenticated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
