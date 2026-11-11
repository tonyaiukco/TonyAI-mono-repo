# Tasks

## 1. Contract and decision record

- [x] 1.1 Add the registration request and status types, the consent kind, the notice version with its placeholder marker, the `registration_code_invalid` error code and the `consent` audit entity to `@tonyai/shared-types`; verify `pnpm typecheck` passes
- [x] 1.2 Record the owner decisions of 2026-11-11 (registration replaces D18's "no HTTP surface"; code-gated; QA and pilot; TR/TR/TRY defaults; path now, hostname later; no expiry) in the planning file's Decisions log, with the Current status entry and the filed follow-ups (the ledger holds LP task cards only, so this work has no row, as UAT round 2's has none); verify the entries cite this change

## 2. Database

- [x] 2.1 Add `profiles.job_title` and the `consents` model to the Prisma schema and generate the migration; delete the spurious `DROP INDEX activity_records_reporting_entity_period_category_key`; verify the migration applies on a clean local database
- [x] 2.2 Add RLS for `consents` with the `rls-for-table` skill (enabled, not forced; no client policy and every client privilege revoked, as `invitations`); verify an `rls:probe` case shows no client role, the service role included, reads or writes it
- [x] 2.3 Grant the runtime role column-level `INSERT` on `organisations`, the new profile column and `SELECT`/`INSERT` on `consents` in the migration, and mirror them in `runtime-role.mjs`; verify its check passes and that the runtime role still cannot `UPDATE` or `DELETE` an organisation or a consent
- [x] 2.4 Document the new column, table and grants in `docs/architecture/` (data model and security); verify the text matches the migration

## 3. API

- [x] 3.1 Read `REGISTRATION_CODE` and `REGISTRATION_ALLOW_PLACEHOLDER_CONSENT` in the runtime configuration, failing startup on a code that is not exactly 5 alphanumeric characters or on a placeholder notice without the allowance; verify with unit specs for each startup outcome, and add both to `.env.example`
- [x] 3.2 Add `AccessAdminService.registerOrganisation` writing the organisation, profile, invitation, consent and audit rows in one transaction; verify with a DB-free spec covering the rows written, the absence of name, address and job title in audit diffs, and whole rollback on a failure
- [x] 3.3 Add the `registered` origin to the invitation email in both catalogues and pass the origin through `InvitationDeliveryService.deliver`; verify `mail-templates.spec.ts` covers all three wordings in TR and EN
- [x] 3.4 Add the registration service on the password-reset pattern (quota, bounded queue, work after the response) with the three address cases and the 5-minute re-send cooldown; verify with a spec per case, including the concurrent-duplicate race and the full-queue drop
- [x] 3.5 Add the public `GET` and `POST /api/v1/auth/registration` with a `class-validator` DTO; verify with specs for 404 when off, 400, 403 `registration_code_invalid`, 429 and an identical 202 for a new and a known address, a code differing only in letter case refused, and each wrong-code refusal logged without the submitted code
- [x] 3.6 Add an integration spec on the runtime login that registers an address and reads back the organisation, profile, invitation, consent and audit rows; verify `pnpm test:int` passes
- [x] 3.7 Document the endpoints in `docs/api/` and rewrite the provisioning paragraph in `docs/architecture/security.md`, the operator CLI and `AccessAdminService` docblocks and the D18 comment in `supabase/config.toml`; verify no remaining text says no HTTP surface creates an organisation

## 4. Web

- [x] 4.1 Add `getRegistrationStatus` and `register` to `lib/api.ts` and `/register` to the public and signed-out-only paths; verify the proxy spec covers a signed-out and a signed-in visitor
- [x] 4.2 Build the `/register` page in the auth-card design with the form, the placeholder notice, the consent checkbox, and the unavailable, invalid-code, rate-limited and confirmation states, with TR and EN catalogue entries (`localise-ui`); verify with view-module specs for the form's decisions (the web suite renders no components), the catalogue parity check, and the page states exercised in 4.3 and 5.1
- [x] 4.3 Check the page against the running app in both languages at desktop and phone width; verify by screenshots that it matches the login and forgot-password pages

## 5. End to end

- [x] 5.1 Add a Playwright spec (`e2e-flow`) that registers, follows the invitation link (from mailpit where the stack runs it, else minted through the Auth admin API — CI runs no mail catcher), accepts, sets a password and lands signed in as `super_admin` of the new organisation, plus a wrong-code case; verify the spec passes locally on built servers with the test code set

## 6. Review and integration

- [x] 6.1 Run `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm test:int` and `rls:probe`; verify all are green
- [x] 6.2 Run the `security-rls`, `qa-auditor` and `architect` reviews in parallel on the diff (runtime grant versus a definer function, existence oracle by body and timing, code brute force, audit PII, consent RLS, contract surface); verify every correctness, security or data-integrity finding is fixed and the rest are filed under Open questions
- [x] 6.3 Run `openspec validate self-service-registration --strict`; verify it passes

## Workflow follow-up

- Open the pull request; the owner merges. Merged, registration stays off everywhere: no environment sets `REGISTRATION_CODE`.
- **A separate change and pull request (owner decision 2026-11-11) carries the code to hosted QA** — the application Terraform root's optional registration input (the `registration-code` Key Vault secret by exact version, and the placeholder allowance, staging only), the foundation's grant for that secret, the deploy scripts that refuse a secret they do not know (`terraform_run.validate_release`, `deploy_apps.verify`, `release_secrets.py`, `foundation_contract.py`, `qa_autodeploy.py`'s input export) with their tests, and the runbook steps (store, rotate, switch off, close an unaccepted registration with `offboard`).
- After that change is applied by the owner, register one holding end to end on `qa.tonyai.io/register`; record the deploy in the planning file.
- Archive the change once the QA check passes.
- Plan the `register.<env>` hostname as its own change.
- The pilot enables registration only after the reviewed KVKK notice ships under a new version.
