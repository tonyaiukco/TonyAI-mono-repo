# Design

## Context

See proposal.md for the motivation. The screen today (`apps/web/app/data-entry/page.tsx`, from the `return` at about line 1413) is a three-column grid: the form takes two columns and a side column holds the preview, `CoveragePanel`, `BoundaryCoverage` and `PreviousSubmissions`.

Constraints that shape the approach:

- **The vault needs a record id.** `EvidenceVault` calls `api.uploadEvidence(recordId, file)`, so today it renders only under `editingId`. `handleSubmit` saves (`persist()`), then mirrors the server's evidence gate with `needsEvidenceBeforeSubmit(rec)` using the saved record's `evidenceCount`, then calls `api.submitActivityRecord`.
- **Form sessions.** Since BUG-R2-03, every new record, Cancel, Copy and subsidiary switch begins a form session, and a late async answer from an older session is dropped. Held files must follow the same rule.
- **The record list reads.** `refreshRecords` and `loadMoreRecords` call `api.listActivityRecordPage({ subsidiaryId, cursor })` and `api.activityRecordMetadata(filters)`. `ActivityRecordPageQueryDto` already accepts `year`, `status[]` and `category`, so the filters need no API change.
- **E2E locators.** Shipped specs find a Previous submissions row by the accessible name of its open button, and its checkbox by `submissions.checkboxSelect` / `checkboxAttach` labels. Keeping those names keeps most locators valid.
- **No API, schema or contract change.** This is not on the calc path, RLS or tenant isolation. It does touch the order in which the client calls the record and evidence endpoints, so the review pass includes `qa-auditor` and `security-rls` (task 6.1).

## Goals / Non-Goals

**Goals:**
- An evidence-required record goes from empty form to submitted in one Submit, with no step the server does not already check.
- The page reads in QA's order, and the entered records read as one table.

**Non-Goals:**
- A new page or route for records or bulk upload.
- Persisting held files across reloads. A reload drops them, like any unsaved form field.
- Remembering the collapse state or the filters across visits.
- Any change to the review screen, the Emissions page or the dashboard.

## Decisions

### D1. Held files live in the page, not in the vault

The page owns `heldFiles: File[]` together with its form session id, and passes them to `EvidenceVault`. The vault gets a mode for a record that does not exist: `recordId === null`. In that mode it validates type (`EVIDENCE_ALLOWED_MIME_TYPES`) and size (`EVIDENCE_MAX_SIZE_BYTES`), lists the files, and offers Remove. With a `recordId` it behaves exactly as today.

The page owns the files because the save sequence (D2) runs in the page and must read them at the moment of the save. A vault-internal state would need a ref or a callback to reach them.

`resetForm`, Cancel, Copy, opening a record and switching subsidiary already begin a form session. Each of them also clears `heldFiles`.

*Alternative considered:* upload to Storage before the record exists and link the files later. Rejected: it needs an orphan-file lifecycle and a new API, against "no API change", and evidence would exist with no record behind it.

### D2. The save sequence: persist, upload, re-read, gate, submit

Both Save draft and Submit run the same steps when the save creates a record and files are held:

1. `persist()` creates the record. On failure nothing is uploaded and `heldFiles` stays.
2. If the form session has changed since the save started, stop. The files belong to the old session and are not uploaded anywhere (spec: "A late save answer").
3. Upload each held file with `api.uploadEvidence(rec.id, file)`, one at a time, in the order chosen. Keep the files that fail.
4. Re-read the record (`api.getActivityRecord(rec.id)`), so the client gate uses the server's `evidenceCount`, not a local sum.
5. Save draft stops here. Submit stops here too if any file failed, with a toast naming those files. Otherwise it continues to today's evidence gate, the anomaly gate and `api.submitActivityRecord`.

`setEditingId(rec.id)` happens right after step 1, as it does today. From then on the vault is in record mode. Files that failed in step 3 are passed to it as `failedFiles`, shown with Retry, which uploads to `rec.id`, and Remove.

An edit of an existing record never holds files, because the vault is in record mode. So the sequence only differs from today's for a new record or a copy.

*Alternative considered:* upload in parallel. Rejected: a partial failure is harder to report, and evidence files are few and small (10 MB cap).

### D3. The records table replaces the list inside `PreviousSubmissions`

The component keeps its props, its selection and attach state, its dialogs and its `key={subsidiaryId}` remount. Only the rows change, from a stack of buttons to the shadcn `components/ui/table.tsx`. The component may be renamed `RecordsTable`, with the file renamed to match.

- **Rows.** The period cell holds the open button, with the accessible name it has today. The checkbox stays a sibling of that button, never inside it. Actions stay in the last cell.
- **Values.** The value and unit are formatted with the locale number helper. tCO₂e uses `formatTCo2e` as today.
- **Evidence cell.** It shows `evidenceCount`, or "missing" when `needsEvidenceBeforeSubmit`-style logic says a file is required and the count is 0. It uses the shared rule, not a copy.
- **Width.** The table sits in an `overflow-x-auto` wrapper, so on a narrow screen only the table scrolls sideways.
- **Placement.** It moves out of the side column to a full-width row under the form grid.

*Alternative considered:* a new component beside the old list. Rejected: two places would hold the selection and attach logic.

### D4. Filters are server-side and owned by the page

The page holds `recordFilters: { year: number | 'all', status?: ActivityRecordStatus, category?: Category }` and a `yearPinned` flag.

- **Year.** While `yearPinned` is false, `year` mirrors the form's `reportingYear`. Choosing any year, or All years, in the filter sets `yearPinned`.
- **Subsidiary switch.** It resets both, like the table's own remount.
- **Reads.** `refreshRecords` and `loadMoreRecords` send the filters to `listActivityRecordPage` and `activityRecordMetadata`. A filter change refetches from the first page; the cursor is reset.
- **Metadata.** The totals and attachable ids from `activityRecordMetadata` then describe the filtered set. This matches what the table shows, and the bulk-submit and attach rules are unchanged.
- **Status.** One status at a time, or All, for simplicity. The API accepts several.

### D5. Collapsible sections use one disclosure pattern

Additional context and Bulk upload use the existing `components/ui/collapsible.tsx` (Radix): a header trigger that carries `aria-expanded` and `aria-controls`, and a chevron.

- **State.** The open state is page state and is not persisted.
- **Context.** Additional context opens when a loaded record has any context value.
- **Bulk upload.** `BulkUploadPanel` and `RecentImports` render inside the Bulk upload section. Their props and refresh wiring are unchanged.

### D6. The side column is sticky on wide screens

The side column gets `lg:sticky lg:top-6 lg:self-start`, with `lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto` so a tall coverage panel stays reachable. Below `lg` it stacks after the form as today.

## Risks / Trade-offs

- **[A record is created but its file fails]** → The record is a draft, which is the state today's flow leaves it in, and the form says which files failed and offers Retry. No submit is sent. The server's gate refuses a submit without a file in any case.
- **[A held file goes to the wrong record]** → Upload only to the `rec.id` returned by the same session's save, and stop when the session changed (D2 step 2). An e2e test switches subsidiary while a save is in flight and asserts that no file reached a record.
- **[A just-saved record is outside the filter]** → For example, saving a 2024 record while All years is unpinned is fine, but a pinned 2025 filter hides it. The save toast still confirms the save, and the year filter follows the form unless pinned. Accepted.
- **[E2E locators break]** → The open button and checkbox names are kept (D3). The specs that still change are listed in tasks 4.4 and 5.3, and each is run.
- **[Phone width]** → The app shell pads every page by a fixed 280 px sidebar (`pl-[280px]`, nine pages on main), so at 390 px the whole page scrolls sideways before this change and after it. Measured: 0 px overflow at 1440, 1024 and 820 px, with only the records table scrolling inside its frame; 237 px at 390 px, from the shell. A responsive shell is filed under Open questions, not built here.
- **[The page grows further]** → `page.tsx` is about 2,400 lines. The held-file sequence goes into a small, tested helper under `apps/web/lib/`. The page only wires it.

## Migration Plan

Web only. It deploys with the normal QA autodeploy, and a revert of the PR restores the old layout. There is no data to migrate.

QA's retest notes go in the status entry:

- the new section order;
- choosing a file before the first save;
- the records table and its filters.
