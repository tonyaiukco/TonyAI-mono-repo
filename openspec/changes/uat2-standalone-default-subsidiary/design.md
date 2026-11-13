# Design

## Context

Two code paths create an organisation, and neither creates a subsidiary:

- **Self-service registration:** `AccessAdminService.registerOrganisation` (`apps/api/src/auth/access-admin.service.ts`). It runs on the runtime role (`tonyai_runtime`), as a background job queued by `RegistrationService`. In one transaction it writes:
  - the organisation, with `REGISTRATION_ORGANISATION_DEFAULTS` `TR/TR/TRY`;
  - the `super_admin` profile;
  - the invitation;
  - the consent;
  - three `recordSystem` audit rows (organisation, invitation, consent).
- **Operator provisioning:** `OnboardingOperator.provision` (`apps/api/src/onboarding/onboarding-operator.ts`). It runs as the tables' owner (`DIRECT_URL`). For a new organisation it writes the organisation, the profile and the invitation, with two `recordSystem` audit rows. It also has a dry run, a re-send branch for an existing address, and an `--organisation-id` branch that adds an administrator to an existing organisation.

**Subsidiaries:**

- A subsidiary requires only `organisationId`, `legalName` and `geographyCode`. The database defaults are `reportingStatus = pending`, `includedScopes = [1,2]` and `trackingGranularity = subsidiary`.
- A location requires a subsidiary.
- An activity record's `locationId` is optional, so a subsidiary tracked at subsidiary level takes records without a facility.
- `super_admin`, `consultant` and `executive_viewer` see every subsidiary of their organisation, which the guard reads per request. No grant is needed.
- The runtime role already has INSERT on `subsidiaries`.
- `reportingStatus` only feeds counts and badges.
- Inventory boundaries are explicit versions that a `super_admin` writes, and live totals do not depend on them.

**Constraints:**

- `SubsidiariesService.create` requires a `RequestUser` (`assertCanWrite`, `audit.record`). Neither creation path has one.
- The registration spec keeps the company name out of every audit row (D20). The normal subsidiary audit row (`diff.after = toDTO`) contains the legal name.

## Goals / Non-Goals

**Goals:**
- One writer for the default subsidiary, shared by both paths and inside their existing transactions.
- No schema, migration, contract or web change.

**Non-Goals:**
- **Backfill** of existing organisations (owner, 2026-11-12).
- A "standalone or holding" question at registration or in the CLI.
- A marker column or a "default" badge.
- Auto-ticking the default subsidiary when inviting a Data Entry user.
- Adding the subsidiary to an inventory boundary.

## Decisions

### D1. Create for every new organisation, not only standalone ones

Owner choice, 2026-11-12. Nothing in the data or the forms distinguishes a standalone company. A wrong guess costs a holding one rename or one delete of an empty subsidiary. Both are existing operations, and the deletion blockers still protect a subsidiary that has data.

Alternatives considered:
- **Ask at registration and add a CLI flag:** needs form, spec and e2e changes, and adds a question the pilot holding never needs.
- **Create lazily on "add facility":** contradicts the team's "in the background".

### D2. A small trusted writer in the subsidiaries module

`apps/api/src/subsidiaries/default-subsidiary.ts` exports `createDefaultSubsidiary(tx, audit, { organisationId, legalName, tradingName?, sector?, geographyCode, source })`, where `source` is typed `{ source: string; operator?: string }` so that no caller can put a name in it. It returns the id and:

1. inserts the row with explicit values: `reportingStatus: 'pending'`, `includedScopes: [1, 2]`, `trackingGranularity: 'subsidiary'`. The values are written out rather than left to database defaults, so a change of default cannot silently change the default subsidiary.
2. writes `audit.recordSystem({ action: 'create', entity: 'subsidiary', entityId, diff })` with the same `tx`.

`source` is the registration's `{ source: 'auth:registration' }`, or the operator's `operatorDiff('provision', …)` payload. Each caller already builds its own source shape, so the writer takes the diff prefix as given and appends the rest.

The audit diff is `{ ...source, default: true, geographyCode, includedScopes, trackingGranularity, reportingStatus }`. It has no `legalName`, `tradingName` or `sector`:
- the registration spec forbids the company name;
- the organisation's own provisioning row already omits it, so the operator path follows suit.

Alternatives considered:
- **Calling `SubsidiariesService.create` with a synthetic `RequestUser`:** this would fake an actor in `audit_log`, whose `userId` and `role` must stay null for system rows. It would also put the legal name in the diff and drag the DTO's validation in.
- **A database trigger on `organisations` insert:** invisible to the application, it would write no audit row of the required shape and would fire on test fixtures.

### D3. Where each path calls it

- **`registerOrganisation`:** after the organisation's audit row and before the profile. It uses `legalName: input.companyName.trim()` and `geographyCode: REGISTRATION_ORGANISATION_DEFAULTS.geographyCode`. `reopenRegistration` is unchanged.
- **`provision`:** inside the `else` branch that creates the organisation, after its audit row. It uses the operator's `legalName`, `tradingName`, `sector` and `geographyCode`. The `--organisation-id` branch, the re-send branch and the dry run write nothing. The dry-run result gains a `subsidiary: { created: boolean }` field (`true` for a new organisation, `false` otherwise), and the applied result gains `subsidiary: { id, created }`. The CLI prints it with the rest of the plan.

### D4. The CLI validates the geography against `GEOGRAPHY_CODES`

`parseArgs` already upper-cases `--geography-code`. It now refuses a code outside `GEOGRAPHY_CODES` (from `@tonyai/shared-types`) with a `UsageError` listing them. The check applies only to provisioning a new organisation, since `--organisation-id` takes no geography.

A subsidiary's geography is guarded by the same list in its DTO, and by a trigger after insert. Refusing at the CLI is earlier and clearer than creating an organisation whose default subsidiary could not legally exist.

Alternative considered: skip the subsidiary for an unknown geography. That would leave two behaviours to explain and test, for no pilot need.

### D5. Names keep a subsidiary's bounds

A subsidiary's legal name is 2 to 200 characters, and its trading name and sector at most 200 (`SUBSIDIARY_TEXT_MAX_LENGTH`). The detail page re-sends `legalName` on every edit, so a default subsidiary outside those bounds could not be edited until renamed. Both reviews flagged this, and the owner chose to fix it (2026-11-13):

- **Registration:** the company name needs at least 2 characters (`REGISTRATION_COMPANY_NAME_MIN` in shared-types, read by the DTO and by the web form, which says so before sending). Its 200 maximum already matches.
- **CLI:** `--legal-name` must be 2 to 200 characters, and `--trading-name` and `--sector` at most 200. Each is refused in `parseArgs` before anything connects.

Alternative considered: truncating or padding in the writer. It would store a name nobody typed.

## Risks / Trade-offs

- **[Risk] A holding sees a subsidiary named after the parent company, and may sum its holding-level data there.** → This is an ordinary subsidiary that they rename or delete. The QA note for this change says so. A badge or hint is filed under Open questions, not built (pilot rule: non-defects are filed, not fixed).
- **[Risk] Hosted QA has organisations with no subsidiary, and new ones with one.** → This is the owner's choice (no backfill). The existing empty states remain correct for the old ones. QA is told which organisations predate the deploy.
- **[Risk] Integration tests assert exact audit counts and "no subsidiary".** → They are updated in the same tasks group as the code: registration rows go from 3 to 4, provisioning rows from 2 to 3.
- **[Trade-off] The audit row omits the name**, so the subsidiary's creation row cannot show what it was first called. → The organisation's legal name is the source, and any later rename is audited by the normal update path.

## Migration Plan

- No database migration. A deploy through the normal QA pipeline is enough.
- No runbook 03 preflight is needed.
- Rollback is a revert. Subsidiaries already created stay as ordinary rows.
- After the deploy, register one test company on hosted QA and check that it has one subsidiary and can add a facility.
