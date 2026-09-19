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

This page uses a split layout:

- **Top:** Live Session Totals
- **Left:** Category Navigation
- **Center:** Active Input Form
- **Right:** Calculation Preview and Anomaly Alerts
- **Bottom:** Sticky Action Bar

### Responsive Behaviour
- Desktop: three panel workspace
- Tablet: left navigation collapses, right panel stacks below form if needed
- Mobile: navigation becomes accordion drawer, right panel moves below form

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

### Supported Files
- PDF
- JPG
- PNG
- XLSX
- CSV

### Display
- file list with thumbnails or icons
- file name
- remove or delete action where permitted

### Validation Rule
If the selected category is configured as evidence required, completion status cannot become complete unless at least one evidence file is attached.

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

**All three priors must carry a figure, or the rule does not run.** A record on a shorter window is *not evaluated* — which is not the same claim as *not anomalous* — and the screen must say so rather than render nothing: rendering nothing tells the author "fine" about a value nobody checked. The three states the entry form distinguishes are:

| `anomalyBaselinePriorCount` | What the form shows |
|---|---|
| `3` and a non-zero average | the amber banner when flagged, and the average it was compared against when not |
| `0`–`2`, or a full window averaging zero | a neutral "Not checked for anomalies" note naming how many priors exist. Deliberately not amber: a short window is the normal state of a new series' first months |
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

## 9. Bulk Upload and Bulk Submit

This page can import many records at once and send many drafts for review at once. The importer is a `Bulk upload` panel on the page itself, not a modal workflow — the only dialogs are the confirmations before importing and before submitting. Bulk submit is offered in two places: by the panel, for the rows it has just imported, and by a checkbox list on `Previous submissions`, for drafts already on the list.

The server-side rules behind this section, and the reasons for them, are in `README.md` (the WP8 bulk upload and bulk submit paragraphs).

### 9.1 Bulk Upload Panel

#### Placement and Access
- sits between the `Reporting scope` card and the `Activity data` card, outside the "editing a record" (`editingId`) gate: it is the alternative to entering records one at a time, and an importer has no open record
- rendered only for `data_entry` and `super_admin`; for any other role the panel is absent rather than disabled

#### Template
- `Download template` in the panel header downloads an XLSX
- rows name reporting entities by **id**, and the template is what makes that typeable
- sheet 1 holds only the nine import columns: a header row, dropdowns for the reporting period, period value and category, and no pre-filled entity rows
- sheet 2 lists the reporting entities the user can reach (id, name, geography), the vocabularies, the unit list for each category and a worked example; the importer reads only the first worksheet, so sheet 2 is never imported

#### Picking a File
- `Choose a file`, or drop a file on the upload area: CSV or XLSX, up to 1,000 rows, max 2 MB
- a workbook is read from its **first** sheet only. It is refused whole when merged cells cover a cell the import reads (the merged value shows in every cell on screen but is stored only in the first one — unmerge the cells and fill in each row), when a cell holds a date that is out of range, or when it unpacks to more than 16 MB
- the browser first checks the extension, the size and that the file is not empty; a file that fails is refused with a toast and no request is sent
- otherwise **picking or dropping the file starts the dry run** — there is no separate check step. While it runs, the upload area reads `Checking <file name>… nothing is being written.`
- the dry run validates, prices and dedupes every row (against the rest of the file and against stored records that are not voided) and creates no records; the only row it writes is the batch's own audit entry (`action: bulk_import`, `dryRun: true`)
- a refusal of the whole file is shown inside the panel, followed by `Nothing was imported.`

#### Dry-Run Report
- a verdict (how many rows would be imported), the tonnage of the accepted rows and the file name
- problems are grouped by what is wrong rather than listed row by row. Errors keep a row out of the import. Warnings do not: they note that a row cannot be submitted as it stands (e.g. it needs an evidence file), or that its variance reason starts with a character a spreadsheet reads as a formula
- a problem quotes at most 40 characters of the value it is about, followed by `…` when the value is longer. Each quoted value is wrapped in double quotes, and characters that disguise text (control characters, bidi embeddings, overrides and isolates such as U+202E, and invisible ones such as U+200B, U+2060 and U+FEFF) are **named** in the quote rather than shown or dropped — `category<U+200B>`, a run as `<U+2063 x40>` — so a value that looks right but is refused says which character made it wrong. A literal `"`, `<` or `…` in the value is named the same way, so a cell cannot forge the sentence's own syntax. In the file name those characters are dropped rather than named, and it is shown up to 255 characters, with nothing marking a cut
- actions: `Import N rows` (only when at least one row is accepted) and `Choose a different file`

#### Confirm and Import
- `Import N rows` opens an `Import these rows?` confirmation; no record is created until it is confirmed
- the confirmation names the row count and the tonnage, says each row becomes its own record and the import cannot be undone in bulk, and says the rows **arrive as drafts**
- rows are created one at a time through the ordinary create path, never a bulk upsert, so each gets its own immutable factor snapshot, the same lifecycle gates as a typed record and its own `create` audit row, beside one `bulk_import` row for the batch. A file refused before any row is read is recorded only when the refusal is about the caller — a role that may not author, or a row naming an entity outside the caller's tenant — not when the file itself is malformed
- imported rows land as `draft`: they count towards no total and appear in no review queue, so the `Data collection status` panel on the same screen does not move until they are submitted. The verdict repeats this, and the toast reads `N records imported as drafts. Send them for review below to count them towards your inventory.`
- no transaction spans the import, so a failure part-way through (e.g. a period lock landing mid-import) can leave part of the file written. The report is **not** cleared afterwards — the error list is the user's work list — and after a partial import the verdict advises uploading only the rows that failed, because re-sending the whole file would report the imported rows as duplicates
- after every attempted import, successful or not, `Previous submissions` and the `Data collection status` panel refresh for the selected subsidiary
- `Upload another file` resets the panel
- every applied import is kept as an **import batch**: its file, its outcome and the drafts it created. The panel's `Recent imports` card lists the user's last ten, newest first, and survives a page refresh — the panel's own report does not
- a whole file is refused when a row names a reporting entity the user cannot reach — a subsidiary, or a location belonging to one — with `Row(s) N name a reporting entity that does not exist or is not yours.`
- limits: 1,000 rows, 2 MB (16 MB once a workbook is unpacked) and 5 imports per minute per user; a dry run and an import each count

### 9.2 Bulk Submit

Both entry points use the same bulk-submit endpoint. It submits the records one at a time through the same `submit` the form uses — so the status gate, the author gate on a resubmission, the period lock, the evidence requirement and the **recomputed** anomaly verdict all still run — in chronological order, whatever order they were selected in. On top of the single-record path:
- **drafts only**: a `rejected` record is resubmitted on its own, so the reviewer's note gets read
- **only records the user entered**, except for a `super_admin`, whose author gate never fires
- at most 1,000 records per submission, and 10 submissions per minute per user
- **no dry run, but always a confirmation**: `Send these for review?` states the count and that only a reviewer can send the records back — there is no author-side un-submit
- the result is a verdict plus a per-record failure list in the server's own words. The anomaly verdict is recomputed at submit time, so the screen never tries to predict it

#### From the Bulk Upload Panel
- after a real import (not a dry run), `Send N records for review` sends the rows just imported
- rows in an evidence-required category are held back, because an import cannot attach an evidence file; when that holds back every row, the panel says so instead of offering the button
- after a submission, `Previous submissions` and the `Data collection status` panel refresh, even when the request fails
- **on the seeded demo data this path submits nothing, by construction**: every category that can be imported there requires evidence — Electricity, Natural Gas and Fuel, the only categories the seeded factor library covers, and Water, which is recorded without a calculated figure

#### From Recent Imports
- each applied import shows its file name, date and time, who imported it, and its outcome (`2 imported · 1 refused`); a batch whose outcome was never recorded (the import was interrupted) says so rather than showing zero
- `Download file` opens the original file the rows came from, through a short-lived link
- `Send N drafts for review` sends the drafts of that import the user entered (all of them, for a `super_admin`) that are not waiting for an evidence file; drafts that are waiting are counted in a note under the batch — `2 drafts need an evidence file first — open each under Previous submissions to attach one.` — and the button is absent when none can go
- the same confirmation as the other entry points; the toast gives the verdict and, when records were not moved, the reasons (`Needs an evidence file · 2`)
- a `data_entry` user sees only the imports they made, and only while they can still reach every subsidiary the file names (the original file holds every row); `consultant`, `executive_viewer` and `super_admin` see every import in their organisation

#### From Previous Submissions
- a row gets a checkbox only when every gate the client can check passes. The list applies the server's gates in the server's order — role, status, authorship, period lock — plus the evidence rule: an evidence-required category with no file attached, so a draft whose invoice is attached qualifies. The anomaly verdict is left to the server, so a ticked draft can still come back refused, e.g. for a missing variance reason
- a `draft` or `rejected` row that cannot be ticked shows a one-line reason instead, e.g. `Sent back by a reviewer — open it on its own, so the note gets read.`, `Entered by someone else.` or `Needs an evidence file.`; rows in other statuses rely on their status badge
- no checkboxes appear until the current user has loaded
- `Select all N` takes only the records the current user entered, up to 1,000. A `super_admin` can still tick someone else's draft one at a time; the confirmation then says how many were entered by someone else, who will no longer be able to edit them
- a selection shows a bar with `N selected`, `Clear` and `Send N records for review`; a tick beyond 1,000 is refused with a notice
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
- unlock or revision actions shown only if permitted by role

---

## 11. Notes for Development
- This page is for creation and submission, not historical analysis
- Calculation preview must update in real time when enough valid data exists
- Category navigation and badge states must stay in sync with current record state
- Use `tCo2e`, `kgCo2e`, `categoryKey`, and `geographyCode` consistently
- Keep the right side intelligence panel visible on desktop because it is a core value feature