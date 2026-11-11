# Proposal

## Why

A new holding and its first `super_admin` exist only after an operator runs `pnpm onboarding provision` on the owner's database connection (D18). QA testers need fresh holdings on demand, and pilot companies will be onboarded the same way, so every new tenant waits for the operator. A registration page lets an invited company create its own holding and first administrator, then continue on the existing invitation flow.

## What Changes

- A public registration page at `/register` in the web app, in the existing auth-page design, in Turkish and English. Fields: first name, last name, company name, job title, company email, registration code, and a KVKK consent checkbox beside the notice text.
- A public API endpoint that, for a valid registration code, creates the organisation, its first `super_admin` profile, an invitation and a consent record, and sends the invitation email. From the email on, the flow is the existing one (`/auth/confirm` → `/auth/set-password`).
- Registration is switched per environment by one secret, the shared registration code: an environment without it has no registration (the endpoint answers 404 and the page says registration is unavailable).
- The endpoint never says whether an address already has an account: a new address, an address with an unaccepted invitation and an address with an active account get the same answer.
- New stored data: the administrator's job title on the profile, and an append-only consent record (kind, notice version, language, time).
- A third wording of the invitation email for a self-registered administrator. No new email kind: the pilot still sends the invitation and the password reset only.
- The KVKK notice ships as a clearly labelled placeholder. An environment refuses to enable registration on the placeholder notice unless it is explicitly allowed to (QA is; the pilot is not).
- **BREAKING (security posture):** decision D18, "no HTTP surface creates an organisation", is replaced by "an organisation is created by the operator CLI or by code-gated registration". The API's runtime database role gains the right to insert organisations.

Out of scope: a dedicated hostname (`register.qa.tonyai.io`, a later change), a "Register" link on the login page, a captcha, an email-domain filter, a uniqueness rule on company names, automatic expiry or deletion of unaccepted registrations, and editing an organisation's country, geography or currency after registration.

## Capabilities

### New Capabilities

- `self-service-registration`: code-gated creation of an organisation and its first administrator from a public form — who may register, what is created, what the caller is told, the consent record, and how an environment turns it on.

### Modified Capabilities

None. No existing spec covers account provisioning.

## Impact

- **Database (`packages/db`):** a migration adding `profiles.job_title`, a `consents` table with RLS, and runtime-role grants (insert on `organisations`, the new column, the new table); `runtime-role.mjs` entries.
- **API (`apps/api`):** a registration controller and service, a new method on `AccessAdminService`, a mail-template variant, new configuration (`REGISTRATION_CODE`, `REGISTRATION_ALLOW_PLACEHOLDER_CONSENT`), new error codes.
- **Shared types:** registration request and status types, the consent kind and notice version, a new audit entity.
- **Web (`apps/web`):** the `/register` page, its `lib/api.ts` calls, public-path entry, TR/EN catalogue entries.
- **Infrastructure:** none in this change (owner decision 2026-11-11). Until a separate change wires the registration code — a Key Vault secret — to the API container through Terraform and the deploy scripts, no hosted environment can enable registration. No DNS, certificate or hostname change.
- **Docs:** `docs/architecture/security.md` (provisioning), `docs/api/`, the operator CLI and `AccessAdminService` docblocks, the D18 comment in `supabase/config.toml`, and a decision entry in the planning file. The QA runbook steps come with the infrastructure change.
- **Review:** the change touches auth, tenant creation, the runtime role and the Prisma schema — `security-rls`, `qa-auditor` and `architect` review the diff before the PR.
