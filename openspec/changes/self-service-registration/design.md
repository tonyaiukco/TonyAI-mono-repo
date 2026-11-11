# Design

## Context

See `proposal.md` for the motivation. The constraints that shape the approach:

- Today only `OnboardingOperator.provision` (`apps/api/src/onboarding/`) creates an organisation, on the owner's connection (`DIRECT_URL`). The API runs as `tonyai_runtime`, which holds `SELECT` only on `organisations` (`packages/db/scripts/runtime-role.mjs`).
- Roles and grants change only through `AccessAdminService`; its `inviteMember` needs an authenticated `super_admin` actor.
- `InvitationDeliveryService.deliver` already does everything after the database step: creates the Supabase Auth user with the profile's id, mints the invitation link, sends the email and records the outcome on the invitation.
- `POST /auth/password-reset` is the one public write today. It answers 202 for every address and does the work afterwards on a bounded queue, behind a per-address-of-client quota (`AUTH_EMAIL_PER_IP_PER_MINUTE`).
- `audit_log` is append-only and its diffs never hold a name or an address (D20).
- Supabase sign-up stays off (`enable_signup = false`); the infra tests that assert it stay untouched, because registration creates the Auth user through the admin API as invitations do.

## Goals / Non-Goals

**Goals:**

- One request creates the organisation, profile, invitation and consent atomically, then reuses the invitation delivery unchanged.
- The runtime role gains the least it needs, and nothing outside the registration path can use the new right by accident.
- An environment without the registration code behaves exactly as today.

**Non-Goals:**

- Changing the operator CLI, the invitation acceptance pages or the Auth settings.
- A hostname-aware web app (the later `register.<env>` change).
- Deleting or expiring anything: an unaccepted registration stays until the operator offboards it.

## Decisions

### D1 — The registration code is the on/off switch

`REGISTRATION_CODE` (a secret of exactly 5 alphanumeric characters, `[A-Za-z0-9]{5}`, compared case-sensitively — owner decision 2026-11-11) enables registration; unset means off. One setting cannot disagree with itself, where a flag plus a code could ("enabled, no code"). The code is compared in constant time over digests. A code of any other shape fails startup. The form's code field accepts 5 characters and does not change their case.

`GET /api/v1/auth/registration` (public) answers `200 { consentVersion, consentIsPlaceholder }` when on and 404 when off; the page reads it to choose between the form and the "unavailable" state. `POST /api/v1/auth/registration` is the submission.

*Alternative:* a `NEXT_PUBLIC_*` build flag for the page — rejected: web images are built per environment and the flag could drift from the API's secret.

### D2 — Answers and ordering

| Case | Answer |
|---|---|
| Registration off | 404 |
| Malformed input, consent false, unknown notice version | 400 |
| Client address past its quota | 429 |
| Wrong code | 403 `registration_code_invalid` |
| Right code, any address | 202, empty body |

The switch is a guard on the controller, so a switched-off environment answers 404 before the body is validated. Then validation (400), the per-client-address quota (429) and the code (403), in that order — a malformed body spends no quota, but every body that reaches the code check has spent it, so each guess costs one. Every case that reaches 202 is queued and processed after the response, as the password reset does, so neither body nor timing separates a new address from a known one. The wrong-code answer is distinguishable on purpose: the code says nothing about any address. A code of the wrong shape is a wrong code (403), not a validation error. Registration shares the reset's per-client-address quota (`AUTH_EMAIL_PER_IP_PER_MINUTE`) and its bounded-queue pattern, with its own queue (200) and workers (2); a full queue drops the request silently, as there.

Processing, by the profile found for the normalised address:

- **none** → create (D3), then deliver;
- **an unaccepted invitation of a registered account** (it holds a registration consent and has no inviter), profile enabled, organisation not offboarded → re-deliver that invitation if its last attempt is older than 5 minutes (the reset's cooldown), claimed in one statement so two submissions at once send one email; and it has had fewer than five deliveries in all (the address may not be the submitter's, so its emails are bounded for good; "forgot password" still opens the account); the submitted company name and job title are ignored;
- **anything else** (active, disabled, offboarded, invited by an administrator, provisioned by the operator) → nothing. Registration never re-sends an invitation it did not create: minting a link voids the previous one, and a code holder must not be able to void another organisation's invitations.

Two concurrent submissions of one new address race on `profiles.email`'s unique index; the loser's transaction rolls back whole and is treated as "exists".

### D3 — The write lives in `AccessAdminService`

A new method, `registerOrganisation`, writes in one transaction: the organisation (`legalName` = company name, `country` `TR`, `geographyCode` `TR`, `reportingCurrency` `TRY`), the profile (`fullName` = first + last name, `jobTitle`, `role` `super_admin`, `language`), the invitation (`invitedBy` null), the consent row, and their audit rows through `recordSystem` (`userId` null, `diff.source` `auth:registration`, no name, address, job title or company; the consent row's diff holds kind, version and language only). It keeps "roles change only through `AccessAdminService`" true with one more entry point instead of a second writer.

*Alternative:* call `OnboardingOperator.provision` from the API — rejected: it requires the owner's connection, which the API must never hold.

### D4 — Runtime rights: column-level INSERT on `organisations`

The migration grants `tonyai_runtime` `INSERT` on `organisations` for the columns it writes (`id`, `legal_name`, `country`, `geography_code`, `reporting_currency`, timestamps), `INSERT` on `profiles.job_title`, and `SELECT` plus a column-level `INSERT` on `consents`; `runtime-role.mjs` mirrors each. No `UPDATE` or `DELETE` on `organisations` or `consents`.

*Alternative:* a `SECURITY DEFINER` function owning the insert, with no table grant. It is narrower on paper, but the runtime role already bypasses RLS and may insert a `super_admin` profile into any organisation, so an organisation insert adds little reach; the function would add a second privileged code path outside Prisma and outside `runtime-role.mjs`'s checks. The `security-rls` review is asked to attack this choice specifically.

### D5 — `consents` table

`id`, `profile_id` (FK, CASCADE with the profile, as `invitations`), `kind` (`kvkk_registration`), `text_version`, `language`, `accepted_at` (the database's clock; the runtime role has no INSERT on the column, so a consent cannot be backdated). Read and written by the API alone, exactly as `invitations`: RLS enabled (never forced) with no policy, and every privilege revoked from `anon`, `authenticated` and `service_role`, so PostgREST serves no row to anyone. Append-only at runtime by grant (no `UPDATE`/`DELETE`). The client address is not stored: it is personal data the consent does not need.

*Alternative:* consent columns on `profiles` — rejected: a later notice version or a second consent kind would overwrite history. *Alternative:* an organisation-scoped `SELECT` policy for client roles — rejected: nothing reads consents from the browser, and a table no client reaches cannot leak across tenants (`rls-for-table`, "a table only the API reads").

### D6 — The notice and its version

The notice text lives in the web catalogues (`tr`, `en`); its version and a placeholder marker are constants in `@tonyai/shared-types` (first value `placeholder-1`). The API accepts only the version it serves. The page sends its own build's version — never the one the status endpoint reported — and shows "this page is out of date" with a reload instead of the form when the two differ, so a page from another build (a rolling deploy, a stale tab) cannot record consent to a notice it did not show; the placeholder label, too, follows the page's own version. When `REGISTRATION_CODE` is set and the version is a placeholder, the API refuses to start unless `REGISTRATION_ALLOW_PLACEHOLDER_CONSENT=true`. QA sets it; the pilot does not, so the pilot cannot open registration before the reviewed text ships with a new version.

### D7 — Email: a third invitation wording

`renderMail` today chooses between "invited by a colleague" and "provisioned" (`inviter === null`). A first administrator who registered gets wording of their own — subject, body, action, expiry and "ignore" — which says they registered their company and, for an expired link, to submit the form again. It carries nothing the registrant typed — no name, no company — because the form is public and the address may be someone else's (security review F3: typed text in an email from this domain is a phishing vehicle). The password reset is public too and greeted the account by name, so until the invitation is accepted a self-registered account's reset email greets nobody (review of `8c9bcf0`, finding 1); once the address's owner has accepted, the name is theirs to keep. `InvitationDeliveryService.deliver` tells the two first administrators apart by the registration consent the profile holds, so every path that re-sends (registration, the operator CLI, the users screen) words the email the same way, and no column or parameter is added.

### D8 — Web

`/register` joins `PUBLIC_PATHS` and `SIGNED_OUT_ONLY_PATHS`. The page follows the forgot-password page's card, with the `auth` catalogue namespace and the `wire-page` and `localise-ui` skills; `lib/api.ts` gains `getRegistrationStatus` and `register`, unauthenticated like `requestPasswordReset`. The form sends the active locale as the registration's language. No link to it from the login page.

### D9 — Configuration: local now, hosted in a separate change

Locally the code is `local` (`pnpm setup` writes it to `apps/api/.env`, with the placeholder allowance); Playwright's API gets the same pair, and the integration specs pass their own settings.

Hosted environments are out of this change (owner decision 2026-11-11). `REGISTRATION_CODE` will be a Key Vault secret referenced by the API container app by exact version, and the placeholder allowance a plain setting accepted on staging only — but the deploy tooling refuses a secret it does not know (`deploy_apps.verify` compares the live secret set exactly; `terraform_run.validate_release` refuses unknown release keys; `qa_autodeploy.py`'s input export rebuilds the release from live state), so the Terraform roots, five scripts, their tests and the runbooks change together in their own pull request. Until it is applied, registration is off on every hosted environment and this change is inert there.

## Risks / Trade-offs

- [A leaked code lets anyone create organisations and send invitation emails from our domain] → per-client-address quota, per-address cooldown, rotation by replacing the secret and restarting; the QA and pilot codes differ.
- [A 5-character code has about 916 million values (62^5), so it is guessable by a caller with many client addresses: the quota of 5 attempts a minute is per address, and 1,000 addresses reach half the space in about two months] → accepted for a code shared by hand with invited companies; wrong-code refusals are logged with a count so a guessing run is visible, and the code is rotated when one is seen or when the code is known to have spread. A guessed code yields empty organisations and invitation emails, not access to any tenant's data.
- [Address squatting: a code holder registers someone else's address; the address then has a profile, so its real organisation cannot invite it (D17), its owner's later registration re-sends the squatter's invitation, and `offboard` does not free it] → no access is gained (the link goes to the address); accepted for a hand-shared code, stated in the security doc, and filed with an expiry-and-purge of unaccepted registrations as the fix when wanted (security review F1).
- [The endpoint is no existence oracle, but anyone who completes a registration becomes a `super_admin` and the invite route answers `email_unavailable` for any address with a profile] → pre-existing for provisioned administrators, now reachable by a code holder; stated in the security doc and filed (security review F2).
- [A registrant who completes registration is an administrator whose typed name and company ride in the invitations they send (`{inviter} has invited you to join {organisation}`), to any address] → the same reach an operator-provisioned administrator has, now behind the code alone; bounded by the write quota and audited per invitation; filed.
- [Quotas are in memory per process, so a second replica doubles them] → known and accepted for the pilot (planning file, LP4-01 follow-ups); unchanged here.
- [Unaccepted registrations leave empty organisations] → accepted (owner decision); the operator's `offboard` closes one, and `reconcile` lists undelivered invitations.
- [Someone with an account sees "check your email" and no email arrives] → the confirmation names sign-in and password reset as the way in.
- [Country, geography and currency cannot be changed after registration] → a company that needs other values is provisioned by the operator CLI.
- [QA collects real names and addresses under a placeholder notice] → every consent row carries its notice version, so those rows stay identifiable.
- [The security doc's "no HTTP surface creates an organisation" guarantee ends] → recorded as an owner decision replacing D18, and reviewed by `security-rls` before the PR.

## Migration Plan

1. Merge with the migration; `db:deploy` adds the column, the table and the grants. No backfill: existing profiles have a null job title and no consent row.
2. QA: after the separate infrastructure change is applied (D9) — set the secret and the placeholder allowance, deploy, register one holding end to end.
3. Rollback: remove the secret and restart — registration is off and nothing else changed. The schema additions are inert and stay.
