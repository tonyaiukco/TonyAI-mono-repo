# Tasks

## 1. Held files: the save sequence

- [x] 1.1 Add a pure helper `apps/web/lib/held-evidence.ts`:
  - `validateHeldFile(file)` returns ok, or `unsupported_type` or `too_large`, from `EVIDENCE_ALLOWED_MIME_TYPES` and `EVIDENCE_MAX_SIZE_BYTES`.
  - `uploadHeldFiles(recordId, files, upload, isCurrent)` uploads one file at a time and returns `{ uploaded, failed }`. It uploads nothing once `isCurrent()` is false (design D2).

  Add `apps/web/lib/held-evidence.spec.ts` covering:
  - each verdict of `validateHeldFile`;
  - the upload order;
  - a failure in the middle that keeps the rest going;
  - a stale session uploading nothing, before the first file and between files.

  Verify with `pnpm --filter @tonyai/web test`.
- [x] 1.2 In `apps/web/app/data-entry/page.tsx`, add `heldFiles` and `failedFiles` state, and clear both wherever a form session begins (reset, Cancel, Copy, opening a record, subsidiary switch). Wire design D2 into `handleSaveDraft` and `handleSubmit`:
  1. persist;
  2. session check;
  3. `uploadHeldFiles`;
  4. `api.getActivityRecord` re-read;
  5. stop on any failed file;
  6. today's evidence and anomaly gates;
  7. submit.

  Verify with `pnpm --filter @tonyai/web typecheck`.
- [x] 1.3 In `apps/web/components/data-entry/evidence-vault.tsx`, accept `recordId: string | null`, `heldFiles` with `onHeldChange`, and `failedFiles` with `onRetry` and `onRemoveFailed`.
  - With no record: validate, list, remove, and the required badge and category note as today. Uploads, downloads and list reads are disabled, and nothing is shown to a user who may not author records.
  - With a record: unchanged, plus a "did not upload" list with Retry and Remove.

  Verify with `pnpm --filter @tonyai/web typecheck`.
- [x] 1.4 Add the copy to `apps/web/messages/en/dataEntry.json` and `tr/dataEntry.json` (localise-ui skill):
  - the waiting-for-save label;
  - the refused-file toasts naming the file and the reason;
  - the "did not upload" list and its Retry and Remove labels;
  - the toast when a submit stops on a failed upload.

  Verify with the catalogue parity test, `pnpm --filter @tonyai/web test`.

## 2. Section order and the side column

- [x] 2.1 Reorder the form column in `page.tsx`:
  1. Reporting scope;
  2. Activity data;
  3. Evidence document, always rendered (record mode under `editingId`, held mode otherwise);
  4. Additional context;
  5. the anomaly note, the Edit-mode band and the action bar;
  6. Bulk upload.

  Make the side column sticky on `lg` (design D6). Verify with `pnpm --filter @tonyai/web typecheck`, and by eye in the running app at desktop width and at 390 px width.
- [x] 2.2 Wrap Additional context and Bulk upload, with `RecentImports` inside it, in `components/ui/collapsible.tsx` (design D5). Both start collapsed; Additional context starts open when a loaded record holds a context value. Add the two toggle labels to both catalogues. Verify with `pnpm --filter @tonyai/web test` and keyboard by eye (Tab to the trigger, then Enter and Space).

## 3. The records table

- [x] 3.1 Rebuild the rows of `components/data-entry/previous-submissions.tsx` on `components/ui/table.tsx`, renamed to `records-table.tsx` / `RecordsTable` (design D3).
  - Columns: period, category and activity, entity, value and unit, tCO₂e, evidence, status, actions.
  - The open button keeps its accessible name, and the checkbox stays a sibling of it.
  - Selection, attach, bulk submit and Load more are unchanged.
  - The table sits in an `overflow-x-auto` wrapper and shows no total.

  Verify with `pnpm --filter @tonyai/web typecheck`.
- [x] 3.2 Put the evidence cell's rule (count, or "missing" when required and 0) in a pure function beside the shared `needsEvidenceBeforeSubmit`, not a copy. Cover it in a Vitest case: Electricity with 0 files is missing, Electricity with 1 file shows 1, Business Travel with 0 shows 0. Verify with `pnpm --filter @tonyai/web test`.
- [x] 3.3 Add the filters (design D4): year with All years, status, category, and the `yearPinned` behaviour. Send them through `refreshRecords`, `loadMoreRecords` and `activityRecordMetadata`. Reset them on a subsidiary switch, and show a "no record matches" empty state distinct from "no records yet". Put the filter-state transitions (follow the form year, pin, reset) in a pure helper with a Vitest spec. Verify with `pnpm --filter @tonyai/web test`.
- [x] 3.4 Move the table to a full-width row under the form grid. Add the title, column, filter and empty-state copy to both catalogues. Verify with `pnpm --filter @tonyai/web test` (catalogue parity).

## 4. End-to-end coverage

- [x] 4.1 Add `e2e/data-entry-layout.spec.ts` (e2e-flow skill):
  - The section order, read from the headings.
  - Additional context and Bulk upload start collapsed.
  - A new Mobile Combustion record with a file chosen before the save submits in one click, and the record shows one file and Submitted in the table.
  - A file chosen, then a subsidiary switch with no save: no file reaches any record.

  Verify with `pnpm e2e e2e/data-entry-layout.spec.ts`.
- [x] 4.2 Add a failed-upload case: route the evidence upload to a 500 with Playwright, then submit. The record is a draft, the file is listed with Retry, and no submit is sent. Then unroute and Retry, then Submit, and the record is submitted. Verify with the same command.
- [x] 4.3 Add a table-filter case: the year filter follows the form year until pinned, a status filter holds across Load more, and the empty state reads "no record matches". Verify with the same command.
- [x] 4.4 Update the specs that reach the moved parts: expand Bulk upload first where a spec imports, and adjust row locators only where the table changed them. The specs are `data-entry-happy`, `data-entry-turkish`, `record-edit`, `drafts-bulk-submit`, `drafts-bulk-submit-evidence`, `bounded-reads` and `analytics`. Verify each with `pnpm e2e <spec>`.

## 5. Docs and verification

- [x] 5.1 Update `docs/md_docs/data_entry_page.md` §2 (page architecture) and §6 (evidence vault) to the new order, the held files and the records table. Verify that no doc still describes Bulk upload above Activity data, or a vault that appears only after a save.
- [x] 5.2 Run the full gate from the repo root: `pnpm typecheck`, `pnpm build`, `pnpm test` and `pnpm lint`. Verify that all four are green.
- [x] 5.3 Run the full local e2e suite on built servers. Verify it is green, apart from failures known on main (`data-entry-happy` with TR releases loaded, `security-headers` under `next dev`), each shown to fail on main too.
- [x] 5.4 Check the screen in the running app, in English and Turkish, at desktop and phone width (done by DOM measurement at 1440, 1024, 820 and 390 px, EN and TR, because screenshots cannot be read in this session; phone width overflows from the app shell's fixed sidebar, as on main — design Risks):
  - the order;
  - the collapsed sections;
  - a one-click evidence submit;
  - a failed upload with Retry;
  - the table, its filters and its actions.

  Record screenshots or Playwright evidence in the PR.

## 6. Review and status

- [x] 6.1 Run the fresh-eyes review. Spawn `qa-auditor` and `security-rls` in parallel on the branch diff, each in its own `git archive` copy, with self-contained prompts. Probe:
  - a held file reaching the wrong record or subsidiary;
  - a submit sent without a file the server would refuse;
  - stale-session uploads;
  - a review-only user offered upload;
  - lost selection, attach or bulk-submit behaviour;
  - filters dropped on Load more.

  Fix or file each finding, and verify that each seat reports what it verified.
- [x] 6.2 Update `docs/roadmap_docs/project_status_roadmap_phases.md`:
  - **Current status:** a new entry; move the oldest to Archive if there are more than ten.
  - **Next up:** BUG-R2-05 is done, and K1, K2, K4 and K5 with the owner come next.
  - **Open questions:** any finding not fixed.

  Verify with a diff read: Part A has no stale mention of BUG-R2-05 as pending.

## Workflow follow-up

- Commit, push and open the PR only on the owner's word, on branch `feat/uat2-data-entry-layout`. The QA report and the untracked `.claude/commands/` and `.claude/skills/openspec-*` stay out of the commit.
- After the merge and the QA deploy, tell QA that BUG-R2-05 can be retested, with the notes from design.md's Migration Plan.
- Archive the change with `/opsx:archive` once merged and deployed. Record the archive and the deploy in the status file.
