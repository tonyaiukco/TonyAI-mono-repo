# Design

## Context

The motivation is in proposal.md, under "Why". This section records the state of the code at `origin/main` a8a8f96f.

- **One enforcement point.** Approval roles are checked only in `ActivityRecordsService`:
  - `REVIEW_ROLES = {consultant, super_admin}` (`activity-records.service.ts:256`) gates start review (:1636) and reject (:1789).
  - `APPROVE_ROLES = {super_admin}` (:262) gates `approve` (:1661) **and `void` (:1751)**. Void's doc comment says "Same reasoning as `APPROVE_ROLES`".
  - The activity-records routes have no `@Roles` decorator or role guard.
- **Nothing in the database checks application roles.** `activity_records_snapshot_immutable` (latest definition in `20261111120000_uat2_record_recall`) lists the allowed status transitions only. `activity_records_lifecycle_writer` admits only the runtime and owner Postgres roles. RLS on records is SELECT-only.
- **The order of checks in `approve`:**
  1. role
  2. `assertSubmissionNamed` (`seenSubmittedAt`)
  3. recompute
  4. status and same submission
  5. D01: `record.createdBy === user.id` → `SelfApprovalRefusedError`
  6. period lock
  7. K3 evidence
  8. activity type
  9. freshness
  10. `transition` stamps `reviewedBy` and `reviewedAt`, and writes an audit row. `AuditService.record` stores `role: user.role` at write time.
- **D01 is role-agnostic already.** It compares `createdBy` only. That is enough because only the author submits (D02, `SubmitAuthorRefusedError`), and only the author edits or recalls (`assertCanEdit`, `recall`). `created_by` cannot change; the lifecycle trigger blocks it (TA006).
- **A consultant cannot author.** `mayAuthorRecords` (`packages/shared-types/src/index.ts:535`) is data_entry or super_admin. It gates create, edit, submit, recall, delete and evidence. So a consultant is never `createdBy`, unless their role changed after they authored as data_entry or super_admin. `PATCH /users/:id/role` keeps the user id.
- **Web:**
  - `canApproveRecord` (`apps/web/lib/record-lifecycle-view.ts:12`) is `role === 'super_admin' && createdBy !== user.id`.
  - `app/review/page.tsx` gates Approve on that helper.
  - It shows the self-approval hint only for a `super_admin` author (:905).
  - It shows `sheet.consultantNote` to every consultant (:910).
  - Void is offered on Emissions through `canOfferVoid(record, isSuperAdmin)`.
- **Reports** carry only an opaque `reviewedBy` and `reviewedAt`, never a name or role. Nothing downstream assumes that the approver is a `super_admin`.
- **Evidence kept a `super_admin` exception that record edits lost.**
  - Every evidence change goes through `EvidenceService.refusalFor`: upload to one record, upload for several records, detach, and delete of a file.
  - `refusalFor` refuses a non-author with `user.role !== 'super_admin' && record.createdBy !== user.id`. Its comment says it obeys "the same three rules a record's own edit obeys". That stopped being true when BUG-R2-03 made record edit and recall author-only, `super_admin` included; evidence was not changed with them.
  - The web mirror, `attachBlockReason` (`apps/web/lib/evidence-view.ts`), has the same exception.
  - Each link stores `linked_by`. A detach or delete leaves only an audit row (`entity = 'evidence'`, action `detach` or `delete`, with `diff.before.recordId` or `recordIds`).

## Goals / Non-Goals

**Goals:**
- Widen approval to `consultant` at the single enforcement point, and keep every other approval condition and D01 exactly as they are.
- Make it impossible to widen void, unlock or authoring by accident.
- Have the API and the web read one definition of who may approve.
- Close the D01 blind spot on evidence (owner, 2026-11-12, option A): nobody changes the evidence of a record they did not create.

**Non-Goals:**
- Per-subsidiary scoping for consultants. Owner, 2026-11-12: whole-organisation view in the pilot.
- Showing the approver's name or role in reports or issued PDFs. Reports keep the opaque reviewer id.
- A distinct "approved by" field. `reviewedBy` and `reviewedAt` keep meaning "who decided".
- Any change to report capture, issuance or finals roles, period locks, access admin or the factor library.

## Decisions

1. **Put `mayApproveRecords(user)` in `@tonyai/shared-types`, beside `mayAuthorRecords`.**
   - The API's approval check and the web's `canApproveRecord` both call it. One source of truth, as the architecture rules require.
   - *Alternative:* keep a service-local `APPROVE_ROLES` and a separate web literal. Rejected: that is how the two drifted into duplicate role lists.
   - The helper takes the user (its role only, the same shape as `mayAuthorRecords`), not a record. D01 stays a separate record-level check in both places, because it needs `createdBy`.
2. **Void gets its own check, `VOID_ROLES = {super_admin}`, local to the service.**
   - It replaces the shared use of `APPROVE_ROLES`, and its message stays "Only a super_admin may void records".
   - The existing service test, where a consultant void is Forbidden, and `e2e/void-record.spec.ts` (consultant refused at the API, no void action in the UI) stay unchanged. They are the regression guard for this split.
   - *Alternative:* `user.role !== 'super_admin'` inline. Equivalent, but a named set makes the asymmetry with approval visible at the top of the file.
3. **The order of checks is unchanged.**
   - A consultant who approves without `seenSubmittedAt` now passes the role check, so they get `record_changed` (409), not 403. The spec's "A role refusal still comes first" scenario keeps its intent with a data_entry actor, and a new scenario states the consultant's 409.
   - *Alternative:* move D01 before the submission check. Rejected: no requirement asks for it, and it would reorder refusals that existing clients and tests already rely on.
4. **The forbidden message becomes "Only a consultant or super_admin may approve records".**
   - It is a plain `ForbiddenException` with no stable error code, as it is today. No new code is added to the error registry, because the web never shows Approve to a role that would hit it.
5. **The review screen follows the helper.**
   - Approve shows when `canApproveRecord` is true.
   - The self-approval hint shows when `mayApproveRecords(user)` holds and `createdBy === user.id`, so a role-changed consultant sees why Approve is missing.
   - `sheet.consultantNote` is deleted from both catalogues; the EN/TR key-parity test requires both. *Alternative:* reword it to "you can approve; void and unlock stay with the super_admin". Rejected: void and unlock live on other screens, where the consultant is already offered nothing. A note about absent actions on a different screen is noise.
6. **No migration and no data change.**
   - Existing approvals are untouched. The seed's consultant `review@tonyai.local` gains approval through the code; only its console description changes.
7. **Historical records stay as written.**
   - The L10 acceptance checklist and earlier Decisions entries record what was true when they ran.
   - Runbook 11's role-refusal probe (ten expected refusals, including the consultant's approval) gets a dated note that the consultant's approval is allowed from this change on. The probe's evidence is historical.
   - `docs/uat/uat_round3.md` is a living catalogue, so its CON-02 expectation is updated.
8. **Evidence becomes author-only: the `super_admin` exception is removed in `refusalFor` and `attachBlockReason`.**
   - One condition in each place: `record.createdBy !== user.id` refuses, whatever the role.
   - The refusal keeps its existing 403 and message ("You may only modify evidence on records you created"). The several-records upload keeps its all-or-nothing answer, naming every refused record.
   - Deleting a draft or rejected record stays author-or-`super_admin`. It is a record write, not an evidence change, and a deleted record is never approved.
   - *Alternative B, rejected:* keep the exception and refuse approval to anyone who touched the record's evidence. A detach leaves no link, so the approve gate would have to read the audit trail, which is fragile and not built to serve as a gate.
   - *Alternative C, rejected:* show who added each file and accept the gap. In a compliance product that leaves a segregation-of-duties gap, only made visible.
   - Earlier links made by a non-author are not removed. The query in the Migration Plan reports them, and the owner decides any correction (D04 for an approved record).

## Risks / Trade-offs

- [An external advisor can now accept figures into the client's inventory] → This is the owner's explicit decision (Decisions 2026-11-12, K2). Four things contain it:
  - D01 still applies.
  - Evidence (K3), the period lock and the anomaly variance reason still gate approval.
  - Each approval's audit row records the role `consultant`.
  - Only `super_admin` can unlock a period or void an approved figure.
- [Issued reports do not say whether a consultant or a super_admin approved] → Accepted for the pilot; this is unchanged behaviour. The audit log answers the question. A report-level approver line would be a non-defect follow-up and goes under Open questions.
- [A naive edit adds `consultant` to the shared set that void also used] → Decision 2 removes the shared use. The kept void tests fail if void widens.
- [A user who authored records and is later made a consultant could approve their own old record] → D01 compares `createdBy` regardless of role. A new service test and an integration test cover this.
- [Every consultant account on hosted QA gains approval when the image deploys] → This is intended. Tell QA in the deploy note so they retest K2 with the hosted consultant and a record created by someone else.
- [A `super_admin` can no longer fix a colleague's missing invoice] → The remedy already exists, and it is the one K3 gives for approval: reject with a comment; the author attaches the file and resubmits. The refrigerant shortcut and the several-records attach step offer only the user's own records.
- [Hosted QA or seed data already holds links made by a non-author] → The read-only query below lists them, with whether the same person approved the record. A row where `linker_also_approved` or `actor_also_approved` is true goes to the owner, who leaves it or corrects it through D04. So does a row where `still_open` is true: the new gate does not cover links made before the deploy, so another approver must decide that record, or it goes back to its author. The change itself rewrites no data.
- [Rollback leaves consultant approvals in place] → Redeploying the previous image restores super_admin-only approval. Approvals already made by a consultant stay approved; they were valid under D01 when made, and the audit shows who made them. If such a figure needs reversing, the correction is D04 (void and re-enter).

## Migration Plan

- **Before the merge, the owner runs this read-only query on hosted QA.** Use the owner `psql`, as for runbook 03's preflights, wrapped in `BEGIN READ ONLY; ... ROLLBACK;`.
  - Part 1 lists files linked today by someone other than the record's creator.
  - Part 2 lists the uploads, detaches and file deletes in the audit trail by someone other than the record's creator. A detach leaves no link behind, so only part 2 sees it. Files removed by deleting a whole record are audited on the record's own row, and that record no longer exists, so they cannot matter.

  The PR records the row counts. Two kinds of row go to the owner:
  - a row where either `..._also_approved` column is true: that person approved the record (`voided` included);
  - a row where `still_open` is true: the record is not decided yet, so that person must not approve it. Another approver decides it, or it is rejected back to its author. Locally, on 2026-11-12, the query returned 0 rows, and it reported a synthetic non-author `detach` inside a rolled-back transaction.

  ```sql
  -- Read-only. Who has changed evidence on a record they did not create?
  -- `*_also_approved`: that person approved the record (voided included).
  -- `still_open`: the record is not decided yet, so that person must not approve it.
  -- (1) Files linked today by someone other than the record's creator.
  SELECT r.id            AS record_id,
         r.status,
         r.created_by,
         l.linked_by,
         p.role          AS linker_role_now,
         l.linked_at,
         COALESCE(r.reviewed_by = l.linked_by AND r.status IN ('approved', 'locked', 'voided'), false) AS linker_also_approved,
         r.status IN ('draft', 'rejected', 'submitted', 'under_review') AS still_open
  FROM activity_record_evidence l
  JOIN activity_records r ON r.id = l.activity_record_id
  LEFT JOIN profiles p    ON p.id = l.linked_by
  WHERE l.linked_by <> r.created_by
  ORDER BY l.linked_at DESC;

  -- (2) Evidence uploads, detaches and file deletes in the audit trail by someone
  -- other than the record's creator (catches removals, which leave no link).
  -- Files removed by deleting a whole record are audited on that record's own
  -- row, and their record is gone, so they cannot matter here.
  WITH touched AS (
    SELECT a.created_at, a.action, a.user_id, a.role AS actor_role_then, x.rid::uuid AS record_id
    FROM audit_log a
    CROSS JOIN LATERAL (
      SELECT a.diff -> 'before' ->> 'recordId' AS rid WHERE a.action = 'detach'
      UNION ALL
      SELECT jsonb_array_elements_text(a.diff -> 'after' -> 'recordIds') WHERE a.action = 'create'
      UNION ALL
      SELECT jsonb_array_elements_text(a.diff -> 'before' -> 'recordIds') WHERE a.action = 'delete'
    ) x
    WHERE a.entity = 'evidence'
      AND a.action IN ('create', 'detach', 'delete')
      AND x.rid IS NOT NULL
  )
  SELECT t.created_at, t.action, t.user_id, t.actor_role_then,
         t.record_id, r.status, r.created_by,
         COALESCE(r.reviewed_by = t.user_id AND r.status IN ('approved', 'locked', 'voided'), false) AS actor_also_approved,
         r.status IN ('draft', 'rejected', 'submitted', 'under_review') AS still_open
  FROM touched t
  JOIN activity_records r ON r.id = t.record_id
  WHERE t.user_id IS DISTINCT FROM r.created_by
  ORDER BY t.created_at DESC;
  ```

- This is an image-only change. A merge to green `main` auto-deploys QA under the 2026-11-03 policy. There is no Prisma migration, so no runbook 03 preflight is needed.
- After the deploy, QA logs in as the hosted consultant and does three things:
  - approves a submitted record that someone else created;
  - confirms that Approve is absent on a record they created, if any;
  - confirms that no void action is offered.
- Rollback: redeploy the previous revision (same-image rollback, runbook 11).
