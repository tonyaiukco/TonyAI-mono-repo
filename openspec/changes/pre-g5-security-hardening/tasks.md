# Tasks

## 1. Renderer isolation (`pdf-rendering`)

- [x] 1.1 In `apps/api/src/common/pdf-renderer.ts`'s `render`, after `newPage()`:
  - disable JavaScript;
  - turn on request interception, aborting every request.

  Extend the puppeteer stub in `reports/reports.service.spec.ts` (and any other `PdfRenderer` stub) with `setJavaScriptEnabled`, `setRequestInterception` and `on`. Add a unit case pinning both calls before `setContent`. Verify with `pnpm --filter api exec vitest run src/reports src/report-issuances src/common`.
- [x] 1.2 Add `apps/api/test/int/pdf-isolation.int.spec.ts`. It renders through the real `PdfRenderer` HTML that has an `<img>`, a stylesheet `<link>`, an `<iframe>` and an inline `<script>` calling `fetch`, all pointed at a local HTTP server, and asserts:
  - zero hits on the server;
  - a PDF that starts with `%PDF`.

  Verify it fails when the two calls from 1.1 are removed (mutation check), then passes.
- [x] 1.3 Render one live report and one issuance before and after on the local stack. Same page count and extracted text, render time within noise. Record the numbers in the PR. Update `docs/api/bounded-access.md`'s renderer paragraph.

## 2. Web policy enforced, report receiver, cross-origin headers (`web-response-security`)

- [x] 2.1 `apps/web/security-headers.mjs`:
  - one enforced `Content-Security-Policy` with the structural and the resource directives;
  - no `Content-Security-Policy-Report-Only`;
  - `report-uri` alone (no `report-to`, measured: design §1), built from the API origin, and omitted when there is none;
  - `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`.

  Update `apps/web/next.config.test.mjs`: exact policy, reporting present or absent by env, the two new headers, no report-only header. Verify with `pnpm --filter web test`.
- [x] 2.2 API: add `Cross-Origin-Resource-Policy: same-site` in `common/runtime-http.ts`, with a unit assertion beside the existing header tests.
- [x] 2.3 API receiver: a `SecurityReportsController` (`@Public() POST /security/csp-reports`, 204), registered in `app.module.ts`, with:
  - its own body parser for `application/csp-report`, `application/reports+json` and `application/json`, capped at 16 KiB;
  - a per-IP quota of its own, `CSP_REPORT_PER_IP_PER_MINUTE` (30), set in code in `runtime-limits.ts` (design §2);
  - a pure `summariseCspReports(body)` reducing both formats to `{ directive, blockedOrigin, pagePath, disposition }`. Origin only, path only, fields truncated, at most 10 per body, never throwing.

  Unit specs:
  - both formats;
  - query strings and fragments dropped;
  - malformed JSON answers 204, a wrong type 415 and an oversized body 413, never a 500;
  - the logged line carries only the four fields.

  Wire spec: the route is public, and its quota answers 429.
- [x] 2.4 e2e `e2e/security-headers.spec.ts`:
  - exact enforced header;
  - COOP/CORP present;
  - no report-only header;
  - the screen walk now covers Data Entry, Review, Users, sign-in and registration as well, and still fails on any CSP console message.

  Add a case that injects a cross-origin script through `page.evaluate` and expects the browser to block it under the enforced policy (`securitypolicyviolation`, disposition `enforce`). The upload itself is not observed by Playwright (the browser posts it outside the page's requests); with `report-uri` alone Chrome posts it at once, measured on local built servers as a `csp_violation` line in the API log and recorded in the PR. Run the whole e2e suite on local built servers: every spec passes under the enforced policy.
- [x] 2.5 Docs:
  - `docs/architecture/security.md` "Web response headers": enforced, reporting, COOP/CORP, the `'unsafe-inline'` residual;
  - `docs/architecture/observability.md`: the report log line and how to query it;
  - `docs/api/endpoints.md`: the receiver route.

## 3. Invitation refusals audited and bounded (`account-access`)

- [x] 3.1 `packages/shared-types`: add `invite_refused` and `password_set` to `AUDIT_ACTIONS`, plus any audit-view label mapping the web keeps for actions (TR/EN catalogue entries). Verify with the shared-types tests and web typecheck.
- [x] 3.2 `AccessAdminService.inviteMember`, inside the existing transaction after `lockAndReadActor`:
  - count the organisation's `invite_refused` rows in the last hour; at 5 or more, refuse with 429 `invite_refusals_exhausted` (its own code, review round) before the lookup;
  - on a taken address, write `invite_refused` (no address; `diff: { reason: 'email_unavailable' }`), commit, then throw `EmailUnavailableError`;
  - on the P2002 race, write the row in its own transaction, then rethrow.

  Unit specs in `access-admin.service.spec.ts`:
  - refusal writes the row and creates nothing;
  - the sixth attempt is refused before any lookup, for a new and a taken address alike, with the same body;
  - other organisations are unaffected;
  - a new address writes no row.
- [x] 3.3 Int spec, in `apps/api/test/int/onboarding.int.spec.ts`, on the runtime role:
  - five refusals, then 429 for a new address;
  - a second organisation still invites;
  - the rows carry no address (`JSON.stringify(diff)` has no `@`);
  - five refusals written two hours earlier (owner client, inside the test's own tenant) do not count. *(Changed during apply: `audit_log` is append-only, so rows are inserted old rather than backdated; no reopen-after-block case.)*

  Verify it fails with the count check removed.
- [x] 3.4 Web `/users`: the 429 answer shows its own copy, through the errors catalogue (`invite_refusals_exhausted`, TR/EN). *(Changed during apply and review: the general `rate_limited` copy says a minute; the bound lasts up to an hour, and keying on the status alone mislabelled the runtime's own 429s.)*
- [x] 3.5 Docs:
  - `docs/architecture/security.md`: the D17 oracle is now an accepted, bounded risk, with the residuals from design §4;
  - `docs/api/endpoints.md`: `POST /users/invitations` 429.

## 4. Set-password guarded and audited (`account-access`)

- [x] 4.1 `lib/email-link-marker.ts`, pure: write, read and clear, taking a `Storage` and a clock. Valid only for the same user and under an hour old, never throwing on a missing or corrupted value. Unit spec covers:
  - other user;
  - stale;
  - corrupted JSON;
  - storage throwing.
- [x] 4.2 `/auth/confirm` writes the marker after `verifyOtp` succeeds.

  `/auth/set-password`:
  - offers the fields only with a valid marker for the session's user;
  - takes `flow` from the marker;
  - otherwise shows `setPassword.useEmailLink` (TR/EN) with a link to `/forgot-password`;
  - clears the marker after a successful save.

  Wiring test in `sign-out.spec.ts`'s style.
- [x] 4.3 API `POST /me/password-set` (`{ flow }`, class-validator `IsIn(['invite','recovery'])`):
  - writes `password_set` as the caller (`entity: 'profile'`, `diff: { flow }`);
  - `api.recordPasswordSet(flow)`;
  - the form calls it after `updateUser` succeeds, bounded like the acceptance (three tries, 5 s at most, never blocking).

  Unit specs (controller and service, the 400 on another flow) and a web unit spec of the bounded call.
- [x] 4.4 Auth reauthentication:
  - `supabase/config.toml`: `secure_password_change = true` and a bilingual `[auth.email.template.reauthentication]` (template file under `supabase/templates/`);
  - `infra/scripts/auth_settings.py`: pin `security_update_password_require_reauthentication: True`;
  - `infra/tests/test_auth_lifecycle_settings.py` already compares the pin with `config.toml`; it now also asserts the pin is true (review round).

  Verify with `python3 -m unittest discover -s infra/tests -p test_auth_lifecycle_settings.py`, and restart the local stack's auth (`supabase stop && supabase start`, after checking with the owner that no other session needs the stack).
- [x] 4.5 Int spec against local GoTrue:
  - a fresh recovery session changes the password without a nonce;
  - the same session with its `auth.sessions.created_at` set back 25 hours (owner client, the test's own user) is refused without a nonce, and the password is unchanged (sign-in with the old one still works).

  Record the measured rule in design's Open question.
- [x] 4.6 e2e:
  - `password-visibility.spec.ts` reaches set-password through a real recovery link (mailpit), or sets the marker for the signed-in user's id, and still checks the fields;
  - a new case: a signed-in user opening `/auth/set-password` directly sees `useEmailLink` and no field;
  - `registration.spec.ts` still sets the first password and the audit view shows `password_set`.

  Run the whole e2e suite.
- [x] 4.7 Docs:
  - `docs/architecture/security.md` "Passwords" and "Acceptance": the marker, reauthentication, the audit row, the residual of a fresh stolen session under 24 hours;
  - `docs/api/endpoints.md`: `POST /me/password-set`.

## 5. Review and close-out

- [x] 5.1 Typecheck, lint, `pnpm test`, the touched int specs (`pdf-isolation`, `onboarding`), the whole e2e suite on local built servers. Record the numbers in the PR.
- [x] 5.2 Review pass on separate trees:
  - `security-rls` (CSP, receiver abuse, renderer escape, oracle bound, marker bypass, reauth);
  - `qa-auditor` (traceability, mutants, e2e flake);
  - `architect` (the new audit actions and routes in the shared contract).

  Fix every P1/P2; file the rest under Open questions.
- [x] 5.3 Planning file:
  - a Current status entry;
  - close the four Open-questions entries (CSP enforcement, the invite oracle, the `#261` set-password note, the renderer);
  - file the residuals (nonces, extension noise, the bounded oracle, a fresh stolen session).

## Workflow follow-up

- Owner, after the QA deploy:
  - a screen walk with the console open;
  - one invite of an existing address (audit view shows `invite_refused`);
  - one password reset end to end.
- Owner, separately:
  - Supabase Cloud custom SMTP (ACS) for Auth mail, so a reauthentication nonce can arrive;
  - confirm the legacy anon/service_role JWT keys are disabled.
- Archive with `/opsx:archive` once merged and the QA checks pass.
