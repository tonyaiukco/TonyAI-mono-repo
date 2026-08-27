# Functional Requirements: TonyAI Enterprise

## 1. Multi-Entity Management

### 1.1 Hierarchy
The platform must support a 3 tier structure:

- Holding Group
- Subsidiaries
- Operational Locations

### 1.2 Context Switching
Changing the active organisation in the global header must refresh and filter:

- dashboard metrics
- tracking matrix
- emissions analysis
- historical records
- reports
- subsidiaries
- suppliers

### 1.3 Data Isolation
Users must only be able to view and interact with data for organisations they are explicitly assigned to, based on role based access permissions.

---

## 2. Tracking Matrix Logic

### 2.1 Purpose
The Tracking Matrix must provide a subsidiary level view of category completeness for the selected reporting period.

### 2.2 Cell Status Rules

#### Red: Missing
Show red when:
- no data record exists for the selected category, reporting period, and organisation or subsidiary
- or every record in the cell has been **withdrawn** (`voided`). A withdrawn figure counts towards nothing, so the cell reports what is actually there. The withdrawn rows are still reported as a count, so the cell can say what happened rather than look like it lost track

#### Yellow: Incomplete
Show yellow when:
- a data record exists but is still in `draft` or `rejected` status
- or required evidence is missing
- or a record carries an **anomaly flag** — this is what "flagged for review" means here: the automated variance check in [`validation_anomaly_rules.md`](validation_anomaly_rules.md), not the human review queue. The two were not distinguished in an earlier draft of this section, which read as a contradiction against the green rule below
- or any committed record in the cell is still **awaiting review** (`submitted` or `under_review`)

#### Green: Complete
Show green when:
- a valid data record exists
- required evidence is attached where applicable
- and **every** committed record in the cell has been accepted by a person — status `approved` or `locked`

> **Amended 2026-08-21 (WP19).** Green previously included `submitted`, so a category
> went green the moment it was *sent* for review and nobody had looked at it. Round-1
> UAT raised that as **DE-2**; WP17 closed it for invoice-measured cells only, and this
> amendment extends it to every cell, so "green" means one thing across the matrix.
>
> Two consequences worth stating rather than discovering. The dashboard completion
> percentage now answers *"how much has been accepted"*, not *"how much has been keyed
> in"*, and will read lower for any organisation with reviews outstanding. And
> `submitted` records still count towards the emissions **inventory** — data queued for
> review must not vanish from the totals. Completeness and inventory are separate
> claims, computed separately, and this rule changes only the first.

#### The invoice rule — an additional condition, not a different one
A cell measured **by invoice** must also have every required monthly invoice in place
before it can be green. That measurement applies when all three of these hold:

- the subsidiary's `trackingGranularity` is `location`, **and**
- the category is Electricity, Natural Gas or Water, **and**
- the matrix is scoped to a single reporting year

Required invoices = `locations × 12` per category (see §DASH-3 in the round-1 feedback
for the worked example). A cell failing any one of the three is judged by the rules
above alone — which is most of the matrix rather than a rare edge, because a subsidiary
measured as a whole has no per-site denominator to count against. Any statement of this
rule as "the three utility categories are stricter" is wrong: the category is only one
of its three conditions.

### 2.3 Drill Down
Clicking a matrix cell must open a targeted drawer or route that passes:

- `organisationId`
- `subsidiaryId` where relevant
- `categoryKey`
- `reportingYear`
- `reportingPeriod`

This must allow users to inspect history or enter data directly into the relevant category workflow.

---

## 3. Emissions Calculation Logic

### 3.1 Real Time Preview
As users enter valid data in Data Entry, the UI must update the emissions preview in real time using the relevant conversion and factor rules.

### 3.2 Core Formula
Where applicable, use:

`kgCo2e = normalizedValue × factorValue`

`tCo2e = kgCo2e / 1000`

### 3.3 Regional Logic
The system must select factors based on the registered geography of the subsidiary or organisation, using the configured methodology source for:

- United Kingdom
- Turkey
- European Union

### 3.4 Input Normalisation
Inputs must be normalised to the correct calculation basis for the selected category before factor application.

Examples:
- natural gas may convert from `cubic_metres` to `kwh`
- electricity in `mwh` may convert to `kwh`
- travel and waste categories should use their own category relevant units without forced energy conversion

### 3.5 Factor Traceability
Each calculated result must store or display:
- factor identifier
- factor value
- factor unit
- methodology
- geography code
- conversion note if applied

---

## 4. Data Integrity and Audit Rules

### 4.1 Evidence Linking
For categories configured as evidence required, a record cannot reach complete status unless at least one supporting file is linked.

Examples of evidence may include:
- invoice
- receipt
- meter record
- fuel log
- waste note
- travel document
- uploaded spreadsheet

### 4.2 Period Locking
Once a reporting period is marked as closed by an authorised admin user, all records for that reporting period must become locked.

Locked records:
- cannot be edited by standard users
- cannot be deleted
- must require a formal revision workflow for any change

### 4.3 Revision Rule
Changes to locked records must create a revision entry with:
- mandatory comment
- user reference
- timestamp
- original value visibility

### 4.4 Anomaly Detection
Records with more than 50 percent variance from the rolling average of the
previous **3** comparable periods for the same reporting entity must be flagged.
Fewer than three priors carrying a figure means the record is **not evaluated**
rather than clean, and the surface must say so.

The normative rule — the full baseline key, the counted statuses that seed it,
and why the key deviates from the original specification — is
`validation_anomaly_rules.md` §4.1. This paragraph stated it a third and looser
way until 2026-08-27 ("the previous comparable period average", with no count
and no key), which is how three documents came to describe one rule differently.

When anomaly is detected:
- show warning
- require a Reason for Variance comment before submission
- store anomaly flag in record history

---

## 5. Reporting and Export

### 5.1 PDF Reporting
The system must support generation of a branded executive summary report showing:
- Scope 1 total
- Scope 2 total
- Scope 3 total
- category breakdown
- reporting period
- organisation identity
- methodology notes

### 5.2 CSV and Excel Export
The system must support export of emissions history and related records in CSV and Excel format for review, audit, and third party assurance.

### 5.3 Filter Aware Export
All export outputs must respect the filters currently applied in the UI, including:
- reportingYear
- reportingPeriod
- organisationId
- scope
- categoryKey
- status

### 5.4 Restatement Disclosure and Reporting Entity *(added WP20, 2026-08-23)*
Every generated artifact (PDF, Excel, CSV) must:
- **Disclose withdrawn figures.** A record withdrawn from the inventory
  (`voided` — the withdrawal path; note §6 below still documents only the six
  pre-WP18 workflow states and does not yet describe `voided`) counts towards no
  figure in a report, and the report must say so rather than omit it silently: the count, and per record the reporting entity,
  category, period, the tCO2e that left, when it was withdrawn and the reason
  recorded at the time. A restatement a reader cannot see is not a restatement
  (ISO 14064-1 §9.3.1 traceability).
- **Name the reporting entity of every ledger row** — the operational location
  the figure is attributed to, or the whole company. Uniqueness includes
  `location_id`, so without it two figures for one month are indistinguishable in
  the ledger an auditor keeps.

Withdrawn records are NEVER counted in a total. In the flat CSV, where they share
one table with the committed ledger, `status` is the authoritative discriminator
(`voided`), and **every column a reader could aggregate** — not only tCO2e —
carries a text marker on those rows, so summing any column of the export
reproduces the report's own figures. Activity quantity is itself a reported
datapoint (GRI 302-1, CSRD E1-5), so protecting the tCO2e column alone is not
enough. What was withdrawn is reported in the `voided_*` columns, where summing
answers a different question on purpose.

The disclosure obligation belongs to the **artifact**: a file leaves the system
and is read by someone who cannot click through to the record history. On-screen
aggregates state the exclusion structurally instead (`statusesIncluded`) — but a
screen that starts printing record COUNTS beside its totals inherits this rule.

**Export column contract.** Consumers must key on column NAMES: a new column may
be appended at any time. Column order changed once, at WP20 (`reporting_entity`
inserted as the second column of the CSV and of the Excel `Raw Activity Data`
sheet, and `Withdrawn Records` inserted as the third worksheet), which moves
every later column by one for anything reading by position. From WP20 onwards new
columns are **appended, never inserted**.

---

## 6. User Workflow States

### 6.1 Draft
- record is saved in draft state
- record is editable by authorised users
- record is not included in final reporting outputs

### 6.2 Submitted
- record has been submitted for review
- record becomes read only for the data entry user
- record appears in review and audit workflows

### 6.3 Under Review
- record is being reviewed
- record may be flagged, commented on, or returned

### 6.4 Approved
- record is accepted as final for the current open reporting cycle
- record is included in high level KPIs and reporting outputs

### 6.5 Rejected
- record is returned for correction
- rejection reason should be visible to the submitting user

### 6.6 Locked
- record belongs to a closed reporting period or has been explicitly locked
- no standard editing allowed
- changes require revision workflow