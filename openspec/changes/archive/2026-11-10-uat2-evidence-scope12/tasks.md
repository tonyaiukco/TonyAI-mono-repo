# Tasks

## 1. Contract: the evidence-required set and the approve code

- [x] 1.1 In `packages/shared-types/src/index.ts`, add Mobile Combustion, Refrigerants and Fugitive Gas to `EVIDENCE_REQUIRED_CATEGORIES` in `CATEGORIES` order (design D1). Update its JSDoc (K3, 2026-11-10, and Water's WP17 reason) and the evidence table in the `INVOICE_TRACKED_CATEGORIES` doc, leaving `INVOICE_TRACKED_CATEGORIES` itself unchanged. Verify with `pnpm typecheck`.
- [x] 1.2 Register the approve refusal code (`approval_evidence_missing`): HTTP 400, frozen params `['category']`, next to `evidence_required` (design D3). Verify with the registry and param-list tests in `apps/api/src/common/api-error.spec.ts` and the shared-types tests.
- [x] 1.3 Extend `packages/shared-types/src/index.spec.ts`:
  - Every category whose `CATEGORY_SCOPE_MAP` scope is 1 or 2 is evidence-required.
  - Among Scope 3 categories, only Water is.
  - Waste and Business Travel are not.
  - `needsEvidenceBeforeSubmit` is true for each of the three new categories with 0 files and false with 1.

  Update the existing "the list and nothing else" assertions. Verify with `pnpm --filter @tonyai/shared-types test`, then rebuild `dist` (`pnpm --filter @tonyai/shared-types build`).

## 2. API: the submit set and the approve gate

- [x] 2.1 Add an `it.each` over the three categories to `apps/api/src/activity-records/activity-records.service.spec.ts`.
  - With 0 files, submit is refused with `EvidenceRequiredError` naming the category. Nothing is updated, no audit row is written, and the count is scoped to the record.
  - With 1 file, submit succeeds.

  Add these cases too:
  - A rejected Refrigerants resubmit with 0 files is refused.
  - A Waste submit with 0 files succeeds, and the count is never queried.

  Verify with `pnpm --filter @tonyai/api test`.
- [x] 2.2 Add the new error class to `apps/api/src/activity-records/errors.ts`. In `ActivityRecordsService.approve`, add the evidence count under the row lock, after the period-lock check and before C8 (design D2). Run the count query only when the category could need a file.

  Add unit tests:
  - Submitted and under-review Mobile Combustion and Fugitive Gas with 0 files are refused with the new code. No transition and no audit row.
  - With 1 file, approve succeeds.
  - Waste with 0 files is approved.
  - Self-approval and period lock are named before evidence.
  - Evidence is named before C8 and before K11.

  Verify with `pnpm --filter @tonyai/api test`.
- [x] 2.3 Fix the `bulk-upload.service.spec.ts` expectations for Mobile Combustion (MGO included), Refrigerants and Fugitive Gas rows, which now carry the `evidence_required` warning. Add one Mobile Combustion row case and one Fugitive Gas row case. Add a `bulk-submit.service.spec.ts` or `import-batches` case: a batch with a Refrigerants draft without a file and a Waste draft sends only the Waste draft. Verify with `pnpm --filter @tonyai/api test`.
- [x] 2.4 Add an `emissions.service.spec.ts` case: an approved Refrigerants record with no file leaves its month's tracking cell incomplete, with `evidenceMissing` set. Verify with `pnpm --filter @tonyai/api test`.
- [x] 2.5 Add an integration spec on the real database for a Fugitive Gas or Mobile Combustion record:
  - Submit without a file is refused; attach a file, then submit succeeds.
  - A record moved to submitted with no file (as before the rule) is refused at approve; reject it, attach a file, resubmit, then approve succeeds.

  Verify with `pnpm --filter @tonyai/api test:int`.
- [x] 2.6 Update `docs/api/endpoints.md`: name the evidence-required set at submit, and add the approve refusal with its code. Verify that the text names the same categories and code as the code.

## 3. Web: Data Entry pre-check and copy

- [x] 3.1 In `apps/web/app/data-entry/page.tsx` `handleSubmit`, after `persist()` and before the anomaly check, return with a toast when `needsEvidenceBeforeSubmit({ category, evidenceCount })` is true (design D4). Use the saved record's `evidenceCount`, which create and update return. Verify with a web Vitest case if the logic is factored into a view helper, and otherwise in 3.3's e2e test.
- [x] 3.2 Use the `localise-ui` skill for the copy (design D5):
  - The pre-check toast in `dataEntry`.
  - A broadened `requiredNote` in `evidence.json`.
  - The approve refusal in `errors.json`, in TR and EN.

  Also fix the stale category comment in `apps/web/lib/bulk-submit-view.ts`. Verify with the catalogue parity tests and the web Vitest run.
- [x] 3.3 Extend `e2e/data-entry-tr-inputs.spec.ts` (or `e2e/gates.spec.ts`) with this flow:
  - A new TR Mobile Combustion record and Submit: the record is saved as a draft, the vault is visible, the toast is shown and the status is not submitted.
  - Upload a file and Submit again: the record is submitted.

  Add a review-page case: approving a submitted record without a file shows the approve refusal copy. Update the fixture notes in `docs/development/testing.md` and the evidence line in `.claude/skills/e2e-flow/SKILL.md`. Verify with `pnpm e2e -- data-entry-tr-inputs` (and `gates` if used).
- [x] 3.4 Update `docs/md_docs/data_entry_page.md` (the evidence section names the three categories) and the seed comments in `packages/db/prisma/seed.ts`. Verify that no doc still lists only Electricity, Natural Gas and Fuel as evidence-required (`grep` the docs).

## 4. Integration and review

- [x] 4.1 Run `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm --filter @tonyai/api test:int` and the affected e2e specs. Verify that all are green, and record the counts in the PR description.
- [x] 4.2 Run the fresh-eyes review before opening the PR: `security-rls`, `qa-auditor` and an `architect` contract review (new error code, shared list) in parallel on the branch diff. Each reviewer reports what it verified. Resolve or file every finding, and verify that the re-run checks from 4.1 stay green.
- [x] 4.3 Update the status file in the same PR:
  - Current status: K3 and its PR, and the owner's five hosted MGO smoke checks PASS (2026-11-10, owner-reported).
  - The ledger and Next up.
  - Feature summaries that name the old evidence set.

  Verify that no other status or roadmap file was created.

## Workflow follow-up

- Open the PR from `feat/uat2-evidence-scope12` with green CI. The owner merges it, and the merge deploys to QA.
- After the deploy, a read-only count on hosted QA of records with no file: `submitted` and `under_review` in every evidence-required category (approve now checks all seven, not just the three new ones), and `approved` and `locked` in Mobile Combustion, Refrigerants and Fugitive Gas. The owner then knows what reviewers and the dashboard will show.
- Archive the change after the merge is recorded.
