import { NextResponse } from "next/server";
import { getCachedSettings } from "@/lib/db/readCache";
import { updateSettings } from "@/lib/db/settings";
import { cookies } from "next/headers";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import { getDashboardJwtSecret } from "@/shared/utils/dashboardSessionToken";
import {
  createDashboardSessionJwt,
  getGoogleOAuthConfig,
  getRequestOrigin,
  isEmailAllowed,
  isRequestSecure,
  timingSafeCompare,
} from "@/lib/auth/socialOAuth";

export const googleCallbackInternals = {
  getCookieStore: cookies,
};

/**
 * GET /api/auth/google/callback
 * Handles the Google OAuth 2.0 authorization code exchange and sets the dashboard session cookie.
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

  const cookieStore = await googleCallbackInternals.getCookieStore();
  const storedState = cookieStore.get("google_oauth_state")?.value;

  if (!storedState || !timingSafeCompare(storedState, returnedState)) {
    return NextResponse.redirect(new URL("/login?error=invalid_state", origin));
  }

  // Clear state cookie
  cookieStore.set("google_oauth_state", "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  const settings = await getCachedSettings();
  const config = getGoogleOAuthConfig(settings);

  if (!config.enabled || !config.clientId || !config.clientSecret) {
    return NextResponse.redirect(new URL("/login?error=not_configured", origin));
  }

  const redirectUri = `${origin}${config.redirectPath}`;

  // Exchange authorization code for tokens
  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  let tokenResp: Response;
  try {
    tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString(),
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

  // Fetch Google User Profile
  let userInfoResp: Response;
  try {
    userInfoResp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return NextResponse.redirect(new URL("/login?error=user_info_failed", origin));
  }

  if (!userInfoResp.ok) {
    return NextResponse.redirect(new URL("/login?error=user_info_failed", origin));
  }

  let userInfo: any;
  try {
    userInfo = await userInfoResp.json();
  } catch {
    return NextResponse.redirect(new URL("/login?error=user_info_failed", origin));
  }

  const email = typeof userInfo?.email === "string" ? userInfo.email.trim().toLowerCase() : "";
  const emailVerified = userInfo?.email_verified === true;

  if (!email || !emailVerified) {
    return NextResponse.redirect(new URL("/login?error=email_not_verified", origin));
  }

  // Validate against allowlist
  const allowed = isEmailAllowed(email, settings.authAllowedEmails);
  if (!allowed) {
    logAuditEvent({
      action: "auth.login.google.unauthorized",
      actor: email,
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "failed",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: { email, reason: "email_not_in_allowlist" },
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
    action: "auth.login.google.success",
    actor: email,
    target: "dashboard-auth",
    resourceType: "auth_session",
    status: "success",
    ipAddress: auditContext.ipAddress || undefined,
    requestId: auditContext.requestId,
    metadata: { email },
  });

  return NextResponse.redirect(`${origin}/dashboard`);
}
