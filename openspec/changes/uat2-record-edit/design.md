# Design

## Context

See proposal.md for why. The relevant state today:

```text
 draft --submit--> submitted --review--> under_review --approve--> approved <--> locked
   ^                  |                       |                       |
   |                  +--------reject---------+                       +--void--> voided
   x (no way back)    v
                   rejected --resubmit--> submitted

 edit (PATCH)     : draft, rejected   -- author OR any super_admin (assertCanMutate)
 delete           : draft, rejected   -- same gate
 inputs frozen    : every other status (trigger activity_records_snapshot_immutable, TA001)
 status changes   : only the API's runtime role (activity_records_lifecycle_writer, TA005)
```

- **Update.** `ActivityRecordsService.update` already recomputes the snapshot, re-scores the anomaly, lock-checks both the current and the target period, maps P2002 and TA002 to a duplicate or slot conflict, and writes one `update` audit row with the record before and after. Its DTO accepts every identity field except `subsidiaryId`.
- **Data Entry.** The form has no explicit edit state. `editingId` is set whenever a record is loaded. `hasMovedOffRecord` (`apps/web/lib/record-identity.ts`) drops it when category, year or period changes, because an implicit overwrite once rewrote a Fuel Q3 record into Q4 (`e2e/analytics.spec.ts`, "moving the form off a loaded record stops targeting it").
- **Evidence.** A file is linked only at upload. Detaching its last link deletes the file and its blob (`evidence.service.ts`, `detach`). The detach takes the period lock (shared), then the record row lock, then the file row lock.
- **Naming.** The UI already says "Withdrawn" for a voided record (`dataEntry.json`, `reports.json`). The new step is therefore called **recall**, never "withdraw".

## Goals / Non-Goals

**Goals:**
- Every rule the owner decided is enforced by the API (and, for the lifecycle step, by the database); the web mirrors it and never decides alone.
- No path lets a reviewer approve a figure that changed after they took it into review.
- The old implicit-overwrite bug cannot return.

**Non-Goals:**
- Changing the evidence model (re-linking an existing file, orphan files).
- Linked revisions (`supersedes_id`), a change-history view, and copy on records that are not voided.
- Moving records between subsidiaries.

## Decisions

### D1. Recall is its own endpoint and lifecycle step

`POST /api/v1/activity-records/:id/recall` moves `submitted` to `draft`.
- **Order:**
  1. `loadScoped`, which answers 404 across tenants.
  2. `mayAuthorRecords`.
  3. Under `withLockedRecord`, with `regate`: the status must be `submitted`, or the request is refused with `record_not_recallable` (`params.status`).
  4. `createdBy === user.id`, or `record_author_forbidden`. The status check comes first, the same order as `submit`.
  5. `assertPeriodNotLocked`.
  6. `transition(... draft)`.
- **`transition`** clears `submittedAt` when the target is `draft`. It keeps `reviewNote`, `reviewedBy` and the anomaly verdict, for the same reason `submit` keeps them. The next update or submit re-derives the verdict.
- **Audit:** `TRANSITION_ACTIONS[draft] = 'recall'`, and `recall` joins `AUDIT_ACTIONS`. `audit_log.action` is a plain string, so no migration is needed for it.
- **Why not the others:**
  - A `status` field on PATCH would mix two gates in one request.
  - Reusing reject would make the author act as a reviewer, which contradicts D01 and D02.
- **Races:** `startReview`, `approve` and `reject` take the same row lock and `regate`. Whichever request arrives first wins. The loser sees a status it cannot act on (`record_not_recallable` or `record_not_reviewable`) when its read was already current, or `RecordChangedError` (409) when the record changed after its read.
- **The submission a decision is about (review P1):** a reviewer can approve or reject straight from `submitted`. So an author's recall, edit and resubmit could land between the reviewer opening the record and deciding. Approve and reject therefore take `seenSubmittedAt`, the `submittedAt` the reviewer was shown. Under the row lock, any other value is refused as `record_changed` (409). The field is **required over HTTP** (owner review P1): a request without it, such as a review tab opened before this release, is refused with `record_changed` right after the role check. Every client words that code as "reload and try again". The controller passes an absent field to the service as `SUBMISSION_NOT_NAMED`; only in-process callers that pass nothing skip the comparison. The review screen always sends it.
- **Stale Cancel and Copy answers (owner review P2):** each action that gives the form a new subject (open, start over, Cancel, Copy) begins a form session (`createFormSessions`). A Cancel or Copy answer is applied only while its session is still current, so a late answer never refills the form over a record opened after it.

### D2. One migration adds `submitted>draft` to the allowed transitions

- **What:** a new migration (`2026111112xxxx_uat2_record_recall`) re-creates `activity_records_snapshot_immutable` from its latest body, in `20261105130000_lp4_02_record_parameters`, adding only `'submitted>draft'` to the array.
- **Inputs stay frozen on the recall write itself.** The input-freeze branch tests `OLD.status`, and that is `submitted` on this step. One write that moves to `draft` and also changes a value is still refused, as the spec requires.
- **The writer trigger** (`activity_records_lifecycle_writer`) is unchanged. Only the runtime role moves statuses.
- **The pin:** `packages/db/scripts/runtime-role.mjs` derives each trigger function's expected body from the last migration that defines it, so no hand pin is needed. The integrity check reads the new body.
- **Rollout:** expand-only. Before merging, run runbook 03's owner-psql migration preflight; automation does not run it.
- **Alternative rejected:** a separate `recall` status. It would need every reader of the status (matrix, queues, reports) to learn a new value, for no gain over `draft`.

### D3. The edit gate splits from the delete gate

- **Edit:** `assertCanMutate` becomes `assertCanEdit` (author only; the role check as before) for `update`.
- **Delete:** `assertCanDelete` (author or `super_admin`) for `remove`.
- **Refusal:** a non-author edit returns `record_author_forbidden` (403), the code `submit` already uses. The API message and the TR and EN catalogue copy change from submit-specific to "only the record's author can do this".
- **Why reuse the code:** the rule is the same (D02 extended), and the web already maps the code.

### D4. Category changes detach files inside the update transaction

The update DTO gains `detachEvidenceIds?: string[]` (UUIDs, at most `EVIDENCE_DETACH_MAX_IDS`, 200; a body over it is a 400 `validation_failed`, so a record with more files cannot change category in one edit). Inside `update`'s transaction:
1. **Locks:** after the period locks and the record row lock that `update` already takes, lock the named files' rows, in the evidence detach protocol's order.
2. **Read** the record's linked file ids.
3. **Refuse** a named id that is not linked: `evidence_not_found` (404), nothing changes.
4. **Refuse** a category change that leaves any linked file unnamed: `evidence_detach_required` (400, `params.linked`, the number of linked files). This is checked before any write.
5. **Write** the record update, then delete the named links. Rows left with no link go through the shared `deleteUnlinkedRows`. Each file writes the audit row a detach writes today (`detach`, or `delete` when the file went).
6. **After commit,** remove the deleted files' blobs through the same storage-intent path a detach uses.

To share one implementation, the core of `EvidenceService.detach` moves into a transaction-scoped helper. `detach` and `update` both call it. The helper does not re-check the record's status, because `update` has already done so under the same lock.

**Alternatives considered:**
- The web calls the existing detach endpoint for each file before the PATCH. Rejected: not atomic, so a failed PATCH would leave the files already deleted.
- The API detaches silently. The owner rejected this (D1 over D2).

### D5. Data Entry gets an explicit Edit mode

- **Entering Edit mode:** the form holds `editMode: { recordId, original: RecordIdentity, files } | null`. Edit sets it; Cancel, a successful save, or a subsidiary change clears it.
- **Edit mode off:** `hasMovedOffRecord` keeps its current meaning, and the drill-in template behaviour is unchanged.
- **Edit mode on:** the form never drops the record. A `describeEdit(original, form)` helper, beside `describeMove` in `record-identity.ts`, builds the band's from-to lines in TR or EN.
- **Category change:** clears the activity type, unit, parameters and inputs. The band lists every file, and saving is disabled until the user ticks the confirmation; the PATCH then sends every file id.
- **Other identity changes:** each file gets a keep or remove toggle, defaulting to keep, and the PATCH sends the removed ids.
- **Recall:** Previous submissions shows Recall on the user's own `submitted` rows, with a confirmation dialog, through `api.recallRecord`. After a recall the list refreshes and the row offers Edit.
- **Copy to new draft:**
  - **Where:** Previous submissions on a voided row, and the `/emissions` record drawer of a voided record. Both route to `/data-entry?copyFrom=<id>`.
  - **What it fills:** the form loads the record through `lib/api.ts`, fills every field, and leaves `editingId` and `editMode` null, so saving is a create.
  - **Subsidiary change:** the location clears, because locations belong to a subsidiary.
  - **Who sees it:** the voided record's author and `super_admin`, decided client-side. The create is gated by the normal create rules.

### D6. Contract and copy

`@tonyai/shared-types` gains:
- the `recall` audit action;
- `record_not_recallable` (400, `status`) and `evidence_detach_required` (400, `linked`) in the error registry with their params;
- `RECALLABLE_STATUSES = {submitted}`;
- `detachEvidenceIds` on the update request type.

The web adds TR and EN copy for the Edit, Recall and Copy actions, the band, the evidence warning, the recall dialog and the two new error codes, following the `localise-ui` skill. `dist` is rebuilt for the API and web.

## Risks / Trade-offs

- **BREAKING for QA.** A `super_admin` editing a colleague's draft is now refused. → Say so in the PR and in QA's note. Existing unit tests that assert the old behaviour flip.
- **A detached file is deleted beyond recovery when it was the last link.** → Explicit confirmation in the band, the API's `evidence_detach_required` rule, and the same audit `delete` row as today. Blob removal goes through storage intents, so a crash cannot leave a half-deleted file.
- **The implicit overwrite returns.** → Edit mode is entered only by the Edit action. The existing e2e ("moving the form off a loaded record stops targeting it") stays, and a new e2e covers the in-place category and period edit.
- **Recall racing review.** → Row lock plus `regate`. An integration test runs recall against `startReview` concurrently and asserts exactly one winner.
- **Lock ordering when update also detaches.** → Same order as detach: period shared, record row, then file rows. An integration test covers a category change racing a separate detach of the same file.
- **A recalled draft carries the old anomaly flag until its next write.** → Acceptable. The draft's view does not rely on it, and submit re-derives it.

## Migration Plan

1. One forward migration, expand-only (D2). QA deploy applies it on merge, after the owner's runbook 03 preflight.
2. No data migration. Records already submitted can be recalled from the moment the API ships.
3. **Rollback:** redeploying the previous image is safe. The extra transition is unused by old code. Removing the transition later is a separate contract migration.

## Open Questions

- **Evidence changes by a `super_admin` on a colleague's draft** (attach and detach through the evidence endpoints) stay open to them, as today. Whether D3's author-only rule should extend to evidence is filed under Open questions in the status file. It does not change this change's specs or tasks.
