# Tasks

## 1. Shared writer

- [x] 1.1 Add `apps/api/src/subsidiaries/default-subsidiary.ts` with `createDefaultSubsidiary(tx, audit, input)` (design D2). It inserts the row with explicit `pending`, `[1, 2]` and `subsidiary`, then writes one `recordSystem` `create subsidiary` row whose diff is the caller's source plus `default: true` and the four settings, with no name, trading name or sector. Verify with a DB-free spec (`default-subsidiary.spec.ts`) asserting the insert payload, the audit diff's exact keys and that both use the given `tx`.

## 2. Self-service registration

- [x] 2.1 Call the writer in `AccessAdminService.registerOrganisation` after the organisation's audit row (design D3), with the trimmed company name and `REGISTRATION_ORGANISATION_DEFAULTS.geographyCode`, and update its JSDoc. Verify in `access-admin.service.spec.ts` that the mocked transaction receives `subsidiary.create` and four audit rows, and that a throw from `subsidiary.create` rejects the call.
- [x] 2.2 Update `apps/api/test/int/registration.int.spec.ts`:
  - one subsidiary named by the company name, geography `TR`, tracking `subsidiary`, no locations, no grants;
  - four audit rows, the subsidiary's carrying `source: 'auth:registration'`;
  - no audit diff containing the company name;
  - a re-submission creates no second organisation or subsidiary.

  Verify that `pnpm --filter @tonyai/api test:int registration` passes.
- [x] 2.3 Extend `e2e/registration.spec.ts`. After the invitation is accepted, the new administrator sees one subsidiary on the subsidiaries screen. Before any facility exists, Data Entry offers the subsidiary and a record without a facility is accepted (then removed); a facility is then added through the subsidiary's facilities drawer. Verify that the spec passes locally and that teardown still removes everything through the organisation cascade.

- [x] 2.4 Require a company name of at least 2 characters (`REGISTRATION_COMPANY_NAME_MIN`) in `RegistrationDto` and in the web form's `registrationProblem`, with TR/EN copy `register.companyNameTooShort` (design D5, added after review). Verify with `users.dto.spec.ts` (1 character refused, 2 accepted) and `auth-view.spec.ts`.

## 3. Operator provisioning

- [x] 3.1 In `onboarding.cli.ts`'s `parseArgs`, refuse a `--geography-code` outside `GEOGRAPHY_CODES` with a `UsageError` naming them (design D4), and update the usage header. Verify in `onboarding.cli.spec.ts` that `DE` is refused, that `tr` parses as `TR`, and that `--organisation-id` needs no geography.
- [x] 3.2 Call the writer in `OnboardingOperator.provision`'s new-organisation branch with the operator's legal name, trading name, sector and geography, and the `operatorDiff('provision', …)` source. Add `subsidiary: { created }` to the dry-run result and `subsidiary: { id, created }` to the applied result, and have the CLI print it. Verify with unit specs in `onboarding-operator.spec.ts`. The dry run reports `created: true` and writes nothing. The `--organisation-id` branch and the re-send branch report `created: false` and never call `subsidiary.create`.
- [x] 3.3 Update `apps/api/test/int/onboarding.int.spec.ts` ("the operator CLI"):
  - the audit rows become `[create organisation, create subsidiary, invite invitation]`;
  - the subsidiary carries the trading name and sector given;
  - adding an administrator by `--organisation-id` leaves the subsidiary count unchanged;
  - an unsupported geography writes nothing.

  Verify that `pnpm --filter @tonyai/api test:int onboarding` passes.

- [x] 3.4 Refuse `--legal-name` outside 2 to 200 characters and `--trading-name` or `--sector` past 200 in `parseArgs` (design D5, added after review). Verify in `onboarding.cli.spec.ts` that each is refused and the bounds are accepted.

## 4. Docs

- [x] 4.1 Update the docs that state what an organisation is created with. Verify each by grep that no file still says provisioning or registration creates only the organisation, admin and invitation.
  - `docs/architecture/security.md` (provisioning, registration);
  - `docs/architecture/data-model.md` (organisations and subsidiaries rows);
  - `docs/api/endpoints.md` (`/auth/registration`);
  - `docs/md_docs/permissions_and_roles.md` (operator provision row);
  - `docs/development/commands.md` (`pnpm onboarding`, geography list);
  - `infra/runbooks/11-qa-hosted.md` and `infra/runbooks/04-verify.md` §4.6.
- [x] 4.2 File the open question "default subsidiary badge or hint for holdings" under Open questions in `docs/roadmap_docs/project_status_roadmap_phases.md` (design, Risks). Verify that the entry exists and names this change.

## 5. Integration checks

- [x] 5.1 Run `pnpm typecheck`, `pnpm test` and `pnpm build` from the root. Verify that all three are green.
- [x] 5.2 Run `pnpm --filter @tonyai/api test:int` (with the CI rate-limit env) and the e2e specs `registration`, `users-access` and `rbac-tenant`. Verify that they pass; known local-only failures are named in the PR.
- [x] 5.3 Fresh-eyes review before the PR, because tenant data and audit rows change. Spawn `security-rls` and `qa-auditor` in parallel on the branch diff, probing:
  - that the runtime-role registration write stays inside its transaction;
  - that no audit row leaks the company name;
  - that no subsidiary is created on the `--organisation-id`, re-send or re-submission paths;
  - that the geography refusal happens before any write.

  Fix the P1 and P2 findings and file the rest under Open questions. Verify that the reviewers' verified lists are recorded in the PR body.
- [x] 5.4 Run `openspec validate uat2-standalone-default-subsidiary --strict`. Verify that it passes.

## Workflow follow-up

- Commit and open the PR only when the owner asks; the owner merges.
- After the merge: confirm the QA deploy, register one test company on hosted QA, check its one subsidiary and add a facility, then tell QA which organisations predate the deploy and so have no subsidiary.
- Archive the change: sync the two deltas, and add a Current status entry and an update to Next up (change 5, `uat2-anomaly-typo-ceiling`) in the status file, in an archive PR.
