# Proposal

## Why

A standalone customer has no subsidiaries, but a facility must belong to a subsidiary. Today both paths that create an organisation create none: the operator CLI (`pnpm onboarding provision`) and self-service registration. The new administrator must therefore invent a subsidiary before adding a facility or entering data. The subsidiary form also asks for a facility up front. QA hit this in round 2 (Rev02 report).

The team decided (K1, item 4, team memo 2026-11-11; Decisions 2026-11-12) that the system creates a default subsidiary for a standalone customer in the background. The user can then add a facility straight away. This is change 4 of the six UAT2 changes (Next up).

## What Changes

- **Every new organisation is born with one subsidiary** (owner, 2026-11-12). The code cannot tell a standalone company from a holding, and neither the registration form nor the CLI asks. So the subsidiary is created for every organisation, not only standalone ones. A holding renames it to its first subsidiary, or deletes it while it is empty.
- **Both creation paths do it, in the same transaction as the organisation:**
  - operator provisioning of a new organisation;
  - self-service registration.

  Adding an administrator to an existing organisation (`--organisation-id`) and re-sending a registration create no subsidiary.
- **The default subsidiary** has:
  - the organisation's legal name, and its trading name and sector when the operator gave them;
  - the organisation's geography;
  - Scope 1 and 2 included, and tracking at subsidiary level, so data can be entered without a facility;
  - no facilities, no access grants and no inventory-boundary entry.

  It is then an ordinary subsidiary: renamed, edited, given facilities or deleted through the existing screens and rules. No schema column marks it.
- **Its audit row** has no acting user and names its source (`auth:registration`, or the operator). Like the organisation's row, it leaves the company name out (D20).
- **The CLI refuses a geography that no subsidiary can have.** Provisioning a new organisation refuses a `--geography-code` outside the subsidiary geographies (`UK`, `TR`, `EU`) before writing anything. Today it accepts any code matching its pattern.
- **Names keep a subsidiary's bounds** (owner, 2026-11-13, after review). Registration requires a company name of at least 2 characters; the page says so before sending. The CLI refuses a `--legal-name` outside 2 to 200 characters, and a `--trading-name` or `--sector` over 200. Without this, a default subsidiary could carry a name its own edit form refuses.
- **Existing organisations are not changed** (owner, 2026-11-12). There is no backfill: an organisation with no subsidiary keeps none until its administrator creates one.
- **No other web change.** The facility is added from the subsidiary's page or its facilities drawer, as today. The empty states stay for organisations without a subsidiary.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `organisation-hierarchy`: a new parent company starts with one default subsidiary. That subsidiary is ordinary, existing organisations are left as they are, and operator provisioning refuses a geography no subsidiary can have.
- `self-service-registration`: a valid registration also creates the default subsidiary, all or nothing. Its audit rows add one for the subsidiary, still without the company name. A company name needs at least 2 characters.

## Impact

- **API:**
  - `apps/api/src/auth/access-admin.service.ts` (`registerOrganisation`);
  - `apps/api/src/onboarding/onboarding-operator.ts` (`provision`, its dry-run plan);
  - `apps/api/src/onboarding/onboarding.cli.ts` (geography check, usage header);
  - a new shared writer in `apps/api/src/subsidiaries/`.
- **Web:** the registration form refuses a one-character company name (`apps/web/lib/auth-view.ts`, TR/EN copy).
- **Contracts:** one new shared constant (`REGISTRATION_COMPANY_NAME_MIN`); the registration endpoint now answers 400 to a one-character company name. No Prisma schema or migration change. The runtime role already has INSERT on `subsidiaries`.
- **Tests:**
  - unit specs for the access-admin, onboarding-operator and CLI argument parser;
  - `test/int/registration.int.spec.ts` and `test/int/onboarding.int.spec.ts`, whose audit-row counts change;
  - `e2e/registration.spec.ts`, whose cleanup already cascades through the organisation.
- **Docs:**
  - `docs/architecture/security.md` and `data-model.md`;
  - `docs/api/endpoints.md`;
  - `docs/md_docs/permissions_and_roles.md`;
  - `docs/development/commands.md`;
  - runbooks `11-qa-hosted.md` and `04-verify.md` §4.6, where they describe what provisioning creates.
- **Hosted QA:** organisations created before the deploy keep zero subsidiaries. New registrations and provisions get the default subsidiary.
