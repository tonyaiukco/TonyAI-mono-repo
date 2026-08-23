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
Records with more than 50 percent variance from the previous comparable period average must be flagged.

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