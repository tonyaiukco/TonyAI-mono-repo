# Page Spec: Emissions Analysis
**Route:** `/dashboard/emissions`

## 1. Page Purpose
The Emissions page is the main analysis workspace of the platform.

While the Overview page provides status visibility, the Emissions page provides deeper analysis for both executive users and audit focused users. It must support:
- high level emissions distribution
- category level breakdown
- historical ledger review
- time series trend analysis

---

## 2. Page Header and Global Filters

- **Title:** `Emissions Analytics`

### Primary Filters
- Scope Toggle  
  - `All Scopes`
  - `Scope 1`
  - `Scope 2`
  - `Scope 3`

- Category Multi Select  
  - Examples: `Purchased Electricity`, `Natural Gas`, `Business Travel`

- Data View Toggle  
  - `Absolute`
  - `Intensity`

### Intensity Note
If `Intensity` is selected, the denominator must come from organisation configured metrics such as:
- area
- revenue
- headcount
- production output

Only valid configured intensity metrics should be shown.

### Actions
- Primary Action: `Export Data`

### Export Logic
The export action must generate a file based only on:
- the currently active tab
- the current filter state
- the current organisation and reporting context

Supported export formats:
- Excel
- CSV

---

## 3. Internal Tab Navigation

The page is divided into four functional tabs:

- `Summary`
- `Breakdown`
- `History`
- `Trends`

Each tab must preserve the active global filters.

---

## 4. Tab 1: Summary

## Purpose
Provide a high level visual distribution of emissions across scopes and top contributors.

### Top Row Metrics
Display 3 metric cards:
- Total Scope 1
- Total Scope 2
- Total Scope 3

All values must be shown in `tCo2e`.

### Main Chart
- Donut Chart showing percentage split across Scope 1, Scope 2, and Scope 3

### Secondary Chart
- Bar Chart showing Top 5 Contributors
- Contributor basis can be:
  - subsidiaries
  - categories

The chart should clearly label which basis is being shown.

---

## 5. Tab 2: Breakdown

## Purpose
Provide detailed analysis of emissions by category and contribution.

### Primary Visualization
Use one of:
- Treemap
- Hierarchical Bar Chart

This should show category scale visually, for example:
- Purchased Electricity as the largest share
- Business Travel as a smaller share

### Supporting Table
**Table Title:** `Category Performance`

### Table Columns
- Category
- Scope
- Absolute Emissions
- Percent of Total
- Data Quality Score

### Data Quality Score Note
Data Quality Score should be based on configured logic such as:
- metered versus estimated data ratio
- evidence presence
- completeness status

This score does not need full final methodology in the prototype, but the UI must support displaying it.

### Interaction
Clicking a row should switch to the `History` tab with that category pre filtered.

---

## 6. Tab 3: History

## Purpose
This is the audit ledger and replaces the old standalone Data History page.

It must be a high density, filterable, audit friendly table.

### Search
Universal search bar supporting:
- invoice reference
- user
- note or comment
- category
- subsidiary

### Table Columns
- Timestamp
- Subsidiary
- Category
- Activity Value
- Unit
- Calculated `tCo2e`
- Status
- Evidence

### Status Badge Values
Use workflow badge values:
- `draft`
- `submitted`
- `under_review`
- `approved`
- `rejected`
- `locked`

Optional additional visual badge:
- `anomaly_flagged`

### Evidence Column
Use icon or count to indicate linked evidence files such as:
- PDF
- image
- spreadsheet

### Row Interaction
Clicking a row must open the Audit Detail Drawer.

### Audit Detail Drawer Content
Show:
- factor used
- methodology
- geographyCode
- entered by user
- createdAt timestamp
- updatedAt timestamp
- Reason for Variance comment if applicable
- linked evidence files
- audit trail summary

---

## 7. Tab 4: Trends

## Purpose
Show time series movement in emissions and performance versus baseline or target.

### Main Chart
- Stacked Area Chart or Stacked Bar Chart
- Supports:
  - month over month
  - quarter over quarter
  - year over year

### Comparison Logic
Allow optional overlay of:
- Science Based Target
- previous year baseline
- internal reduction target

Only show overlays if target or baseline data exists.

### Insight Card
Display summary insight such as:
`Year to Date Change: -4.2% vs. 2025`

### Color Logic
- decrease: green
- increase: red
- neutral or no change: muted gray

---

## 8. Functional UI Logic

### Empty State
If no data exists for the current filters, show:

`No emissions records found for this period. Start by adding data in the Data Entry tab.`

### Loading State
- skeleton metric cards
- skeleton chart containers
- skeleton table rows

### No Permission State
Show:
`You do not have permission to view emissions data for this organisation.`

### Filter Preservation Rule
Switching tabs must preserve:
- activeOrganisationId
- reportingYear
- reportingPeriod
- scope
- category filters
- data view mode

---

## 9. Notes for Development
- This page is for analysis, not direct data creation
- The `History` tab replaces the old standalone data history page
- Use `tCo2e` consistently across all summaries and tables
- Keep charts readable and uncluttered
- Prioritise audit visibility and filter clarity
- Export must always match the active tab and active filters