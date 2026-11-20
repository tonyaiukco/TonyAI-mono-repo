# Tasks

## 1. Status and class (one commit)

- [x] 1.1 In `packages/shared-types/src/index.ts`:
  - set `no_factor`, `placeholder_refused`, `no_conversion` and `calorific_basis_mismatch` to 422 in `CALCULATION_REFUSAL_STATUS`;
  - widen its value type and `CalculationRefusalBody.statusCode` to `400 | 404 | 409 | 422`;
  - update the doc comment above the map.

  Verify: `pnpm typecheck` passes.
- [x] 1.2 In `apps/api/src/calculations/errors.ts`, make `NoEmissionFactorError` extend `UnprocessableEntityException` with a `statusCode: 422`, `error: 'Unprocessable Entity'` body, and rewrite its comment (design D2). Update `errors.spec.ts` to expect 422, and add a case that runs each coverage code through `toErrorBody(422, …)` and keeps its `code` and `coverage`. Verify: `pnpm --filter api test` passes, and the new case fails if either the map or the class is reverted alone.
- [x] 1.3 Update `apps/api/src/common/api-error.spec.ts` (the `no_factor` body at 422, plus a case that a `no_factor` thrown at 404 is downgraded to the generic code) and `calculations.service.spec.ts` (the `statusCode: 404` body and the "keeps the 404 … cap" case become 422). Relabel the "(404)" cases in `activity-records.service.spec.ts`. Verify: `pnpm --filter api test` passes.

## 2. Bulk submit guard

- [x] 2.1 In `apps/api/src/bulk-upload/bulk-submit.service.ts`, add a branch before the `NotFoundException` fallback: a `NoEmissionFactorError` or `FactorLibraryConflictError` maps to `calculation_stale` (design D2). Add a `bulk-submit.service.spec.ts` case that throws a raw `NoEmissionFactorError` from the submit path and asserts `calculation_stale`, never `not_found`. Verify: the case passes, and it fails without the branch.
- [x] 2.2 Confirm the bulk importer still reports `no_factor` for an unpriceable row, and `not_found` for a foreign entity. Run the existing `bulk-upload.service.spec.ts` cases, and run `grep -rn "instanceof NotFoundException" apps/api/src` to check that no other catch depends on the coverage class being a `NotFoundException`. Verify: the specs pass, and the grep lists only the two bulk services.

## 3. Integration and web

- [x] 3.1 Run `pnpm --filter api test:int` against the local stack. Update any integration assertion of a coverage refusal's status to 422. Keep `factor-model.int.spec.ts` "answers a foreign subsidiary with the plain 404" passing unchanged. Verify: `test:int` passes. *Result (2026-11-20): 31 of 34 files pass, `factor-model.int.spec.ts` (foreign subsidiary plain 404) included. The other 3 files (`tenant-isolation`, `reporting-context-reconciliation`, `report-issuance`) fail 255 cases with 429 `rate_limited` against the local stack, the same 255 on `main`'s API, so they are environmental. CI's `api-integration` job runs them.*
- [x] 3.2 Update `apps/web/lib/i18n/errors.spec.ts` (`ApiError("API 404", 404, "no_factor")` → 422). Run `grep` for any web branch on a coverage status. Verify: `pnpm --filter web test` passes, and nothing in `apps/web` keys on 404 for these codes.
- [x] 3.3 Against the running app, create a record with no covering factor (for example UK electricity in an uncovered year) and confirm a 422 body with `code: no_factor` and `coverage`. Check that Data Entry shows the same localised refusal as before (EN and TR), and that a foreign subsidiary still answers the plain 404 (`subsidiary_not_found`). Verify: the request and response pairs are recorded for the PR body. *Result: own subsidiary, UK electricity 2031 → 422 `no_factor` with `coverage`; an unknown subsidiary → 404 `subsidiary_not_found`, no library fields. Data Entry's wording keys on `code` (`describeApiError`, covered at 422 by `apps/web/lib/i18n/errors.spec.ts`); it was not re-checked in a browser, because no selectable year is uncovered.*

## 4. Docs, status and review

- [x] 4.1 Update `docs/api/endpoints.md`: the factor-model paragraph states the status of each refusal family, and no line calls a coverage refusal a 404. Check that `docs/architecture/localisation.md` ("Error body") implies no 404 for them. Verify: `grep -n "404" docs/api/endpoints.md` shows no coverage refusal at 404.
- [x] 4.2 Update `docs/roadmap_docs/project_status_roadmap_phases.md`:
  - a Current status entry, under the ten-entry rule;
  - Next up, item 4: change 2 of round 3 done;
  - the LP4-06 dependency met.

  Verify: Current status holds at most ten entries.
- [x] 4.3 This touches the calculation path, so run the fresh-eyes pass: `security-rls` (no tenant-isolation leak, the foreign 404 unchanged, no new information in a 422 body) and `qa-auditor` (every surface of a coverage refusal, the bulk paths) in parallel, on the diff. Fix every correctness finding. Verify: what each seat verified and found is recorded for the PR body.
- [x] 4.4 Run typecheck, lint, `pnpm build`, `pnpm test` and `openspec validate calc-refusal-422 --strict`. Verify: all pass.

## Workflow follow-up

- Branch `fix/calc-refusal-422` off `origin/main`. Commit and push on the owner's word. The owner merges, and the QA deploy runs on merge.
- Archive with `/opsx:archive`, syncing the `emission-calculation` delta, then record the PR number.
- Next: `/opsx:propose ng-kwh-engine` (LP4-06).
