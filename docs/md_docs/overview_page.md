# Page Spec: Overview
**Route:** `/dashboard/overview`

## 1. Page Purpose
The Overview page is the main dashboard for high level carbon reporting visibility. It provides summary KPIs, a subsidiary level tracking matrix, quick drill down into category level detail, and a view of recent submissions and urgent alerts.

---

## 2. Page Header

- **Title:** `Carbon Dashboard`

### Context Bar
- Year Dropdown  
  - Default: current `reportingYear`
- Period Dropdown  
  - Default: `all_year`
- Organisation Switcher  
  - Default: `All Organisations`
- Secondary Button: `Export Overview`

### Header Behaviour
Changing the year, reporting period, or organisation must refresh:
- KPI summary cards
- Subsidiary Tracking Matrix
- Recent Submissions
- Urgent Alerts

The `Export Overview` button should export the currently filtered dashboard summary.

---

## 3. KPI Summary Grid

**Layout:**  
- Desktop: `3 columns x 2 rows`
- Tablet: `2 columns`
- Mobile: `1 column`

| Card ID | Label | Logic / Data Point | Icon |
| :--- | :--- | :--- | :--- |
| KPI-01 | Total Subsidiaries | Count of active `subsidiaryId` values in scope | Building2 |
| KPI-02 | Complete Categories | Count of matrix cells where `completionStatus === 'complete'` | CheckCircle |
| KPI-03 | Incomplete Categories | Count of matrix cells where `completionStatus === 'incomplete'` | AlertCircle |
| KPI-04 | Missing Categories | Count of matrix cells where `completionStatus === 'missing'` | XCircle |
| KPI-05 | Total Emissions | Sum of all `tCo2e` for the selected filters | Factory |
| KPI-06 | Calculation Rate | `(complete / (complete + incomplete + missing)) * 100` | TrendingUp |

### KPI Notes
- `not_applicable` cells must be excluded from the Calculation Rate denominator
- KPI values must respect all active filters

---

## 4. Subsidiary Tracking Matrix

The Tracking Matrix is the central component of the Overview page.

### Header Row
`Subsidiary Name | Elec | Gas | Fuel | Mobile | Refrig | Goods | Waste | Water | Travel | Commute | Logist`

### Row Content
- **Column 1:** Subsidiary abbreviation plus sector label
- **Data Cells:** category completion and quick emissions status for each subsidiary

### Matrix Cell States

#### Complete
- Visual style: green
- Content: short value display such as `19K` or `2.16 tCo2e`
- Icon: small calculator icon

#### Incomplete
- Visual style: yellow
- Content: `Incomplete`
- Icon: amber alert icon

#### Missing
- Visual style: red
- Content: `No Data`
- Icon: red X icon

#### Not Applicable
- Visual style: muted gray
- Content: `—`

### Interaction Rules
- Hover: subtle lift effect and tooltip
- Tooltip text: `Click to view [Category] details for [Subsidiary]`
- Click: open Detail Side Drawer

### Responsive Rule
On smaller screens, the matrix must become horizontally scrollable.

---

## 5. Side Drawer: Category Detail

Triggered when a matrix cell is clicked.

### Drawer Header
`[Category Name] – [Subsidiary Name]`

### Quick Stats
- Current Value: `X.XX tCo2e`
- Status: `draft`, `submitted`, `under_review`, `approved`, or `locked`
- Evidence Count
- Last Updated date

### Actions
- Primary Button: `Go to Data Entry`
- Secondary Button: `View Audit History`

### Preview Area
- small sparkline showing the last 3 comparable periods for the selected category
- optional short text note for anomaly or missing evidence status

### Drawer Behaviour
- `Go to Data Entry` opens the relevant category workflow with:
  - `organisationId`
  - `subsidiaryId`
  - `categoryKey`
  - `reportingYear`
  - `reportingPeriod`
- `View Audit History` opens the relevant filtered record view in Emissions > History

---

## 6. Recent Activity and Alerts

### Layout
- Left section: `2/3 width`
- Right section: `1/3 width`

### Left Panel: Recent Submissions
Display the latest 5 submitted or updated records.

#### Suggested Columns
- Timestamp
- Subsidiary
- Category
- Activity Value
- Unit
- Status

### Right Panel: Urgent Alerts
Display urgent issues such as:
- overdue data entry
- missing evidence
- anomaly flagged record
- incomplete category for current period

#### Example Alert
`ECA electricity data overdue by 4 days`

---

## 7. Page States

### Loading
- skeleton KPI cards
- skeleton matrix rows
- skeleton recent activity table

### Empty
Show message:
`No overview data available for the selected reporting period.`

### No Permission
Show message:
`You do not have access to this organisation.`

### Populated
Show all KPI cards, matrix, recent activity, and alerts

---

## 8. Notes for Development
- Use `completionStatus` for matrix logic, not color words as stored values
- Use `tCo2e` consistently
- Exclude `not_applicable` cells from completion rate calculations
- Ensure all widgets respond to global filters
- Keep the matrix as the visual focal point of the page