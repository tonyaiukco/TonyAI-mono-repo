# Proposal

## Why

Many pilot customers have no second person in-house to approve the figures. Under D01, nobody approves their own record, so a customer whose only user is its `super_admin` has no approver. The team kept D01 (K2, option A, team memo 2026-11-11). On 2026-11-12 the owner ruled that a `consultant` may approve, so that the external consultant can be a one-person customer's approver (Decisions 2026-11-12). This reverses the 2026-07-30 rule that the consultant seat is review-only.

Today the API refuses a consultant's approval in `activity-records.service.ts`, with "Only a super_admin may approve records". The review screen hides Approve from a consultant and shows "Approval is reserved for a super_admin". This is change 3 of the six UAT2 changes (Next up).

The security review of this change found an older gap in D01. A `super_admin` may attach, detach or delete files on a colleague's editable record, then approve that record once its author submits it. D01 compares only the record's creator, so it does not see this. BUG-R2-03 closed the same gap for record edits, but evidence kept its `super_admin` exception. On 2026-11-12 the owner chose to close it in this change and this PR (option A): evidence becomes author-only.

## What Changes

- **A consultant may approve a record.** The API's approval role set becomes `super_admin` and `consultant`. Every other approval condition still applies to a consultant, unchanged:
  - the submission the reviewer saw (`seenSubmittedAt`);
  - the period lock;
  - K3 evidence;
  - the activity-type check;
  - the anomaly variance reason;
  - the freshness check.
- **D01 applies to the consultant too.** Nobody approves a record they created, whatever their role today. A consultant cannot author a record, so this matters only for a user who created records under another role and was later changed to Consultant. The existing `createdBy` comparison already covers that case; the change states it and tests it.
- **Void stays `super_admin` only.** Void used the same approval role set until now. It gets its own super_admin-only check, so widening approval does not widen void. Period unlock (and lock) also stays `super_admin` only.
- **Unchanged consultant rights:**
  - Start review and reject: consultant and super_admin, as today.
  - The consultant still cannot create, edit, submit, recall or delete a record, or upload or detach evidence.
  - The consultant keeps the whole-organisation view (owner, 2026-11-12). No per-subsidiary scoping.
  - Report capture, issuance and finals keep their current role sets.
- **One source for who may approve.** `@tonyai/shared-types` gains `mayApproveRecords(user)`, beside `mayAuthorRecords`. The API and the web both read it.
- **Review screen:**
  - A consultant sees Approve on a record that someone else created.
  - The consultant-only note "Approval is reserved for a super_admin…" is removed (EN and TR).
  - The "you created this record" hint shows for any approver role, not only `super_admin`.
- **Error wording:** a refused approval by a Data Entry or Executive Viewer user now reads "Only a consultant or super_admin may approve records".
- **Evidence changes become author-only (owner, 2026-11-12, option A).** Only a record's author, `super_admin` included, may change its evidence. That covers four actions:
  - uploading a file to one record;
  - uploading one file for several records;
  - taking a file off a record;
  - deleting a file.

  The `super_admin` exception is removed in the API and in the web's attach step. The rest stays as it is: the editable-status and period-lock rules, the author's own rights, and deleting a draft or rejected record, which its author or a `super_admin` may still do. The refrigerant shortcut and the several-records attach step then offer only the user's own records. Links that someone other than the author made earlier are not removed. A read-only query reports them on hosted QA before the merge.
- **Docs and seed copy** stop calling the consultant "review-only" or "cannot approve". This covers the permissions matrix, security and data-model architecture, the endpoints table, README, CLAUDE.md, local setup and the seed's console line.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `record-lifecycle`:
  - Adds a requirement stating who may approve, reject and void a record, with D01 for every approver role. No main spec states this today.
  - Changes the scenario "A role refusal still comes first", whose actor is a consultant. The actor becomes a role that still may not approve.
- `record-evidence`: adds a requirement that only a record's author changes its evidence, `super_admin` included, while deleting a draft stays open to `super_admin`.

## Impact

- **API:** `apps/api/src/activity-records/activity-records.service.ts` changes:
  - approval: role set and message;
  - void: its own role check;
  - comments: the D01 comment.

  No DTO, route, error code or migration changes. Nothing in the database checks application roles on a status change; RLS is SELECT-only.
- **Shared types:** `packages/shared-types/src/index.ts` gets the new `mayApproveRecords` helper and its spec. Comments that say only `super_admin` approves are updated. This is an additive change to the contract surface.
- **Web:**
  - `apps/web/lib/record-lifecycle-view.ts` (`canApproveRecord`) and its spec.
  - `apps/web/app/review/page.tsx`: the Approve gate, the self-approval hint and the removed note.
  - `apps/web/messages/{en,tr}/review.json`: `sheet.consultantNote` is removed.
  - Stale comments in `apps/web/lib/api.ts` and `apps/web/app/data-entry/page.tsx`.
  - `apps/web/lib/evidence-view.ts` (`attachBlockReason`) and its spec: no `super_admin` exception.
- **API, evidence:** `apps/api/src/evidence/evidence.service.ts` (`refusalFor`) and its spec. The 403 that refuses a non-author is unchanged; it now applies to `super_admin` too.
- **Tests:**
  - API service spec: three consultant-approve assertions flip; the void refusal stays; a consultant D01 case is added.
  - Web helper spec.
  - `e2e/review-queue.spec.ts`: a consultant approves through the UI, and the API test is rewritten.
  - An integration happy path for consultant approval.
  - Evidence: unit, integration and e2e cases where a `super_admin` changes a colleague's record's evidence, all flipped to refusals. Existing tests that relied on the exception are reworked.
- **Docs:**
  - `docs/md_docs/permissions_and_roles.md`
  - `docs/architecture/security.md`
  - `docs/architecture/data-model.md`
  - `docs/api/endpoints.md`
  - `docs/development/local-setup.md`
  - `README.md`
  - `CLAUDE.md`
  - `docs/uat/uat_round3.md` (CON-02)
  - a dated note in runbook 11's role-refusal probe
  - the evidence rows of `docs/api/endpoints.md` and `permissions_and_roles.md`, and the evidence rule in `security.md`
- **Seed:** `packages/db/prisma/seed.ts`, the console line only. Data is unchanged.
- **Hosted QA:**
  - Before the merge, the owner runs a read-only query (in design.md). It lists evidence changes made by someone other than the record's author, and whether that person also approved the record.
  - An image-only deploy; there is no migration. QA retests approval as the hosted consultant account.
  - A `super_admin` tester can no longer add files to a colleague's draft.
- **Status file:**
  - the drift-table row "Consultant as an approval authority";
  - the evidence decision, moved from Open questions to Decisions 2026-11-12;
  - a Current status entry after the change merges and deploys.
