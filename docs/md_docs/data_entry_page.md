# Page Spec: Data Entry Workspace
**Route:** `/dashboard/data-entry`

## 1. Page Purpose
The Data Entry page is the main operational workspace for creating, editing, uploading, and submitting activity data records.

It is designed as a split view workspace that supports:
- structured category navigation
- dynamic entry forms
- live emissions calculation preview
- anomaly detection
- evidence upload
- draft and submission workflows

---

## 2. Page Architecture

The page reads in a fixed order (UAT round 2, BUG-R2-05):

- **Form column**, top to bottom:
  1. `Reporting scope` (subsidiary, location, category, year, period);
  2. `Activity data` (value, unit, the category's own inputs);
  3. `Evidence` (§6), shown for every record, saved or not;
  4. `Additional context`, collapsed until opened; it opens by itself for a record that holds a context value, and when a save is refused for one of its fields;
  5. the anomaly note, the Edit-mode band and the action bar (§8);
  6. `Bulk upload` (§9), collapsed until opened, with `Recent imports` inside it.
- **Side column**: the calculation preview, `Data collection status` and the inventory boundary. On wide screens it stays in view while the form scrolls.
- **Bottom, full width**: `Entered records` (§9.2), every record of the selected subsidiary as one table.

### Responsive Behaviour
- Desktop: form and side column side by side, the records table below both
- Tablet and mobile: one column (form, side column, records table); only the records table scrolls sideways

---

## 3. Component: Live Session Totals

**Layout:** 4 column metrics row on desktop

These values update from frontend state before final database commit.

| Metric Box | Label | Logic | Unit |
| :--- | :--- | :--- | :--- |
| BOX-01 | Total Session Impact | Sum of current draft and active session entries in the current page context | tCo2e |
| BOX-02 | Scope 1 Subtotal | Sum of active session entries in Scope 1 | tCo2e |
| BOX-03 | Scope 2 Subtotal | Sum of active session entries in Scope 2 | tCo2e |
| BOX-04 | Scope 3 Subtotal | Sum of active session entries in Scope 3 | tCo2e |

### Notes
- These are session level working totals
- They are not the same as approved reporting totals
- Values should reflect current editable state where possible

---

## 4. Component: Category Navigation

### Layout
Left side panel with:
- category search
- accordion groups
- status badges

### Search
Small search bar to filter categories by name

### Accordion Groups
- **Scope 1**
  - stationary_combustion
  - mobile_combustion
  - process_emissions
  - fugitive_emissions

- **Scope 2**
  - purchased_electricity
  - purchased_heating
  - purchased_steam
  - purchased_cooling

- **Scope 3 Upstream**
  - purchased_goods_and_services
  - capital_goods
  - fuel_and_energy_related_activities
  - upstream_transportation_and_distribution
  - waste_generated_in_operations
  - business_travel
  - employee_commuting
  - upstream_leased_assets

- **Scope 3 Downstream**
  - downstream_transportation_and_distribution
  - processing_of_sold_products
  - use_of_sold_products
  - end_of_life_treatment_of_sold_products
  - downstream_leased_assets
  - franchises
  - investments

### Visual State
Each category item should show a status badge such as:
- `draft`
- `submitted`
- `missing`
- `approved`
- `locked`

### Interaction
Selecting a category loads the corresponding dynamic form in the center workspace.

---

## 5. Component: Dynamic Input Form

Fields change based on selected `categoryKey`.

### 5.1 Header Section
- **Title:** Category name
- **Instructions:** Short helper text explaining expected activity data and evidence type

### 5.2 Entry Fields
- **Reporting Entity:** Select dropdown for subsidiary or operational location
  - selected entity determines `geographyCode` for factor selection
- **Date Range:** Start date and end date picker
- **Activity Value:** Numeric input
- **Unit Selector:** Filtered dropdown based on `categoryKey`
- **Description / Notes:** Optional text area

### 5.3 Optional Conditional Fields
Show when relevant:
- `Reason for Variance`
- sub category selector
- month or reporting period selector
- evidence requirement note

### 5.4 Validation Rules
- required fields must be completed
- unit must match allowed category units
- numeric value must be valid
- anomaly comment must be completed when triggered
- required evidence must be present before completion status can become complete

---

## 6. Component: Evidence Vault

### Upload Area
Drag and drop uploader with click to browse fallback

### Before the Record Is Saved (BUG-R2-05)
The evidence API needs a record id, so on a new record (or a copy) the vault **holds** the chosen files in the browser:
- each file is checked for type and size as it is chosen; a refused one is named in a toast (`notes.txt: unsupported type …`, `scan.png: larger than 10 MB`) and not listed
- held files are listed as `uploaded when you save`, each with a remove button
- the first `Save draft` or `Submit for review` creates the record, uploads the held files to it one at a time, reads the record again, and only then runs the evidence and anomaly checks and the submit. An evidence-required record with a file chosen is therefore submitted in one click
- held files belong to the form they were chosen in: `Start new record`, a subsidiary switch, `Cancel`, `Copy to new draft` or opening another record drops them, and a save still in flight when that happens uploads nothing
- a file that fails to upload leaves the record a saved draft and the form open on it. The vault lists the file under `Not uploaded. The record is saved as a draft.` with `Retry` and remove, and nothing is submitted
- a user who does not author records (consultant, executive viewer) sees no picker

### Supported Files
- PDF
- JPG
- PNG
- XLSX
- CSV

### Display
- file list with thumbnails or icons
- file name
- a file that also backs other records says so under its name — `Also backs 2 other records: Electricity · February 2026; Electricity · March 2026` (three named at most, then `+N more`)
- remove action where permitted. On a shared file it reads `Remove from this record` and takes the file off this record only; the toast says whether the file is gone (`Evidence removed`) or still backs others (`Removed from this record — q1.pdf still backs 2 other records.`)

### Validation Rule
Every Scope 1 and Scope 2 category requires evidence: Electricity, Natural Gas, Fuel, Mobile Combustion, Refrigerants and Fugitive Gas (the last three since K3, 2026-11-10, QA finding BUG-R2-02). Water does too, because its invoice is the only check its reading gets. The other Scope 3 categories do not. For an evidence-required record:
- completion status cannot become complete unless at least one evidence file is attached;
- **Submit** saves the record first, then uploads any file held for it. With still no file, the form keeps the saved draft open with this vault on screen and asks for a file (`Saved. Attach at least one evidence file below, then submit again.`) instead of sending the submit. The API refuses such a submit anyway (`evidence_required`);
- **Approve** refuses a record that reached review without a file, which records of the three K3 categories could do before 2026-11-10 (`approval_evidence_missing`). Files are locked after submit, so the reviewer rejects the record and its author attaches one and submits again.

### One File for Several Records
One document can evidence several records of the same subsidiary (WP8 decision 3a) — e.g. a quarterly invoice behind three monthly records, or the invoice behind the drafts of an import. It is attached from **Entered records** (§9.2), not from the vault, and the vault of each record then lists it. Attaching and removing follow the record's own rules: its author or a `super_admin`, while it is a `draft` or `rejected`, and while its period is open.

---

## 7. Component: Intelligence Panel

The right side panel provides live calculation visibility and anomaly feedback.

### 7.1 Real Time Calculation Card
- **Label:** `Live Calculation Estimate`
- **Formula View:** `{{activityValue}} {{unit}} × {{factorValue}} = {{kgCo2e}} kgCo2e`
- **Primary Result:** large bold `X.XX tCo2e`
- **Factor Traceability:** methodology and geography source text such as:
  - `Using DEFRA 2024 (UK) factor`
- **Optional Detail:**
  - normalized value
  - conversion applied
  - factor source label
  - demo factor badge if applicable

### 7.2 Anomaly Alert
This appears conditionally.

#### Trigger
Calculated result differs by more than 50 percent from the rolling average of the previous 3 comparable periods for the same reporting entity (subsidiary + location) and category, at the same granularity.

**One earlier period is enough for the rule to run (since 2026-11-11, BUG-R2-07).** With one or two the record is checked on *limited history*; with none it is *not evaluated* — which is not the same claim as *not anomalous*. The screen must say which, rather than render nothing: rendering nothing tells the author "fine" about a value nobody checked, or checked against less than it looks. `validation_anomaly_rules.md` §4.1 is the normative statement of the rule.

| `anomalyBaselinePriorCount` | What the form shows |
|---|---|
| `3` and a non-zero average | the amber banner when flagged, naming the average; nothing when not |
| `1`–`2` and a non-zero average | the amber banner when flagged, naming the average and "limited history (N periods)"; a neutral "Within range on limited history" note when not |
| `0`, flagged | the amber banner "Above the first-period ceiling", with the amount and the ceiling in the entered unit (or, for refrigerants, the equipment line's capacity or refill and the limit it passed), asking for the evidence and the unit to be checked; the variance field is mandatory (since 2026-11-13, Decisions 2026-11-12) |
| `0` unflagged, or an average of zero | a neutral note saying why: "First-period record" for no earlier period, "Not checked for anomalies" for a zero average. Deliberately not amber: no earlier period is the normal state of a new series' first period |
| `1`–`2` and no average | the same neutral note, saying the record was scored when the check needed three periods (a verdict from before 2026-11-11, kept until the record is next saved or submitted) |
| `null` | "no calculated figure", so there is nothing to compare — the Water case |

The normative statement of the rule, including why the baseline key deviates from VAR §4.1 as originally written, is `validation_anomaly_rules.md` §4.1. This section describes only what the Data Entry screen does with it.

#### UI Behaviour
- right panel alert card border turns amber
- warning message becomes visible
- `Reason for Variance` field appears
- `Reason for Variance` becomes required before submit is enabled

---

## 8. Action Bar

Sticky action bar at the bottom of the page.

### Actions
- `Save Draft`
- `Submit for Review`

Bulk upload is not an action-bar action — it has its own panel on the page (§9).

### Behaviour
#### Save Draft
- saves data in `draft` status
- keeps record editable
- triggers toast: `Draft saved successfully.`

#### Submit for Review
- triggers validation
- changes status to `submitted`
- record becomes read only for `data_entry`
- record appears in review and history workflows
- triggers toast: `Record submitted for review.`

---

### Edit, Recall and Copy to new draft (BUG-R2-03)
A record is held in the form in one of two ways:
- **Opened** — a Entered records row, a dashboard link, or the record just saved. A changed location re-files it in place, with the move notice. A changed category, year or period starts a **new** record (`Now entering a new record.`), and the opened record is left as it was. This guards against the implicit overwrite that once turned a Fuel Q3 draft into Q4.
- **Edit mode** — entered only by the `Edit` action: on a Entered records row, or beside `Editing draft …` for the open record. It is offered only to the record's **author**, `super_admin` included (a `super_admin` cannot edit a colleague's record; they reject it with a note), on a `draft` or `rejected` record in an open period. In Edit mode, the following change the **same** record on save:
  - activity value
  - category
  - activity type
  - reporting year
  - period
  - location

  A band lists each change (`Category: Fuel → Electricity`, `Period: Q3 → Q1`, …), and `Cancel editing` puts the form back to the record as stored. A category change clears the activity type, unit and category inputs. The subsidiary never changes; choosing another subsidiary leaves Edit mode.

What happens to the record's evidence files in Edit mode:
- **Category change:** the band lists every file and warns that a file backing no other record is deleted and must be uploaded again. Save and Submit stay disabled until the user ticks `Remove the N file(s) and save`. The API refuses a category change that leaves a file attached (`evidence_detach_required`).
- **Type, year, period or location change:** each file has a `Remove …` choice and is kept unless it is ticked, with the same deletion warning.
- **Value change:** files are untouched.

`Recall` shows on the author's own `submitted` rows. After a confirmation (`Recall this submission?`), the record leaves the review queue and is a draft again, ready to edit and resubmit. Once a reviewer has taken it into review it cannot be recalled (`record_not_recallable`); the reviewer returns it by rejecting it.

`Copy to new draft` shows on a `voided` record, to its author and to a `super_admin`. It is on the Entered records row and in the Emissions record drawer, which opens `/data-entry?copyFrom=<id>`. It is D04's re-entry:
- The form opens as a **new** record filled with the voided record's values. No file and no variance comment are copied.
- The subsidiary stays selectable. Switching it keeps the values and clears only the location.
- Saving creates a draft whose author is the user who copied it, and it follows the normal review path.

---

## 9. Bulk Upload and Bulk Submit

This page can import many records at once and send many drafts for review at once. The importer is a `Bulk upload` panel on the page itself, not a modal workflow — the only dialogs are the confirmations before importing and before submitting. Bulk submit is offered in two places: by the panel, for the rows it has just imported, and by a checkbox list on `Entered records`, for drafts already on the list.

The server-side rules behind this section, and the reasons for them, are in [`docs/api/endpoints.md`](../api/endpoints.md) (the WP8 bulk upload and bulk submit paragraphs).

### 9.1 Bulk Upload Panel

#### Placement and Access
- sits below the form's action bar, in the collapsed `Bulk upload` section with `Recent imports`, outside the "editing a record" (`editingId`) gate: it is the alternative to entering records one at a time, and an importer has no open record (it sat between `Reporting scope` and `Activity data` until BUG-R2-05)
- rendered only for `data_entry` and `super_admin`; for any other role the panel is absent rather than disabled

#### Template
- `Download template` in the panel header downloads an XLSX
- rows name reporting entities by **id**, and the template is what makes that typeable
- sheet 1 holds only the nine import columns: a header row, dropdowns for the reporting period, period value and category, and no pre-filled entity rows
- sheet 2 lists the reporting entities the user can reach (id, name, geography), the vocabularies, the unit list for each category and a worked example; the importer reads only the first worksheet, so sheet 2 is never imported

#### Picking a File
- `Choose a file`, or drop a file on the upload area: CSV or XLSX, up to 1,000 rows, max 2 MB
- **the file must be UTF-8 text.** A CSV saved as anything else — and on a Turkish Windows, Excel's plain `CSV` export writes cp1254, not UTF-8 — is refused whole, with `The file is not UTF-8 text. In Excel, save it as "CSV UTF-8 (Comma delimited)" and upload it again.` The same rule covers a workbook's XML, under its own sentence. Nothing is transcoded and nothing is guessed: the decode a non-UTF-8 file would get is lossy and silent, so the Turkish characters in a free-text cell such as `varianceReason` would be stored as `\uFFFD` on a record that can never be edited. Save the file again as **CSV UTF-8** and it imports unchanged
- a workbook is read from its **first** sheet only — the sheet at the front of the tab order, hidden sheets included, whatever it is named (the template calls it `Records`). It is refused whole when merged cells cover a cell the import reads (the merged value shows in every cell on screen but is stored only in the first one — unmerge the cells and fill in each row), when a cell holds a date that is out of range, or when it unpacks to more than 16 MB
- the browser first checks the extension, the size and that the file is not empty; a file that fails is refused with a toast and no request is sent
- otherwise **picking or dropping the file starts the dry run** — there is no separate check step. While it runs, the upload area reads `Checking <file name>… nothing is being written.`
- the dry run validates, prices and dedupes every row (against the rest of the file and against stored records that are not voided) and creates no records; the only row it writes is the batch's own audit entry (`action: bulk_import`, `dryRun: true`)
- a refusal of the whole file is shown inside the panel, followed by `Nothing was imported.`

#### Dry-Run Report
- a verdict (how many rows would be imported), the tonnage of the accepted rows and the file name
- an `Accepted rows` table: file row, year, period, category, activity type and the **amount read** — the number and unit the server read and will store, written in the user's language with every digit (`1,234 kWh` in Turkish for a file's `1.234`), under the note that a file's numbers are read with a point as the decimal separator (D15). A language change re-writes the amounts, never changes them
- a value with a comma (`1,5`, `1.234,5`, `1,200`) is refused on its row as `Comma in a number` (`wrong_decimal_separator`), never reinterpreted; a value above 1,000,000,000,000 (`ACTIVITY_VALUE_MAX`) as `Value too large` (`activity_value_too_large`) — the same refusal the entry form shows on the field (`Enter at most 1,000,000,000,000.`). Issue-group labels follow the user's language
- problems are grouped by what is wrong rather than listed row by row. Errors keep a row out of the import. Warnings do not: they note that a row cannot be submitted as it stands (e.g. it needs an evidence file), or that its variance reason starts with a character a spreadsheet reads as a formula
- a problem quotes at most 40 characters of the value it is about, followed by `…` when the value is longer. Each quoted value is wrapped in double quotes, and characters that disguise text (control characters, bidi embeddings, overrides and isolates such as U+202E, and invisible ones such as U+200B, U+2060 and U+FEFF) are **named** in the quote rather than shown or dropped — `category<U+200B>`, a run as `<U+2063 x40>` — so a value that looks right but is refused says which character made it wrong. A literal `"`, `<` or `…` in the value is named the same way, so a cell cannot forge the sentence's own syntax. In the file name those characters are dropped rather than named, and it is shown up to 255 characters, with nothing marking a cut
- actions: `Import N rows` (only when at least one row is accepted) and `Choose a different file`

#### Confirm and Import
- `Import N rows` opens an `Import these rows?` confirmation; no record is created until it is confirmed
- the confirmation names the row count and the tonnage, says each row becomes its own record and the import cannot be undone in bulk, and says the rows **arrive as drafts**
- rows are created one at a time through the ordinary create path, never a bulk upsert, so each gets its own immutable factor snapshot, the same lifecycle gates as a typed record and its own `create` audit row, beside one `bulk_import` row for the batch. A file refused before any row is read is recorded only when the refusal is about the caller — a role that may not author, or a row naming an entity outside the caller's tenant — not when the file itself is malformed
- imported rows land as `draft`: they count towards no total and appear in no review queue, so the `Data collection status` panel on the same screen does not move until they are submitted. The verdict repeats this, and the toast reads `N records imported as drafts. Send them for review below to count them towards your inventory.`
- no transaction spans the import, so a failure part-way through (e.g. a period lock landing mid-import) can leave part of the file written. The report is **not** cleared afterwards — the error list is the user's work list — and after a partial import the verdict advises uploading only the rows that failed, because re-sending the whole file would report the imported rows as duplicates
- after every attempted import, successful or not, `Entered records` and the `Data collection status` panel refresh for the selected subsidiary
- `Upload another file` resets the panel
- every applied import is kept as an **import batch**: its file, its outcome and the drafts it created. The panel's `Recent imports` card lists the last ten imports the user can see, newest first, and survives a page refresh — the panel's own report does not
- a whole file is refused when a row names a reporting entity the user cannot reach — a subsidiary, or a location belonging to one — with `Row(s) N name a reporting entity that does not exist or is not yours.`
- limits: 1,000 rows, 2 MB (16 MB once a workbook is unpacked) and 5 imports per minute per user; a dry run and an import each count

### 9.2 Bulk Submit

Both entry points use the same bulk-submit endpoint. It submits the records one at a time through the same `submit` the form uses — so the status gate, the author gate (every submit, decision D02), the period lock, the evidence requirement and the **recomputed** anomaly verdict all still run — in chronological order, whatever order they were selected in. On top of the single-record path:
- **drafts only**: a `rejected` record is resubmitted on its own, so the reviewer's note gets read
- **only records the user entered** — a `super_admin` included (decision D02, 2026-09-29: only the author submits)
- at most 1,000 records per submission, and 10 submissions per minute per user
- **no dry run, but always a confirmation**: `Send these for review?` states the count and that the author can recall a record only until a reviewer opens it; after that only the reviewer can send it back (§8)
- the result is a verdict plus a per-record failure list in the server's own words. The anomaly verdict is recomputed at submit time, so the screen never tries to predict it

#### From the Bulk Upload Panel
- after a real import (not a dry run), `Send N records for review` sends the rows just imported
- rows in an evidence-required category are held back, because an import cannot attach an evidence file; when that holds back every row, the panel says so instead of offering the button, and points to Entered records, where one file can be attached to several of the drafts
- after a submission, `Entered records` and the `Data collection status` panel refresh, even when the request fails
- **on the seeded demo data this path submits nothing, by construction**: every category that can be imported there requires evidence — Electricity, Natural Gas and Fuel, the only categories the seeded factor library covers, and Water, which is recorded without a calculated figure. With the TR releases loaded the same holds for Mobile Combustion, Refrigerants and Fugitive Gas (K3): only the other Scope 3 categories go straight from an import to review

#### From Recent Imports
- each applied import shows its file name, date and time, who imported it, and its outcome (`2 imported · 1 refused`); a batch whose outcome was never recorded (the import was interrupted) says so rather than showing zero
- `Download file` opens the original file the rows came from, through a short-lived link
- `Send N drafts for review` sends the drafts of that import the user entered that are not waiting for an evidence file; drafts that are waiting are counted in a note under the batch — `2 drafts need an evidence file first — under Entered records, attach each invoice to the drafts it evidences; one file can cover several.` — and the button is absent when none can go
- the same confirmation as the other entry points; the toast gives the verdict and, when records were not moved, the reasons (`Needs an evidence file · 2`)
- a `data_entry` user sees only the imports they made, and only while they can still reach every subsidiary the file names (the original file holds every row); `consultant`, `executive_viewer` and `super_admin` see every import in their organisation

#### The Entered Records Table (BUG-R2-05)
- one row per record of the selected subsidiary: period and year (the open control, named `Q1 2026 Electricity, Whole subsidiary`), category with activity type, location or `Whole subsidiary`, value and unit, tCO₂e or `Not calculated`, evidence (`N files`, or `Missing` where the category requires a file and a live record has none), status, and the row's `Edit`, `Recall` and `Copy to new draft`
- a voided row's value and tCO₂e are struck through. The table shows **no total**: a sum over drafts, submitted and approved records would read as a figure it is not; totals live on Emissions
- filters for `Reporting year`, `Status` and `Category`, applied by the API so every page, Load more included, honours them. The year starts at the form's reporting year and follows it until the user picks a year (or `All years`); a subsidiary switch resets them. With a filter on and nothing found, the table says `No record matches these filters.`
- `Showing N of M` counts the filtered set

#### From Entered Records
- a row gets a checkbox only when every gate the client can check passes. The list applies the server's gates in the server's order — role, status, authorship, period lock — plus the evidence rule: an evidence-required category with no file attached, so a draft whose invoice is attached qualifies. The anomaly verdict is left to the server, so a ticked draft can still come back refused, e.g. for a missing variance reason
- a `draft` or `rejected` row that cannot be ticked shows a one-line reason instead, e.g. `Sent back by a reviewer — open it on its own, so the note gets read.`, `Entered by someone else.` or `Needs an evidence file.`; rows in other statuses rely on their status badge
- no checkboxes appear until the current user has loaded
- `Select all N` and individual checkboxes offer only the current user's own eligible drafts, up to 1,000 selected records. Submit is author-only (decision D02), including for `super_admin`; someone else's draft cannot be ticked or submitted.
- a selection shows a bar with `N selected`, `Clear` and `Send N records for review`; a tick beyond 1,000 is refused with a notice

#### Attaching One File to Several Records (Entered Records)
- `Attach one file to several records` switches the list into its own selection. It is separate from the submit selection because the records it is for — drafts waiting for their invoice — are exactly the ones the submit selection leaves out
- a row gets a checkbox when it can take a file: `draft` or `rejected`, entered by the current user (a `super_admin` included — Decisions 2026-11-12), period open. A draft or rejected row that cannot shows the reason (`Entered by someone else.`, `Q1 2026 is locked.`); there is no `Select all` — the user ticks the records this one document evidences
- the bar reads `Tick the records this one document evidences.` until something is ticked, then `N selected`, `Cancel` and `Attach one file to N records`, which opens the file chooser (PDF, JPG, PNG, XLSX, CSV, ≤10 MB, checked before upload)
- `Attach this file?` names every record the file will back and says reviewers see every record it backs; `Attach` uploads once and links all of them
- all or nothing: if any record can no longer take the file, nothing is uploaded and the toast names each refused record and why; the selection stays so the user can untick them
- on success the toast says `q1.pdf now backs 3 records.`, the list refreshes (the drafts that were waiting for this file get their submit checkbox) and the open record's vault reloads
- when the request succeeds, the selection clears and the verdict and any per-record failures appear above the list; when the request itself fails, a toast explains why and the selection stays. The list refreshes either way, since a failed request may still have moved records

---

## 10. Interaction States

### Loading
- shimmer or skeleton on calculation preview card
- disabled actions while loading or validating

### Success
- show action specific toast
- refresh category badge and relevant matrix state

### Locked
If record status is `locked`:
- disable all form fields
- disable upload changes
- show locked badge
- show unlock or revision action only for authorised roles

### Submitted or Approved
If record status is `submitted` or `approved`:
- fields become read only for `data_entry`
- audit visibility remains available
- a `submitted` record can be recalled to draft by its author before review starts (§8); an approved figure is corrected by void and `Copy to new draft`

---

## 11. Notes for Development
- This page is for creation and submission, not historical analysis
- Calculation preview must update in real time when enough valid data exists
- Category navigation and badge states must stay in sync with current record state
- Use `tCo2e`, `kgCo2e`, `categoryKey`, and `geographyCode` consistently
- Keep the right side intelligence panel visible on desktop because it is a core value feature