# Proposal

## Why

UAT round 2 (BUG-R2-03, P1 blocker) found that an entered record cannot be fully edited. QA asks that the activity value, the facility or location, the emission category, the reporting year and the period can all be corrected.

The API already updates every one of these fields in place on a draft or rejected record, recalculating the figure and writing an audit row. The gaps lie elsewhere:

- **Data Entry has no Edit action.** When a user changes the category, year or period of an opened record, the form drops the record and the next save creates a new one. That guard exists to stop an implicit overwrite: opening a Fuel Q3 draft, switching to Q4 and saving once rewrote the Q3 record.
- **A submitted record cannot go back to its author.** The database freezes its inputs, and no transition leads back to `draft`.
- **An approved record can only be voided (D04) and re-entered by hand.**
- **Evidence links survive a category change**, so an electricity invoice can satisfy a Water record's evidence gate.

The owner decided the design on 2026-11-10 (Decisions 2026-11-10 (fourth)).

## What Changes

- **Recall a submission.** The author of a `submitted` record can recall it to `draft` before review starts. `under_review` and later records cannot be recalled; they are corrected through rejection, as today. This adds one database lifecycle transition, `submitted>draft`, a new endpoint, a new audit action `recall`, and a refusal code for any other status.
- **Explicit Edit mode on Data Entry.** An Edit action on a draft or rejected record puts the form into Edit mode, where changing category, activity type, reporting year, period, location or value updates the same record (PATCH). A band shows what will change, with a Cancel button. A record opened without Edit (a list row or a dashboard deep link) behaves as today: moving its identity fields starts a new record.
- **Copy a voided record to a new draft.** A voided record offers "Copy to new draft", which pre-fills the form with its values. The subsidiary can be changed. Evidence is not copied. The action is offered to the voided record's author and to `super_admin`, and whoever copies becomes the new record's author. D04 itself is unchanged.
- **Only the author edits or recalls.** **BREAKING**: a `super_admin` can no longer edit a colleague's draft or rejected record; they reject it with a note instead. This closes the open segregation-of-duties gap (Open questions, 2026-10-03). Deleting a draft stays open to its author and to `super_admin`.
- **Evidence follows the record's identity.**
  - A category change must take every linked file off the record. The Edit band lists the files and warns that a file backing no other record is deleted. The user confirms before saving. The API refuses a category change that does not name every linked file for detaching.
  - Named files are detached in the same transaction as the edit. Each detach writes the audit row it writes today, and a file left with no link is deleted as today. A file can be attached only by uploading it, so a deleted file must be uploaded again.
  - A change of activity type, year, period or location asks the user, file by file, whether to keep or detach each one, with the same deletion warning.
  - A value change leaves the links alone.
- **Unchanged:** moving a record to another subsidiary stays refused (pending K1). The audit row shape stays a full before and after.

Out of scope, filed under Open questions: "Copy to new draft" on records that are not voided, and a per-record change-history view.

## Capabilities

### New Capabilities

- `record-lifecycle`: the activity record's statuses and who may move it between them or change it in each. This covers which statuses accept edits and from whom, recalling a submission, what moves are refused (between subsidiaries, out of review), how an approved record is corrected (void, then copy to a new draft), and the audit rows these write.

### Modified Capabilities

- `record-evidence`: a record's evidence links follow its identity. A category change detaches them, and other identity changes leave the choice to the user.
- `activity-data-entry`: the form's explicit Edit mode, the recall action, and "Copy to new draft" for a voided record.

## Impact

- **Database:** one migration redefining `activity_records_snapshot_immutable` to allow `submitted>draft`. Inputs stay frozen on that step. `runtime-role.mjs` derives the expected function body from the latest migration, so it needs no hand-edited pin. No table or column changes.
- **Contract (`@tonyai/shared-types`):**
  - the `recall` audit action;
  - a `record_not_recallable` error code with `params.status`;
  - an `evidence_detach_required` error code for a category change that leaves files attached;
  - `record_author_forbidden` reused for edit and recall by a non-author;
  - a recallable-status set beside `EDITABLE_STATUSES`;
  - the recall response type.
- **API:**
  - `POST /api/v1/activity-records/:id/recall`;
  - an author-only gate on update, split from the delete gate, which keeps `super_admin`;
  - an optional list of evidence ids to detach on update, applied in the edit's transaction, which must name every linked file when the category changes.
- **Web:**
  - `apps/web/app/data-entry/page.tsx` (Edit mode, change band, evidence keep or detach choice, recall, copy);
  - `apps/web/lib/record-identity.ts`;
  - `components/data-entry/previous-submissions.tsx`;
  - the `/emissions` record drawer (copy on a voided record);
  - `lib/api.ts`;
  - the TR and EN catalogues.
- **Tests:**
  - service unit tests, where the `super_admin` edits a colleague's record cases flip;
  - integration tests: the trigger transition, recall racing review, and detach on category change;
  - a new e2e covering an in-place identity edit, recall, and copy of a voided record.
- **Data:** none migrated. On hosted QA, a `super_admin` who edits other users' drafts now gets a refusal; QA is told in the PR notes.
- **Docs:** `docs/api/` (recall endpoint, error codes), `docs/architecture/data-model.md` (status workflow), `docs/md_docs/data_entry_page.md`, and the status file (Decisions, Current status, Open questions).
