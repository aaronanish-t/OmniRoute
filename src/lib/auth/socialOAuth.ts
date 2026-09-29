import { SignJWT } from "jose";
import { DASHBOARD_SESSION_CLAIM } from "@/shared/utils/dashboardSessionToken";
import { timingSafeCompare } from "@/shared/utils/timingSafeCompare";

export interface GoogleOAuthConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  redirectPath: string;
}

export interface GitHubOAuthConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  redirectPath: string;
}

/**
 * Derives the absolute origin for the incoming request, taking proxy headers into account.
 */
export function getRequestOrigin(request: Request): string {
  const forwardedProto = (request.headers.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const reqUrl = new URL(request.url);
  const scheme = forwardedProto === "https" || reqUrl.protocol === "https:" ? "https" : "http";
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0].trim() ||
    request.headers.get("host") ||
    request.headers.get("Host") ||
    reqUrl.host;
  return `${scheme}://${host}`;
}

/**
 * Checks whether the request requires secure cookies.
 */
export function isRequestSecure(request: Request): boolean {
  if (process.env.AUTH_COOKIE_SECURE === "true") return true;
  const forwardedProto = (request.headers.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const reqUrl = new URL(request.url);
  return forwardedProto === "https" || reqUrl.protocol === "https:";
}

/**
 * Resolves Google OAuth 2.0 configuration from settings with environment variable fallbacks.
 */
export function getGoogleOAuthConfig(settings: Record<string, unknown>): GoogleOAuthConfig {
  const clientId =
    (typeof settings.googleClientId === "string" && settings.googleClientId.trim()) ||
    process.env.AUTH_GOOGLE_CLIENT_ID?.trim() ||
    process.env.GOOGLE_CLIENT_ID?.trim() ||
    "";
  const clientSecret =
    (typeof settings.googleClientSecret === "string" && settings.googleClientSecret.trim()) ||
    process.env.AUTH_GOOGLE_CLIENT_SECRET?.trim() ||
    process.env.GOOGLE_CLIENT_SECRET?.trim() ||
    "";
  const redirectPath =
    (typeof settings.googleRedirectPath === "string" && settings.googleRedirectPath.trim()) ||
    "/api/auth/google/callback";
  const enabled =
    (settings.googleAuthEnabled === true || Boolean(clientId && clientSecret)) &&
    Boolean(clientId && clientSecret);

  return { enabled, clientId, clientSecret, redirectPath };
}

/**
 * Resolves GitHub OAuth configuration from settings with environment variable fallbacks.
 */
export function getGitHubOAuthConfig(settings: Record<string, unknown>): GitHubOAuthConfig {
  const clientId =
    (typeof settings.githubClientId === "string" && settings.githubClientId.trim()) ||
    process.env.AUTH_GITHUB_CLIENT_ID?.trim() ||
    process.env.GITHUB_CLIENT_ID?.trim() ||
    "";
  const clientSecret =
    (typeof settings.githubClientSecret === "string" && settings.githubClientSecret.trim()) ||
    process.env.AUTH_GITHUB_CLIENT_SECRET?.trim() ||
    process.env.GITHUB_CLIENT_SECRET?.trim() ||
    "";
  const redirectPath =
    (typeof settings.githubRedirectPath === "string" && settings.githubRedirectPath.trim()) ||
    "/api/auth/github/callback";
  const enabled =
    (settings.githubAuthEnabled === true || Boolean(clientId && clientSecret)) &&
    Boolean(clientId && clientSecret);

  return { enabled, clientId, clientSecret, redirectPath };
}

/**
 * Validates whether an email address is authorized against the allowlist.
 * If no allowlist is configured (empty or "*"), all authenticated users are permitted.
 * Supports exact email matches and wildcard domain matches (e.g. "*@example.com" or "@example.com").
 */
export function isEmailAllowed(
  email: string | null | undefined,
  allowedConfig?: unknown
): boolean {
  if (!email || typeof email !== "string") return false;
  const normalizedEmail = email.trim().toLowerCase();

  // Combine config from parameter with environment variable fallback
  let candidates: string[] = [];
  if (Array.isArray(allowedConfig)) {
    candidates = allowedConfig.filter((item): item is string => typeof item === "string");
  } else if (typeof allowedConfig === "string" && allowedConfig.trim().length > 0) {
    candidates = allowedConfig.split(",").map((s) => s.trim());
  }

  if (candidates.length === 0 && process.env.AUTH_ALLOWED_EMAILS) {
    candidates = process.env.AUTH_ALLOWED_EMAILS.split(",").map((s) => s.trim());
  }

  // Filter empty entries
  candidates = candidates.filter((item) => item.length > 0);

  // If no allowlist is defined, allow any valid authenticated email (open-source self-host default)
  if (candidates.length === 0 || candidates.includes("*")) {
    return true;
  }

  for (const allowed of candidates) {
    const normAllowed = allowed.toLowerCase().trim();
    if (normAllowed === normalizedEmail) {
      return true;
    }
    // Handle wildcard domain: *@domain.com or @domain.com
    if (normAllowed.startsWith("*@") && normalizedEmail.endsWith(normAllowed.slice(1))) {
      return true;
    }
    if (normAllowed.startsWith("@") && normalizedEmail.endsWith(normAllowed)) {
      return true;
    }
  }

  return false;
}

/**
 * Creates the standard 30-day dashboard session JWT.
 */
export async function createDashboardSessionJwt(secret: Uint8Array): Promise<string> {
  return new SignJWT({ [DASHBOARD_SESSION_CLAIM]: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("30d")
    .sign(secret);
}

export { timingSafeCompare };
