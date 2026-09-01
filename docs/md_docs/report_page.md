# Page Spec: Reports and Disclosures
**Route:** `/dashboard/report`

## 1. Page Purpose
The Report page is the output engine of the platform. It transforms calculated emissions data, subsidiary performance, and supplier related information into branded, review ready PDF and Excel disclosures aligned with selected reporting frameworks.

It should support:
- executive summary reporting
- detailed carbon disclosure output
- subsidiary comparison reporting
- supplier scorecard exports
- traceable report generation history

---

## 2. Layout and UI Structure

- **Top Section:** Report Configuration Bar
- **Center Section:** Live Report Preview Canvas
- **Bottom or Top Right Section:** Export and Distribution Actions

---

## 3. Component: Report Configuration Bar

**Layout:** Horizontal control bar with subtle border and clean spacing

| Control | Type | Options / Logic |
| :--- | :--- | :--- |
| Report Template | Dropdown | Executive Summary, GHG Protocol Detail, Subsidiary Comparison, Supplier ESG Scorecard |
| Organisation Scope | Multi-select | Individual subsidiaries or Total Portfolio |
| Timeframe | Dropdown | Use active global reporting period or choose custom range |
| Inclusion Options | Checkbox Group | Include Scope 3, Include Methodology Notes, Include Evidence Links |
| Generate | Button | Primary action that triggers Report Preview |

### Behaviour
- current filters should prefill from global context where relevant
- user can override report specific settings before generating
- clicking `Generate` refreshes the preview canvas

---

## 4. Component: Report Preview Canvas

**Layout:** Centered A4 style white preview container with shadow and document style typography

### 4.1 Header Section
- logo area for subsidiary or holding group
- report title
- reporting period
- organisation name
- report status badge

### Report Status Badge
Use one of:
- `Approved`
- `Draft`
- `Contains Incomplete Data`

Do not use external assurance language unless that functionality truly exists.

---

## 5. Executive Summary Section

### Main Metrics
- Total `tCo2e`
- year on year or baseline comparison delta
- Scope 1 total
- Scope 2 total
- Scope 3 total

### Visuals
- donut chart for scope split
- category bar chart for largest contributors

### Scope Table
- Scope 1: value in `tCo2e`
- Scope 2: value in `tCo2e`
- Scope 3: value in `tCo2e`

---

## 6. Detailed Breakdown Section

### Category Breakdown Table
Show category level emissions and related quality indicators.

Suggested columns:
- Category
- Scope
- Emissions
- Percent of Total
- Data Quality Score

### Data Quality Score Note
This metric may be based on configured logic such as:
- metered versus estimated data ratio
- evidence completeness
- record approval completeness

### Subsidiary Performance Section
Show a ranking table of most to least carbon intensive entities within the selected organisation scope.

Suggested columns:
- Subsidiary
- Total `tCo2e`
- Intensity Metric if available
- Data Quality Score
- Reporting Status

---

## 7. Methodology Appendix

### Contents
- factor source labels used in the selected report
- applied methodology names
- selected geography logic
- reporting boundary note
- disclaimer text

### Example Methodology Sources
- DEFRA
- Turkey National Factors
- AIB Residual Mix
- Organisation Custom Factors

---

## 8. Export and Action Logic

### Actions
- `Download PDF`
- `Export Excel`
- `Share Report`

### Download PDF
Generate styled PDF output from the active report preview.

### Export Excel
Generate multi sheet `.xlsx` output with suggested sheets:
- Summary
- Raw Activity Data
- Withdrawn Records *(added WP20 — always present, even when empty: a sheet list
  that depends on the data cannot be consumed by anything automated)*
- Factors Used

### Restatement disclosure *(added WP20, FR §5.4)*
Every format states what was withdrawn from the reporting year, because a
withdrawn figure counts towards nothing above it and an export that omitted it
silently would misstate the inventory by omission:
- **PDF** — a `Restatement:` banner under the metric tiles, and a
  `Withdrawn from this inventory` section listing each record with the reason.
- **Excel** — a `Withdrawn records (excluded from every figure below)` row on
  Summary, plus the sheet above.
- **CSV** — the withdrawn rows share the single table (one header row keeps the
  file parseable): `status` reads `voided` and is the authoritative
  discriminator, and every aggregatable cell on those rows (`tco2e`,
  `activity_value`, `evidence_files`, `anomaly_flag`) carries the `Withdrawn`
  marker so a SUM over any column still reproduces the report's own figures.
  The disclosure itself is in `voided_activity_value`, `voided_tco2e`,
  `voided_at_utc`, `void_reason` and `voided_by` — sixteen columns in all.
  The file also opens with a **UTF-8 BOM**, so a double-clicked export decodes
  as UTF-8 on Windows rather than through the ANSI codepage; without it every
  Turkish name in the file mojibakes. **Column POSITIONS are unchanged by the
  BOM, but the first column's NAME is not:** a parser that does not strip it
  reads the first header field as `\uFEFFsubsidiary`. Read the file as
  `utf-8-sig` (Python) or its equivalent if you key on the first column by name;
  every other column is unaffected.

**Who withdrew a figure is disclosed as the opaque `voided_by` UUID, never a
resolved name** (decision 2026-09-01). A report is a filed artifact that cannot
be recalled, so a natural person's name in one is a commitment the erasure and
report-redaction questions have not answered; the id satisfies ISO 14064-1
§9.3.1 for a verifier with system access without making it. The PDF carries it
as an eighth column of `Withdrawn from this inventory` rather than a line in the
note above the table, because the fact is per-row: with two withdrawals by two
people, a section-level note binds neither id to its row.

Every ledger row also names its **reporting entity** — the location, or
`Whole company` — in all three formats.

**Column order changed once, at WP20.** `reporting_entity` was inserted as the
second column of the CSV and of the Excel `Raw Activity Data` sheet, and
`Withdrawn Records` as the third worksheet — so anything reading those exports by
POSITION rather than by column name (a spreadsheet formula pinned to column G, a
worksheet index) reads a shifted column and can total the wrong thing silently.
Repoint such consumers once. From WP20 onwards new columns are **appended, never
inserted**.

### Share Report
Optional feature. Opens modal to share report link or report file with selected stakeholders or auditors.

---

## 9. Functional UI States

### Empty State
`Configure your report parameters above and click Generate to preview your disclosure.`

### Processing State
Show loading or pulse state on preview canvas with text such as:
`Aggregating selected categories and subsidiaries...`

### Data Warning State
If more than `15%` of included records are in `draft`, `incomplete`, or `missing` related status, show a persistent yellow warning banner:

`Warning: This report contains incomplete data and is not suitable for final reporting use.`

---

## 10. Audit Trail Integration

Every generated report should receive a unique `reportId`.

A report generation log entry must store:
- who generated the report
- when it was generated
- organisation scope used
- reporting period used
- selected template
- inclusion options
- export type if downloaded

This log should be visible in the Audit and Approvals area if that module is enabled.

---

## 11. Notes for Development
- keep preview and export aligned with current configuration
- use `tCo2e` consistently
- report output should reflect the current selected organisation scope and timeframe
- make the preview visually polished but still close to final export structure
- warning logic should be easy for users to understand before exporting