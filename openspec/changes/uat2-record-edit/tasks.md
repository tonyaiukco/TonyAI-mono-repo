# Tasks

## 1. Contract: recall, the new codes and the update request

- [x] 1.1 In `packages/shared-types/src/index.ts`:
  - Add `recall` to `AUDIT_ACTIONS`, with a JSDoc saying why it is its own verb.
  - Add `RECALLABLE_STATUSES = {submitted}` beside `EDITABLE_STATUSES`.
  - Add `detachEvidenceIds?: string[]` to the update request type.
  - Add the recall response type, if it differs from `ActivityRecordDTO`.

  Verify with `pnpm typecheck`.
- [x] 1.2 Register `record_not_recallable` (400, params `['status']`) and `evidence_detach_required` (400, params `['linked']`) in the error registry (design D6). Verify with the registry and param-list tests in `apps/api/src/common/api-error.spec.ts` and the shared-types tests, then rebuild `dist` (`pnpm --filter @tonyai/shared-types build`).

## 2. Database: the recall transition

- [x] 2.1 Generate a new migration `…_uat2_record_recall`. It re-creates `activity_records_snapshot_immutable` from its body in `20261105130000_lp4_02_record_parameters`, byte for byte, and adds only `'submitted>draft'` to the allowed array (design D2). Inspect it for the spurious `DROP INDEX activity_records_reporting_entity_period_category_key` and delete that line if present. Verify:
  - `pnpm db:migrate` applies the migration.
  - The `runtime-role.mjs` integrity check passes against the new body.
- [x] 2.2 Add integration tests (`apps/api/test/int/`):
  - `submitted` → `draft` is accepted.
  - `under_review` → `draft` and `approved` → `draft` are refused with TA001.
  - One write that moves `submitted` → `draft` and changes `activity_value` is refused with TA001.
  - A non-runtime writer moving `submitted` → `draft` is refused with TA005.

  Verify with the integration suite.
- [x] 2.3 Update the status workflow in `docs/architecture/data-model.md` with the recall step and the author-only edit rule.

## 3. API: recall

- [x] 3.1 Add `ActivityRecordsService.recall` in the order of design D1. In `transition`, clear `submittedAt` when the target is `draft`, and set `TRANSITION_ACTIONS[draft] = 'recall'`. Add the error class to `errors.ts` and `POST :id/recall` to the controller. Verify with unit tests in `activity-records.service.spec.ts`:
  - The author recalls a submitted record: it becomes a draft, inputs unchanged, `submittedAt` null, a `recall` audit row written.
  - A `super_admin` who is not the author is refused with `record_author_forbidden`.
  - A consultant is refused.
  - `under_review`, `approved`, `rejected` and `draft` are refused with `record_not_recallable` naming the status.
  - A locked period is refused.
  - Another tenant's record answers 404.
- [x] 3.2 Add integration race tests:
  - Recall against `startReview` on the same submitted record, run concurrently: exactly one succeeds and the end state is `draft` or `under_review`.
  - The same for recall against `approve`.

  Verify with the integration suite.
- [x] 3.3 Document the endpoint, its refusal order and its codes in `docs/api/` (the activity-records endpoints file and the error-code list).

## 4. API: the author-only edit gate

- [x] 4.1 Split `assertCanMutate` into `assertCanEdit` (author only) for `update` and `assertCanDelete` (author or `super_admin`) for `remove` (design D3). Change the `record_author_forbidden` message so it fits edit, submit and recall alike. Update the TR and EN copy for that code. Verify with unit tests:
  - Flip the existing case where a `super_admin` edits a colleague's draft: now refused with `record_author_forbidden`, nothing written.
  - A `super_admin` editing their own draft succeeds.
  - A `super_admin` deleting a colleague's draft still succeeds.
  - Sending `subsidiaryId` on update is still refused.
- [x] 4.2 Find and fix every other test or fixture that relied on a `super_admin` editing someone else's record: unit, integration and e2e (`grep` for update calls made with admin tokens on records created by others). Verify with the full API unit and integration suites.
- [x] 4.3 Document the edit rule in `docs/api/` and add an "author-only edit" note to `docs/architecture/` (security or data model, wherever D01 and D02 live).

## 5. API: evidence on update

- [x] 5.1 Move the core of `EvidenceService.detach` into a transaction-scoped helper. It takes the file row locks, deletes the links, deletes rows left unlinked, writes the audit rows, and returns the blob paths to remove. `detach` keeps its behaviour on top of the helper. Verify with the existing evidence unit and integration tests, unchanged and green.
- [x] 5.2 Add `detachEvidenceIds` (UUID array, capped) to `UpdateActivityRecordDto`. In `update`'s transaction, apply design D4:
  - lock the named files after the record row lock;
  - refuse a named file that is not linked with `evidence_not_found`;
  - refuse a category change that leaves a linked file unnamed with `evidence_detach_required`;
  - write the record, then call the helper;
  - after commit, remove blobs through the storage-intent path.

  Verify with unit tests:
  - A category change naming every file succeeds, with one audit row per file.
  - A category change naming a subset is refused and writes nothing.
  - A category change with no files needs no list.
  - A period move with no list keeps every file.
  - A period move naming one file detaches only that file.
  - A value-only edit with a list detaches the named file.
  - A foreign file id is refused.
- [x] 5.3 Add integration tests:
  - A category change refused as a duplicate leaves every file linked. The transaction rolls back.
  - Detaching the last link deletes the file row and queues its blob removal. A shared file stays linked to the other record.
  - A category change racing a separate detach of the same file ends consistent, with no deadlock.

  Verify with the integration suite.
- [x] 5.4 Document `detachEvidenceIds` and `evidence_detach_required` in `docs/api/`.

## 6. Web: Edit mode

- [x] 6.1 Add `describeEdit(original, form, labels, copy)` in a new pure module `apps/web/lib/record-edit-view.ts` (beside `evidencePlan`, `recordActions` and `copyPrefill`), returning one from-to line per changed identity field. Keep `hasMovedOffRecord` in `record-identity.ts` unchanged. Verify with `record-edit-view.spec.ts` cases: no change, a category change, a type change, a period change, a year change, a location change, several changes at once, and Turkish copy.
- [x] 6.2 In `apps/web/app/data-entry/page.tsx`, add the `editMode` state (design D5):
  - the Edit action on the opened record;
  - the band with Cancel;
  - while in Edit mode, the moved-off effect does not drop the record;
  - a category change clears the type, unit, parameters and inputs;
  - a subsidiary change leaves Edit mode;
  - Save sends the PATCH with `detachEvidenceIds` through `lib/api.ts`.

  Verify with web unit tests for the pure helpers the page uses, and with `pnpm typecheck`.
- [x] 6.3 Add the evidence part of the band:
  - On a category change, every file is listed with the deletion warning, and Save stays disabled until the user confirms.
  - On a type, year, period or location change, each file gets a keep or remove toggle, defaulting to keep.

  Map `evidence_detach_required` and `evidence_not_found` to their toasts. Verify with web unit tests of the view helper that decides the list, the toggles and the confirmation state.
- [x] 6.4 Show Edit in `components/data-entry/previous-submissions.tsx` only on the user's own draft and rejected rows in unlocked periods, using the same predicate as the API's gate. Verify with a unit test of the predicate: author vs `super_admin` vs other user, each status, locked period.
- [x] 6.5 Add TR and EN copy for Edit, the band, the evidence warning and confirmation, and the two new error codes, following the `localise-ui` skill. Verify with the catalogue parity test.
- [x] 6.6 Update `docs/md_docs/data_entry_page.md` with Edit mode, the band and the evidence choice.

## 7. Web: recall and copy to new draft

- [x] 7.1 Add `api.recallActivityRecord(id)` to `lib/api.ts`. In Previous submissions, add Recall on the user's own `submitted` rows, with a TR and EN confirmation dialog. Refresh the list after a recall. Map `record_not_recallable` to its own toast ("in review; only the reviewer can return it"). Verify with a unit test of the row-action predicate and with `pnpm typecheck`.
- [x] 7.2 Add Copy to new draft:
  - On voided rows in Previous submissions and in the `/emissions` record drawer of a voided record, for its author and for `super_admin`.
  - Both route to `/data-entry?copyFrom=<id>`.
  - The page loads the record, fills every field, keeps `editingId` and `editMode` null, and leaves the subsidiary selectable.
  - A subsidiary change clears the location.

  Verify with a unit test of the prefill mapping (voided record to form state, no evidence, no id) and of the visibility predicate.
- [x] 7.3 Add TR and EN copy for Recall, its dialog and Copy to new draft. Document both in `docs/md_docs/data_entry_page.md`. Verify with the catalogue parity test.

## 8. Integration checks

- [x] 8.1 Add an e2e spec (the `e2e-flow` skill), covering:
  - In Edit mode, a data_entry user changes a draft's category and period. The band shows both changes, the evidence confirmation is required, and after saving the same record id holds the new identity, with no second record.
  - The user recalls a submitted record, edits it, and submits it again.
  - A `super_admin` voids an approved record, its author copies it to a new draft, attaches a file, and submits.

  Keep `e2e/analytics.spec.ts` "moving the form off a loaded record stops targeting it" green. Verify with the e2e run, using CI's `RATE_*_PER_MINUTE=10000` and `TONYAI_TEST_PASSWORD`.
- [x] 8.2 Run the full gate: `pnpm typecheck`, `pnpm build`, `pnpm test`, the integration suite and the e2e suite. Record the counts. Exercise the three flows by hand in the browser against the local stack, in TR and EN.
- [x] 8.3 Fresh-eyes review before the PR (CLAUDE.md: lifecycle, SoD, migration and contract). Run `security-rls`, `qa-auditor` and an `architect` seat in parallel on the diff. Fix P0 and P1 findings; file the rest under Open questions. Re-review if a second material design lands.
- [x] 8.4 In `docs/roadmap_docs/project_status_roadmap_phases.md`:
  - **Decisions:** "2026-11-10 (fourth)", with the seven decisions and D1 for evidence.
  - **Current status:** the entry, keeping ten entries, with the oldest moved to Archive.
  - **Next up:** BUG-R2-03 done.
  - **Open questions:** copy on non-voided records, a change-history view, `super_admin` evidence changes on a colleague's draft. Remove the 2026-10-03 SoD gap, now closed.

  Write the QA note on the `super_admin` edit change into the PR description.

## Workflow follow-up

- Open the PR from `feat/uat2-record-edit`. The owner runs runbook 03's migration preflight before merging, and the owner merges.
- After the merge, confirm CI, Integration and the QA deploy (which applies the migration) are green, and record the run ids in the status file.
- Archive the change (`/opsx:archive`), which creates the `record-lifecycle` spec and merges the deltas, and verify the archived result.
