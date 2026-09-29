import { NextResponse } from "next/server";
import { getCachedSettings } from "@/lib/db/readCache";
import { updateSettings } from "@/lib/db/settings";
import { cookies } from "next/headers";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import { getDashboardJwtSecret } from "@/shared/utils/dashboardSessionToken";
import {
  createDashboardSessionJwt,
  getGitHubOAuthConfig,
  getRequestOrigin,
  isEmailAllowed,
  isRequestSecure,
  timingSafeCompare,
} from "@/lib/auth/socialOAuth";

export const githubCallbackInternals = {
  getCookieStore: cookies,
};

/**
 * GET /api/auth/github/callback
 * Handles the GitHub OAuth authorization code exchange and sets the dashboard session cookie.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const origin = getRequestOrigin(request);
  const auditContext = getAuditRequestContext(request as any);

  if (!code || !returnedState) {
    return NextResponse.redirect(new URL("/login?error=missing_code", origin));
  }

  const cookieStore = await githubCallbackInternals.getCookieStore();
  const storedState = cookieStore.get("github_oauth_state")?.value;

  if (!storedState || !timingSafeCompare(storedState, returnedState)) {
    return NextResponse.redirect(new URL("/login?error=invalid_state", origin));
  }

  // Clear state cookie
  cookieStore.set("github_oauth_state", "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  const settings = await getCachedSettings();
  const config = getGitHubOAuthConfig(settings);

  if (!config.enabled || !config.clientId || !config.clientSecret) {
    return NextResponse.redirect(new URL("/login?error=not_configured", origin));
  }

  const redirectUri = `${origin}${config.redirectPath}`;

  // Exchange authorization code for access token
  let tokenResp: Response;
  try {
    tokenResp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return NextResponse.redirect(new URL("/login?error=token_exchange", origin));
  }

  if (!tokenResp.ok) {
    return NextResponse.redirect(new URL("/login?error=token_exchange", origin));
  }

  let tokenData: any;
  try {
    tokenData = await tokenResp.json();
  } catch {
    return NextResponse.redirect(new URL("/login?error=token_response", origin));
  }

  const accessToken = typeof tokenData?.access_token === "string" ? tokenData.access_token : undefined;
  if (!accessToken) {
    return NextResponse.redirect(new URL("/login?error=token_response", origin));
  }

  // Fetch GitHub User Profile
  let userProfile: any = null;
  try {
    const userResp = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "OmniRoute-OAuth",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (userResp.ok) {
      userProfile = await userResp.json();
    }
  } catch {
    // Non-fatal if emails fetch succeeds
  }

  // Fetch GitHub User Emails (for verified and primary email resolution)
  let userEmails: any[] = [];
  try {
    const emailsResp = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "OmniRoute-OAuth",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (emailsResp.ok) {
      userEmails = await emailsResp.json();
    }
  } catch {
    // Fall back to profile email
  }

  // Resolve verified email
  let resolvedEmail = "";
  if (Array.isArray(userEmails) && userEmails.length > 0) {
    const primaryVerified = userEmails.find((e: any) => e.primary && e.verified);
    if (primaryVerified && typeof primaryVerified.email === "string") {
      resolvedEmail = primaryVerified.email.trim().toLowerCase();
    } else {
      const anyVerified = userEmails.find((e: any) => e.verified);
      if (anyVerified && typeof anyVerified.email === "string") {
        resolvedEmail = anyVerified.email.trim().toLowerCase();
      }
    }
  }

  if (!resolvedEmail && typeof userProfile?.email === "string") {
    resolvedEmail = userProfile.email.trim().toLowerCase();
  }

  if (!resolvedEmail) {
    return NextResponse.redirect(new URL("/login?error=email_not_verified", origin));
  }

  // Validate against allowlist (email or github username)
  const isAllowedByEmail = isEmailAllowed(resolvedEmail, settings.authAllowedEmails);
  const githubUsername = typeof userProfile?.login === "string" ? userProfile.login.toLowerCase() : "";
  const isAllowedByUsername = githubUsername ? isEmailAllowed(githubUsername, settings.authAllowedEmails) : false;

  if (!isAllowedByEmail && !isAllowedByUsername) {
    logAuditEvent({
      action: "auth.login.github.unauthorized",
      actor: resolvedEmail,
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "failed",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: { email: resolvedEmail, githubUsername, reason: "not_in_allowlist" },
    });
    return NextResponse.redirect(new URL("/login?error=unauthorized_email", origin));
  }

  // First successful login completes setup
  try {
    await updateSettings({ setupComplete: true });
  } catch {
    // non-fatal
  }

  const secret = getDashboardJwtSecret();
  if (!secret) {
    return NextResponse.redirect(new URL("/login?error=server_misconfigured", origin));
  }

  const useSecureCookie = isRequestSecure(request);
  const jwt = await createDashboardSessionJwt(secret);

  cookieStore.set("auth_token", jwt, {
    httpOnly: true,
    secure: useSecureCookie,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  logAuditEvent({
    action: "auth.login.github.success",
    actor: resolvedEmail,
    target: "dashboard-auth",
    resourceType: "auth_session",
    status: "success",
    ipAddress: auditContext.ipAddress || undefined,
    requestId: auditContext.requestId,
    metadata: { email: resolvedEmail, githubUsername },
  });

  return NextResponse.redirect(`${origin}/dashboard`);
}
