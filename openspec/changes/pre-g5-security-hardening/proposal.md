# Proposal

## Why

The pen-test opens on 2027-01-11 and G5 is on 2027-01-22. Four known weaknesses sit under Open questions, all already reported by review seats. Each is something a pen-tester finds on the first day:

- The web app's resource policy is report-only, and no violation reaches anyone.
- The PDF renderer runs report HTML with JavaScript and network on.
- `POST /users/invitations` tells any registration-code holder whether an address has an account anywhere on the platform.
- `/auth/set-password` lets any session change the account's password, without the current one and without an application audit row.

Owner decision 2026-11-24: Open-questions step 2, options 1A and 2A.

## What Changes

- **Web content security policy enforced.** The resource directives move from `Content-Security-Policy-Report-Only` into the enforced policy:
  - `default-src`, `script-src`, `style-src`, `img-src`, `font-src`, `connect-src`;
  - `'unsafe-inline'` stays for scripts and styles; nonces are filed as a follow-up.

  The policy names a violation report endpoint through `report-uri`. The web also sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`, and the API `Cross-Origin-Resource-Policy: same-site`.
- **CSP report receiver.** A new public API endpoint `POST /api/v1/security/csp-reports`:
  - accepts both report formats;
  - is capped in body size;
  - has its own per-IP quota;
  - always answers 204;
  - logs a sanitised, structured warning: directive, blocked origin, page path; never a query string.

  Nothing is stored in the database.
- **PDF renderer isolated.** Every render page has JavaScript disabled, and every request the page makes is aborted. The templates need neither, so the output does not change.
- **Invitation refusals bounded and audited.** Every `email_unavailable` refusal of an invitation writes an `invite_refused` audit row (no address). Once an organisation reaches 5 refusals within an hour, every further invitation from it is refused with 429 `invite_refusals_exhausted` until the window passes, before any address is looked up. The remaining signal is documented as an accepted risk of D17 (one account per address).
- **Setting a password guarded.**
  - `/auth/set-password` serves only a session that an email link (invite or recovery) opened in this tab within the last hour. Any other visitor is told to use their email link, and no password field is shown.
  - Supabase Auth's reauthentication for a password change (`secure_password_change` / `security_update_password_require_reauthentication`) is switched on, locally and on hosted QA. A password change from a session older than 24 hours then needs the emailed nonce, which stops a stolen token calling Auth directly.
  - A password that was set writes a `password_set` audit row, through a new authenticated `POST /api/v1/me/password-set`.
- **Owner prerequisites, not code:**
  - Supabase Cloud custom SMTP (ACS) for the reauthentication email.
  - The check that the legacy anon/service_role JWT keys are disabled on Supabase Cloud.

## Capabilities

### New Capabilities

- `pdf-rendering`: how report HTML becomes a PDF safely. One isolated, bounded Chromium render, with no script execution and no network.
- `account-access`: the controls around giving someone an account and a password. Invitation refusal bounding and audit; who may set a password, reauthentication, and the password-set audit.

### Modified Capabilities

- `web-response-security`: the content security policy's resource directives become enforced (replacing "report-only until after QA round 2"). Violations are reported to a receiver. COOP/CORP join the headers every web response carries.

## Impact

- **Web:**
  - `apps/web/security-headers.mjs` and `next.config.test.mjs`;
  - `app/auth/set-password/*` and `app/auth/confirm/*`;
  - `lib/api.ts` (`recordPasswordSet`);
  - TR/EN catalogues;
  - e2e `security-headers`, `password-visibility` (the set-password cases) and `registration`.
- **API:**
  - `common/runtime-http.ts` (CORP, the report body parser and quota);
  - a new `security` module (CSP report controller);
  - `common/pdf-renderer.ts`;
  - `auth/access-admin.service.ts` (`inviteMember`);
  - a `me` password-set endpoint;
  - `AUDIT_ACTIONS` gains `invite_refused` and `password_set` (shared-types). No Prisma migration: `audit_log.action` is text.
- **Config:**
  - `supabase/config.toml` (`secure_password_change = true`, a reauthentication template);
  - `infra/scripts/auth_settings.py` (the pin flips to true); its parity test also asserts it is true.
  - Hosted QA needs the owner's Supabase SMTP settings before the deploy that flips the pin.
- **Docs:**
  - `docs/architecture/security.md` and `docs/architecture/observability.md`;
  - `docs/api/endpoints.md`;
  - the planning file. The four Open-questions entries close; the residuals are filed.
- **Out of scope:**
  - CSP nonces (dropping `'unsafe-inline'`);
  - a stored or alerted violation log;
  - changing D17;
  - an in-app "change password" screen for signed-in users.
