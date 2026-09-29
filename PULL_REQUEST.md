## Summary

Adds native **Google OAuth 2.0** ("Continue with Google") and **GitHub OAuth** ("Continue with GitHub") authentication support to the OmniRoute management dashboard.

### Highlights:
- **Zero New Dependencies:** Utilizes native Web standards (`fetch`, `crypto`, `URL`) and the existing `jose` library already bundled in OmniRoute.
- **Strict Security & CSRF Defense:** Uses cryptographically secure random `state` nonces stored in short-lived HTTP-only cookies (`maxAge: 600`) and validated via `timingSafeCompare` (constant-time equality) to defeat timing attacks (GHSA-7434-6q4c-33fh).
- **Verified Identity Enforcement:** Requires `email_verified: true` for Google accounts and checks for verified primary emails for GitHub accounts before authorizing session issuance.
- **Configurable Access Governance:** Supports `AUTH_ALLOWED_EMAILS` (comma-separated email list, domain wildcards like `*@company.com`, or GitHub usernames). Defaults to permissive if unconfigured (matching self-hosted single-admin expectations).
- **Session Minting Parity:** Mints the exact same 30-day `auth_token` JWT carrying `authenticated: true` signed with `JWT_SECRET` through `verifyDashboardSessionToken` / `createDashboardSessionJwt`.
- **UI/UX Polish:** Adds responsive, accessible Google and GitHub branded SVG buttons to `src/app/login/page.tsx` with localized strings (`en`, `pt-BR`) and an optional separator (`or` / `ou`), fully preserving password login and enterprise OIDC coexistence.
- **Opt-in Password Disabling:** Supports `AUTH_DISABLE_PASSWORD_LOGIN=true` when operators wish to enforce SSO-only access.

---

## Related Issues

- Related to #10889 (OIDC SSO for enterprise IdPs)
- Related to #11288 (Multi-tenant organizations layer)

---

## Validation

- [x] Change type: UI / routing / DB / i18n
- [x] Focused tests and category gates from the golden path
- [x] Production-code changes include new automated tests in this PR
- [x] Verified against `#13298` dashboard session verifier source guard: zero regressions

---

## Tests Added Or Updated

- `tests/unit/social-oauth.test.ts`:
  - `timingSafeCompare` constant-time string comparison
  - `isEmailAllowed` allowlist parsing, wildcard matching, case-insensitivity
  - `getGoogleOAuthConfig` and `getGitHubOAuthConfig` environment and settings resolution
  - `getRequestOrigin` host and forwarded proto derivation
  - `createDashboardSessionJwt` minting and validation through `verifyDashboardSessionToken`
- `tests/unit/social-oauth-routes.test.ts`:
  - `GET /api/auth/google/login`: Configuration guard, authorization URL construction, and state cookie setting
  - `GET /api/auth/google/callback`: Code exchange, state mismatch defense, email allowlist blocking, and session issuance
  - `GET /api/auth/github/login`: Redirect to GitHub authorize and state cookie generation
  - `GET /api/auth/github/callback`: Token exchange, verified email resolution, allowlist filtering, and session cookie minting
- `tests/unit/dashboard-session-verifier-source-guard.test.ts`: Re-validated 8/8 tests passing.

---

## Coverage Notes

- All new helper logic in `src/lib/auth/socialOAuth.ts` is 100% covered by unit tests.
- All new API routes under `src/app/api/auth/google/` and `src/app/api/auth/github/` are covered with simulated provider responses and cookie capture test seams (`*Internals.getCookieStore`).
- Zero modifications to core proxy routing or inference paths.

---

## Reviewer Notes

- **Environment Variables Supported:**
  - `AUTH_GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_ID`
  - `AUTH_GOOGLE_CLIENT_SECRET` / `GOOGLE_CLIENT_SECRET`
  - `AUTH_GITHUB_CLIENT_ID` / `GITHUB_CLIENT_ID`
  - `AUTH_GITHUB_CLIENT_SECRET` / `GITHUB_CLIENT_SECRET`
  - `AUTH_ALLOWED_EMAILS` (optional comma-separated list of allowed emails or wildcard domains)
  - `AUTH_DISABLE_PASSWORD_LOGIN` (optional boolean, `true` disables password login form)
- Settings can also be populated dynamically via SQLite `settings` table (`googleClientId`, `googleClientSecret`, `githubClientId`, `githubClientSecret`), where secrets are automatically encrypted via `STORAGE_ENCRYPTION_KEY`.
