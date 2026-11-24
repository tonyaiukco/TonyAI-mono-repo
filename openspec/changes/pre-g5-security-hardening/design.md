# Design

## Context

See `proposal.md` for the why.

**Web headers.**
- `apps/web/security-headers.mjs` builds headers once per image. `NEXT_PUBLIC_*` values are inlined at build, so every image is bound to its hosts.
- Enforced today: `frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'`.
- `reportOnlyPolicy(env)` already holds the resource directives. Its `connect-src` is `'self'` plus the API, Supabase and Sentry origins.
- No report endpoint exists. `e2e/security-headers.spec.ts` already walks the pilot screens and fails on any console CSP message.
- The API sets its own headers by hand in `common/runtime-http.ts` (no helmet). Every request passes an IP quota (`RATE_IP_PER_MINUTE`) and then route-group quotas.

**PDF.**
- `common/pdf-renderer.ts` launches one Chromium. Each render is `newPage()` → `setContent(html, { waitUntil: 'load' })` → `createPDFStream`, with no JavaScript or request controls.
- The process is bounded by a single render owner, a process-group kill on `PDF_TIMEOUT_MS`, and `REPORT_MAX_BYTES`.
- Templates (`reports/report-html.ts`, `report-issuances/issuance-html.ts`) contain no script, image, link or `url(` reference.

**Invitations.**
- `AccessAdminService.inviteMember` takes the tenant advisory lock (`lockAndReadActor` → `lockTenantAdmin`), checks subsidiaries, then looks the address up platform-wide. A hit, or a P2002 race on the unique index, throws `EmailUnavailableError` (409).
- The thrown error rolls the transaction back, so nothing about a refusal survives today.
- `audit_log.action` is text, and `@@index([organisationId, createdAt])` exists.

**Set-password.**
- `/auth/set-password` is a public path that offers the form to any session, and it takes `flow` from the query string.
- `supabase/config.toml` has `secure_password_change = false`. `infra/scripts/auth_settings.py` pins `security_update_password_require_reauthentication: False` and fails the deploy readback on drift.
- No application audit row exists for a password.

## Goals / Non-Goals

**Goals:**
- Every resource directive enforced, with violations visible in the API's logs.
- A renderer in which report HTML can neither run code nor reach the network.
- The invite oracle bounded to a few answers per organisation per hour, and every probe on the audit trail.
- A password set only from a fresh email-link session in this tab; Auth refuses an older session without a nonce; every set password audited.

**Non-Goals:**
- Nonces or hashes in `script-src` / `style-src`. Next's inline bootstrap and the chart's injected style need `'unsafe-inline'` until a nonce pipeline exists; filed under Open questions.
- Storing, counting or alerting on violation reports.
- Changing D17, or hiding the refusal itself.
- A change-password screen for a signed-in user.

## Decisions

### 1. One enforced policy, reports to the API

- **The policy.** Merge `reportOnlyPolicy` into the enforced policy and stop sending `Content-Security-Policy-Report-Only`.
- **Reporting.** Add `report-uri <api>/security/csp-reports`, and no `report-to` or `Reporting-Endpoints`. *(Changed during apply, measured.)* On a local page, headless Chrome posted a `report-uri` report at once. With `report-to` present, alone or beside `report-uri`, it posted nothing within 100 s, because Chrome then ignores `report-uri` and queues the report in its Reporting API. Firefox and Safari post `report-uri` too. The receiver still reads the Reporting API's format, so adding `report-to` later needs no API change. The API origin comes from the same `NEXT_PUBLIC_API_BASE_URL` the policy already reads. Without one (a bare local build), the reporting parts are omitted rather than pointed at a guess.
- **Cross-origin headers.**
  - Web: `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.
  - API: `Cross-Origin-Resource-Policy: same-site`. The web's CORS fetches are unaffected, since CORP governs no-cors loads. Evidence opens by top-level navigation to a Storage signed URL, which neither CORP nor CSP governs.
- **Alternatives considered.**
  - *Keep the policy report-only and add only the receiver.* Rejected: the spec date for enforcement was "after QA round 2, before the pen-test", which is now.
  - *Receiver as a Next route handler.* Rejected: `proxy.ts` sends every non-public path to `/login`, the web has no rate limiter, and the API already has quotas, body caps and structured logs.

### 2. The report receiver

- **Route and limits.** `SecurityReportsController`: `@Public() POST /api/v1/security/csp-reports`, `@HttpCode(204)`.
  - Its own body parser for `application/csp-report`, `application/reports+json` and `application/json`, capped at 16 KiB. Over the cap answers 413 from the parser.
  - A per-IP quota of its own, `CSP_REPORT_PER_IP_PER_MINUTE` (30), on top of the IP quota, set in code like the declaration's body cap rather than by an environment value. A public route takes no user's group quota, so a flood cannot spend anyone's WRITE budget, and no runtime-limit mirror (Terraform, `runtime-limits.json`) has to change. *(Changed during apply: the first draft named an environment value.)*
  - Another media type is refused 415 by the existing admission check; the receiver's own media types are admitted only on its route.
- **Parsing.** Both formats are reduced to `{ directive, blockedOrigin, pagePath, disposition }`:
  - `blockedOrigin` is `new URL(blocked).origin`, or the keyword (`inline`, `eval`, `data`) when it is not a URL.
  - `pagePath` is the pathname only.
  - Each field is truncated at 200 characters.
  - At most 10 reports per body are logged.
- **Output.** One `Logger.warn` line per report, as JSON. It reaches App Insights through the container console logs (`docs/architecture/observability.md`).
- **Failure handling.** Any parse failure is swallowed, and the answer is still 204. A reporter learns nothing, and a broken report never shows as a 500.

### 3. Renderer isolation per page

- In `render`, after `newPage()`:
  - `await page.setJavaScriptEnabled(false)`;
  - `await page.setRequestInterception(true)`;
  - `page.on('request', r => r.abort('blockedbyclient'))`.
- `setContent` loads the document itself without a request event, so only sub-resources are aborted.
- Launch arguments gain no network flags: the per-page abort is the control, and it is testable.
- **Alternative considered.** Offline mode (`page.setOfflineMode(true)`) alone. Rejected: it fails requests but still lets `file:` and `data:`-adjacent schemes attempt, and gives no hook to count attempts in a test.
- **Proof.** An int spec renders, through the real `PdfRenderer`, HTML with:
  - an `<img>`, a `<link rel=stylesheet>` and an `<iframe>` pointing at a local HTTP server;
  - an inline `<script>` that would `fetch` it.

  It asserts zero hits on the server and a valid PDF. With the two lines removed, the hits appear.

### 4. Refusals: audited and bounded inside the existing lock

- Inside the `inviteMember` transaction, after `lockAndReadActor` (the tenant advisory lock already serialises one organisation's invitations):
  1. Count the organisation's `invite_refused` rows of the last hour on the database's clock (`SELECT now()`, then a Prisma aggregate: the append-only guard forbids raw SQL naming the trail). If the count is 5 or more, throw `InviteRefusalsExhaustedError` (429 `invite_refusals_exhausted`, with `Retry-After` until the oldest ages out) before the address lookup. *(Changed in review: the first version reused the runtime's `CapacityError`, so the web could not tell this refusal from a capacity one.)*
  2. On a hit, write the `invite_refused` row on the transaction (`entity: 'invitation'`, `entityId: null`, `diff: { reason: 'email_unavailable' }`, actor and organisation as usual). Then return a refusal marker instead of throwing, so the row commits; the caller throws `EmailUnavailableError` after the commit.
- **The P2002 race path** (another tenant created the address between the check and the insert) writes its row in a fresh transaction, under the same lock, before rethrowing.
- **Counting from the audit trail**, not a counter table: no migration, append-only rows cannot be reset by the caller, and the existing index serves the query.
- **Alternatives considered.**
  - *A uniform "sent" answer for taken addresses.* Rejected: the member list would still show a row that never delivers, so the signal survives and the UI misleads.
  - *A per-IP limit.* Rejected: the actor is an authenticated `super_admin`, so the organisation is the right key.
- **Residual, documented in `security.md`:**
  - Five answers per hour per organisation.
  - More organisations through more registrations, bounded by the registration code and its per-IP quota.
  - The delivery-time `email_unavailable`, for an Auth user with no profile, is recorded on the invitation and not counted.

### 5. Set-password: a tab-bound email-link marker, Auth reauthentication, an audit call

- **The marker.**
  - `/auth/confirm`, after `verifyOtp` succeeds, writes `sessionStorage['tonyai.emailLink'] = { userId: data.user.id, flow: type, at: Date.now() }`.
  - `/auth/set-password` offers the form only when the marker's `userId` equals the current session's user and `at` is under an hour old (`otp_expiry` is 3600 s).
  - It takes `flow` from the marker, no longer from the query string.
  - The marker is removed once the password is saved.
  - Otherwise the screen shows a `setPassword.useEmailLink` message with a link to `/forgot-password`.
  - `sessionStorage` is per-tab and per-origin: a session used in another browser or tab has no marker.
- **Auth reauthentication.**
  - `supabase/config.toml`: `secure_password_change = true`, plus a `[auth.email.template.reauthentication]` subject and body, bilingual.
  - `auth_settings.py` pins `security_update_password_require_reauthentication: True`; its test changes with it.
  - GoTrue then demands a nonce when the session is older than 24 hours. The marker guarantees a session under an hour old on the only screen that changes a password, so no in-app flow ever asks for a nonce, and no SMTP change is needed for the app to work.
  - The nonce mail matters only to a direct Auth call from an older session. That call is refused either way; without custom SMTP on Supabase Cloud the nonce simply never arrives.
  - Supabase Cloud custom SMTP is therefore an owner follow-up, not a precondition.
- **The audit call.**
  - `POST /api/v1/me/password-set` with `{ flow: 'invite' | 'recovery' }`: authenticated, WRITE group.
  - It writes `password_set` (`entity: 'profile'`, `entityId: user.id`, `diff: { flow }`).
  - The form calls it after `updateUser` succeeds: bounded like the acceptance (three tries, 5 s wait at most), never blocking.
  - It is self-reported. A client can only write rows about itself, so a forged row misstates nothing about anyone else.
- **Alternatives considered.**
  - *Ask for the current password.* Rejected: invite and recovery users have none.
  - *A server-issued one-time token instead of the marker.* Rejected: more state for the same guarantee, since Auth's reauthentication is the server-side control.

### 6. Contract additions

- `AUDIT_ACTIONS` gains `invite_refused` and `password_set`.
- `api.ts` gains `recordPasswordSet(flow)`.
- `docs/api/endpoints.md` gains the two routes and the 429 on `POST /users/invitations`.
- No Prisma change.

### 7. Review round (`security-rls`, `qa-auditor`, `architect`)

- **The report quota moved to admission.** A report spends `csp-report:ip:` in `runtime-http.ts`, before its body is read and *instead of* the address's `ip:` quota. The first version charged both, so a noisy page behind an office's single address could refuse that office's API calls (measured by `qa-auditor`: 125 reports left another route answering 429). The controller no longer takes a quota.
- **The invitation bound has its own code.** `invite_refusals_exhausted` (429), registered in `API_ERROR_STATUS`, worded in the errors catalogue (TR/EN). It carries `Retry-After` through the exception filter. `/users` shows it through the catalogue like any other code, never by status.
- **No host resolves in the renderer.** Chromium launches with `--host-resolver-rules=MAP * ~NOTFOUND`. A DNS prefetch and a preconnect go through the resolver and the socket pool, around request interception: the int spec measured 3 connections without the flag and none with it. A meta refresh makes none either.
- **The set-password screen is a screen control, and says so.** The marker gates the screen. The server-side control on a password change is GoTrue's 24-hour reauthentication, so a stolen session under 24 hours can still call Auth directly. The Open-questions item closes as *partially* closed, with that residual filed.
  - At submit the screen reads the session and the marker again.
  - The acceptance and the `password_set` record are bound to that user and to that session read's token (`callAsSubjectQuietly`, the acceptance's pattern from #351).
  - While the marker is read the screen shows no field.
- **One flow type.** `EmailLinkType` and `EmailLinkFlow` are the shared `PasswordSetFlow`, validated with `PASSWORD_SET_FLOWS`.
- **`next dev` may evaluate code.** `script-src` adds `'unsafe-eval'` only when `NODE_ENV` is `development`; a built image never does.
- **Smaller fixes:**
  - the summariser also strips zero-width and bidi format characters;
  - the text parser has `inflate: false`;
  - `inviteMember` returns `'created' | 'refused'` from its transaction instead of setting a flag;
  - the reauthentication template is English only (Turkish lives only in the `tr` catalogue);
  - `RecordPasswordSetDto` has its own file;
  - the repeater is named `repeatQuietly`, with `acceptInvitationQuietly` kept as its alias.
- **Filed, not fixed (Open questions):**
  - Fresh-address invitations stay unbounded except by the WRITE quota (pre-existing).
  - Hosted reauthentication uses Supabase's default template.
  - A `password_set` record can be refused 429 while a hung acceptance still holds the user's single mutation permit.
  - Report log volume has no replica-wide cap.

## Risks / Trade-offs

- **An enforced policy breaks a screen nobody walked.**
  - Mitigation: the e2e watcher covers every screen spec, and the whole suite runs under the enforced policy before the PR. QA runs a day under it before G5.
  - Rollback: one image revert brings the report-only split back.
- **Report noise from browser extensions.** Extensions inject scripts and trigger violations.
  - Mitigation: the receiver logs and never alerts, and the per-IP quota bounds a noisy client.
- **`setRequestInterception` slows renders.** It is a per-request hook on a document with no sub-resources.
  - Mitigation: the int spec times a real report before and after. Expect no measurable change.
- **The marker locks out a legitimate person.** For example, someone who opens the link on a phone and finishes in another tab.
  - Mitigation: the screen says to use the link again. A recovery link is one click from `/forgot-password`.
- **Reauthentication changes a hosted setting.**
  - Mitigation: the readback pin and its test move together, and the deploy order is code first, then setting.
  - Rollback: flip the pin back.
- **The refusal count uses `now()`.** Clock skew between app and database does not matter, because the database clock decides both writing and counting.

## Migration Plan

1. One PR: web headers, the receiver, the renderer, the refusals, set-password, the config and the pin, the docs.
2. Merge, then the QA auto-deploy. The release's auth-settings readback applies the new pin; the deploy script already PATCHes managed settings.
3. Owner checks on QA:
   - a screen walk with the devtools console open;
   - one invite of an existing address, then the audit view shows `invite_refused`;
   - a password reset end to end.
4. Owner, separately:
   - Supabase Cloud custom SMTP (ACS) for Auth mail;
   - confirm the legacy anon/service_role JWT keys are disabled.

**Rollback:** revert the PR's image, and flip `security_update_password_require_reauthentication` back if the setting causes trouble. No data migration to undo; the audit rows stay, as append-only.

## Open Questions

- ~~The exact GoTrue rule for "recent" sessions.~~ **Measured on the local stack** (`onboarding.int.spec.ts`, "Auth asks an older session for reauthentication…"): a session created 23 hours ago changes the password with no code, and one created 25 hours ago is refused `reauthentication_needed`, with the password unchanged. Hosted GoTrue is the same product line; the QA owner check (a password reset end to end) covers the email-link flow there.
