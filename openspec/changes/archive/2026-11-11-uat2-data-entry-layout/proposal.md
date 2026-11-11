# Proposal

## Why

UAT round 2 found the Data Entry screen scattered and hard to use (QA report Rev02, **BUG-R2-05**, P2). Three causes:

- The bulk upload and recent imports sit between Reporting scope and Activity data. The second box a user meets is not the form they came to fill.
- The evidence box only appears after the record has been saved, because a file needs a record id. To submit an evidence-required record, the user clicks Submit, is told to attach a file, attaches it in a box that has just appeared, and clicks Submit again.
- The records a user has entered are a narrow list in the right column. It shows period, category, entity and tonnes, but not the value, the unit or whether a file is attached. The records cannot be read as one table.

QA asked for a fixed order: 1 Reporting scope, 2 Activity data, 3 Evidence document, 4 everything else (additional context, bulk upload), and a summary table of the entered records at the bottom. The owner took every recommendation of the design proposal (2026-11-11): K-A (b), K-B (a), K-C as proposed, K-D yes.

## What Changes

- **Section order.** The form column reads, top to bottom:
  1. Reporting scope;
  2. Activity data;
  3. Evidence document, always shown;
  4. Additional context, collapsed;
  5. the anomaly note, the Edit-mode band and the Save draft / Submit buttons;
  6. Bulk upload, with Recent imports inside it, collapsed.
- **Evidence before the first save (K-A b).** On a new record, the Evidence card takes files before the record exists. It holds them in the browser, checks type and size, lists them, and lets the user remove one. The first Save draft or Submit creates the record, uploads the held files to it, and only then runs the evidence check and the submit. An evidence-required record with a file chosen is submitted in one click.
  - A failed upload leaves the record as a saved draft. The form stays open on it. The files that did not upload stay listed with Retry and Remove. No submit is sent.
  - Held files belong to one form session. Starting a new record, switching subsidiary, Cancel or opening another record drops them. They are never uploaded to a record other than the one their own save created.
  - The server's evidence gate on submit and approve is unchanged and stays the final word.
  - A record that already exists keeps today's vault, which uploads straight to it.
- **Records table (K-C).** A full-width table below the form and the side panels replaces the Previous submissions list. Columns: period, category and activity, entity (site or whole company), value and unit, tCO₂e, evidence (file count, or "missing" where a file is required), status, actions (Edit, Recall, Copy to new draft).
  - It keeps every behaviour of the list it replaces: open on click, selection and bulk submit, attach one file to several records, Load more.
  - Filters for reporting year, status and category, sent to the API, which supports them today. The year filter starts at the form's reporting year and follows it until the user picks a year in the filter; "All years" is offered.
  - **No total row.** A sum over drafts, submitted and approved records would read as a total it is not. The Emissions page stays the place for totals.
- **Side column (K-D).** The calculation preview, invoice coverage and boundary coverage stay to the right of the form and stay in view while the form scrolls, on wide screens.
- **Copy, Turkish and English.** The table's title, columns, filters and empty states, the Evidence card's held-file states, and the Bulk upload and Additional context toggles.

**Out of scope.**

- BUG-R2-08, several equipment rows under one refrigerant record. The Activity data card is where they will go; this change leaves room for them and builds none.
- Any API, schema or shared-type change. The list filters, `evidenceCount`, the value and the unit are already in the contract.
- Totals or subtotals on Data Entry.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `activity-data-entry`: the Data Entry screen's section order, files chosen before the first save, the records table and its filters, and the collapsed secondary sections. The submit requirement changes so that a file chosen before the first save lets an evidence-required record submit in one click. The Edit and opened-record requirements name the records table instead of Previous submissions.

## Impact

- **Web only:**
  - `apps/web/app/data-entry/page.tsx`: section order, the side column, the save and submit sequence with held files, the table's filters in the record list reads;
  - `apps/web/components/data-entry/evidence-vault.tsx`: a held-files mode for a record that does not exist yet;
  - `apps/web/components/data-entry/previous-submissions.tsx`: becomes the records table, with its selection, attach and bulk-submit dialogs kept;
  - `apps/web/components/data-entry/bulk-upload-panel.tsx` and `recent-imports.tsx`: placed inside one collapsible section;
  - `apps/web/messages/{en,tr}/dataEntry.json`.
- **Tests:** web Vitest specs for the held-file sequence and the table's filter state; e2e specs that locate Previous submissions rows or the bulk upload (`data-entry-happy`, `data-entry-turkish`, `record-edit`, `drafts-bulk-submit`, `drafts-bulk-submit-evidence`, `bounded-reads`, `analytics`), and a new e2e flow for a one-click evidence submit.
- **Docs:** `docs/md_docs/data_entry_page.md` (page architecture and the evidence vault).
- **API, database, RLS, audit:** no change. Uploads go through the existing evidence endpoint, which writes its own audit rows.
