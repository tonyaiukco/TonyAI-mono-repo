# Tasks

## 1. Shared approval rule

- [x] 1.1 In `packages/shared-types/src/index.ts`, add `mayApproveRecords(user: { role } | null | undefined): boolean` (the same shape as `mayAuthorRecords`), true for `consultant` and `super_admin`, beside `mayAuthorRecords`. Its doc comment cites Decisions 2026-11-12 (K2) and states three things:
  - D01 is a separate record-level check;
  - void and unlock stay `super_admin`;
  - a consultant still does not author.

  Update the stale comments: the consultant seat "advisory" text on `mayAuthorRecords` (approval now included, authoring still excluded), and "`super_admin` approves" near :1577.

  Verify in `packages/shared-types/src/index.spec.ts`, using a table over all four roles: `mayApproveRecords` is true for consultant and super_admin and false for the other two. The existing `mayAuthorRecords` consultant → false case must stay green.

## 2. API enforcement

- [x] 2.1 In `apps/api/src/activity-records/activity-records.service.ts`:
  - Replace `APPROVE_ROLES` in `approve` with `mayApproveRecords(user)`. The message becomes "Only a consultant or super_admin may approve records".
  - Rewrite the constant's comment block to explain the reversal.
  - Widen the D01 comment to "whatever the approver's role, consultant included".
  - Leave the order of checks unchanged (design decision 3).

  Verify with `pnpm --filter api typecheck`.
- [x] 2.2 Give `void` its own `VOID_ROLES = new Set(['super_admin'])`. Its message stays "Only a super_admin may void records", and its doc comment loses "Same reasoning as `APPROVE_ROLES`". Confirm that no use of `APPROVE_ROLES` remains (`grep -n APPROVE_ROLES apps/api/src` is empty).
- [x] 2.3 Update `activity-records.service.spec.ts`:
  - Flip `'consultant may NOT approve'` (~:1351) to a consultant approving another user's submitted record: approved, `reviewedBy` is the consultant, and the audit call carries role `consultant`. Drop its wrong "consultants enter data" comment.
  - Flip `'names the role before the missing submission'` (~:1662): data_entry → Forbidden, consultant → `ReviewVersionRequiredError`.
  - In `'a role refusal comes before the recompute'` (~:4684), replace the consultant approve line with an executive_viewer one.
  - Add a consultant D01 case: a consultant whose id equals `createdBy` → `SelfApprovalRefusedError`.
  - Add a consultant into a locked period → refused, and a consultant without required evidence → `ApprovalEvidenceMissingError`.
  - Keep the void consultant → Forbidden case (~:2268) unchanged.

  Verify with `pnpm --filter api test`.
- [x] 2.4 In `apps/api/test/int/lifecycle-decisions.int.spec.ts`, under D01, add two cases on the real database:
  - A consultant approves a data_entry user's submitted record with evidence. It is approved, and the `audit_log` row has action `approve` and role `consultant`.
  - A user creates and submits a record as data_entry, has their role changed to consultant, then approves it. `SelfApprovalRefusedError`, and the status stays `submitted`.

  Verify by running `pnpm --filter api test:int -- lifecycle-decisions` with CI's env (`TONYAI_TEST_PASSWORD`, `RATE_*=10000`).
- [x] 2.5 In `docs/api/endpoints.md`, change the approve row's roles to "`consultant` or `super_admin` (never their own record, D01)". Keep void as "`super_admin` only". Verify by reading back that review, reject and void are unchanged.

## 3. Web review screen

- [x] 3.1 In `apps/web/lib/record-lifecycle-view.ts`, make `canApproveRecord` use `mayApproveRecords(user) && record.createdBy !== user.id`. Add `isOwnRecordForApprover(user, record)` for the hint. Verify in `record-lifecycle-view.spec.ts`:
  - the role table flips the consultant row to true;
  - data_entry and executive_viewer stay false;
  - a consultant or super_admin author → false;
  - the hint helper is true only for an approver role on their own record.

  Update the test title.
- [x] 3.2 In `apps/web/app/review/page.tsx`:
  - Base the self-approval hint on `isOwnRecordForApprover`.
  - Remove the `consultantNote` paragraph.
  - Update the `APPROVE_ROLES` comment (~:137).
  - Leave `canReview` (start review and reject) unchanged.

  Delete `sheet.consultantNote` from `apps/web/messages/en/review.json` and `apps/web/messages/tr/review.json`, following the `localise-ui` skill. Update the stale comments in `apps/web/lib/api.ts` (~:599) and `apps/web/app/data-entry/page.tsx` (~:2050): the consultant does not author but may approve.

  Verify with `pnpm --filter web typecheck`, `pnpm --filter web test` (including the EN/TR key-parity spec) and `pnpm --filter web build`.

## 4. End-to-end

- [x] 4.1 In `e2e/review-queue.spec.ts`:
  - Rewrite `'a consultant may send a record back but is not offered Approve'`. It becomes a consultant who sees Approve on a record created by `entry@` (with evidence), approves it through the UI and sees the queue clear. Send-back stays covered by the reject test.
  - Assert that the removed note text is absent.
  - Rewrite `'the API — not the UI — is what stops a consultant approving'` as an API test that checks four things:
    - a consultant approval with `seenSubmittedAt` → 200;
    - without it → 409 `record_changed`;
    - a data_entry approval → 403;
    - consultant create → 403 (keep), and consultant reject → 200 (keep).
  - Update the file header (~:18-26).

  Use the `e2e-flow` skill's helpers and teardown. Verify with `pnpm e2e -- review-queue void-record rbac-tenant`, all green. `void-record` proves that the consultant is still refused void in the UI and the API. Retitle `rbac-tenant`'s "approval is super_admin only" to name data_entry's refusal; its assertions are unchanged.

## 5. Docs and seed copy

- [x] 5.1 Update the role descriptions:
  - `docs/md_docs/permissions_and_roles.md`: the consultant row; the matrix row "Approve records" becomes ✅ for consultant; split "Approve and Lock render only for `super_admin`"; §5.2.
  - `docs/architecture/security.md` (:11, :33): "only consultant or super_admin approves; nobody approves their own record; void and unlock are super_admin".
  - `docs/architecture/data-model.md` (:42).
  - `docs/development/local-setup.md` (:59).
  - `README.md` (:157) and `CLAUDE.md` (the seed-user line): the consultant reviews, rejects and approves, and cannot enter data.
  - The console line in `packages/db/prisma/seed.ts` (~:1106).

  Verify that `grep -rn "review-only\|review and reject only\|cannot approve\|super_admin alone\|only \`super_admin\` approves" README.md CLAUDE.md docs/architecture docs/api docs/development docs/md_docs packages/db/prisma/seed.ts` has no stale hit about approval.
- [x] 5.2 In `docs/uat/uat_round3.md`, change CON-02 to expect Approve to be visible on another user's record, with no "reserved for a super_admin" note. In `infra/runbooks/11-qa-hosted.md`, add a dated note at the role-refusal probe (~:994): from `uat2-consultant-approval` on, the consultant's approval is allowed, so a rerun counts nine refusals. The historical evidence stays as written. In the `openspec/specs/activity-data-entry/spec.md` scenario titled "A review-only user", leave the behaviour as it is; note the stale title under Open questions (not fixed pre-pilot). Verify by reading back each edited passage.

## 6. Verification and review

- [x] 6.1 Run the full gates: `pnpm typecheck`, `pnpm test` and `pnpm build`, all green. Run `openspec validate uat2-consultant-approval --strict`.
- [x] 6.2 Live check against the local stack (`pnpm dev`) — done through Playwright on the live local stack (review-queue, void-record, rbac-tenant: 14 passed) plus the integration test for the audit role, which cover each point below:
  - as `review@tonyai.local`, approve a record submitted by `entry@tonyai.local`, and confirm that the Emissions drawer shows the consultant as "Reviewed by" with no void action;
  - `GET /api/v1/audit` as admin shows the approve row with role `consultant`;
  - as `admin@tonyai.local`, Approve is still absent on admin's own record.
- [x] 6.3 Fresh-eyes review before the PR (the change touches RBAC and the record lifecycle, and adds to the shared-types surface). Run `security-rls` and `qa-auditor` in parallel, plus an `architect` seat for `mayApproveRecords`. Probe these areas:
  - void, unlock or authoring widened by accident;
  - D01 bypass via a role change;
  - order-of-checks regressions;
  - the EN/TR catalogues;
  - stale docs.

  Fix the P1 and P2 findings. File non-defect findings under Open questions.
- [x] 6.4 Status file `docs/roadmap_docs/project_status_roadmap_phases.md`:
  - Update the drift-table row "Consultant as an approval authority" to say the consultant approves (D01 applies; void and unlock stay super_admin).
  - Add the Open questions entries from 5.2 and 6.3.

  Verify by reading the edited rows back.

## 7. Evidence author-only (owner, 2026-11-12, option A)

- [x] 7.1 Write the read-only hosted query: links by a non-author (part 1), and audit uploads, detaches and deletes by a non-author (part 2), each with whether that person also approved the record. Put it in design.md (Migration Plan). Verify locally inside `BEGIN READ ONLY … ROLLBACK`: 0 rows, and a synthetic non-author `detach` in a rolled-back transaction is reported.
- [x] 7.2 In `apps/api/src/evidence/evidence.service.ts` `refusalFor`, refuse when `record.createdBy !== user.id` whatever the role. Update its doc comment: author-only, as BUG-R2-03's edit rule, and Decisions 2026-11-12. Keep the 403 message. Leave record deletion (author-or-`super_admin`, in the record service) unchanged. In `evidence.service.spec.ts`, flip every case where a `super_admin` changes a colleague's record's evidence: upload, several-records upload naming the colleague's record (all or nothing), detach and delete. Each must be Forbidden, with nothing written and no audit. Keep the author cases green. Verify with `pnpm --filter api test`.
- [x] 7.3 In `apps/web/lib/evidence-view.ts` `attachBlockReason`, drop the `super_admin` exception (`block.notAuthor` for any non-author). Check the other web places that offer evidence controls on a record the user did not create: the Data Entry evidence card, the refrigerant shortcut and the records table attach step. Confirm that none offers them to a `super_admin` non-author. In `evidence-view.spec.ts`, flip the `super_admin` non-author cases. Verify with `pnpm --filter web test` and typecheck.
- [x] 7.4 Integration: grep `apps/api/test/int` for a `super_admin` attaching, detaching or deleting evidence on a record it did not create, and rework those setups to use the author or the owner client. Add one case on the real database: a `super_admin` uploading to a data_entry draft is refused, and no `evidence` or `activity_record_evidence` row is written. Verify with `pnpm --filter api test:int`, with CI's env, for the touched files.
- [x] 7.5 E2E: grep `e2e/` for `ADMIN_EMAIL` uploading or detaching evidence on records created by `ENTRY_EMAIL`, or the reverse, and fix them. The `createCommittedRecord` helper already uploads with the creator's own token. Verify by running the touched specs and the evidence specs (`drafts-bulk-submit-evidence`, `evidence-retention`, `record-edit`, `uat2-team-decisions`) green.
- [x] 7.6 Docs:
  - `docs/api/endpoints.md`, the evidence rows (61–65): author only, `super_admin` included.
  - `docs/md_docs/permissions_and_roles.md`: "any author's for `super_admin`" becomes own records only.
  - `docs/architecture/security.md`, the RBAC rule: evidence is author-only, like edit and recall.

  Verify that `grep -rn "author-or-\`super_admin\`\|any author's for" docs` returns no hit about evidence.

## 8. Re-verification and re-review

- [x] 8.1 Run the full gates again: `pnpm typecheck`, `pnpm test`, `pnpm build`, and `openspec validate uat2-consultant-approval --strict`.
- [x] 8.2 Re-review the grown PR, because a second material design was added (CLAUDE.md). Run `security-rls` and `qa-auditor` in parallel on the evidence part and on its interplay with approval. Probe:
  - any remaining evidence path that waives authorship;
  - record deletion still author-or-`super_admin`;
  - the shortcut and the attach step;
  - the query's correctness.

  Fix the P1 and P2 findings. File the rest under Open questions.
- [x] 8.3 Status file: move the "D01 does not see evidence changes on a colleague's draft" entry from Open questions to Decisions 2026-11-12, as the owner's option A choice (in chat, 2026-11-12), with its scope (four evidence actions; draft deletion unchanged). Verify by reading it back.

## Workflow follow-up

- Before the merge, the owner runs the design.md query on hosted QA and the PR records its counts. Any row with `..._also_approved = true` goes to the owner for a decision.
- Commit and open the PR only when the owner asks; the owner merges.
- After merge, the QA auto-deploy runs (image-only, no migration). QA retests K2 with the hosted consultant: approves another user's record, gets no Approve on their own record, and is offered no void action.
- Add the Current status entry, mark change 3 done in Next up, and archive the change (sync `record-lifecycle` and `record-evidence`) in a follow-up PR.
