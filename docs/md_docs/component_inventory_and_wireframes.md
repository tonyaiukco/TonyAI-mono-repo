# Component Inventory and Wireframes: TonyAI Enterprise
**Document ID:** `TONY-TECH-003`  
**Framework Target:** React, Tailwind CSS, Shadcn UI

## 1. Global Design System Foundations

### Grid
- 12 column responsive grid
- 24px gutters

### Spacing
- 4px spacing scale
- examples:
  - `p-4 = 16px`
  - `p-6 = 24px`

### Rounding
- `radius-md` for inputs: 8px
- `radius-lg` for cards: 12px

### Shadows
- `shadow-sm` for cards
- `shadow-lg` only for modals and drawers

---

## 2. Reusable Component Inventory

## 2.1 Navigation Shell
**Suggested path:** `/components/shell`

### Components
- `SidebarNavigation`
- `HeaderUtilityBar`
- `AppShell`

### Notes
- Sidebar uses Lucide icons
- Active states highlighted with subtle primary styling
- Header contains Breadcrumbs, OrganisationSwitcher, and ReportingPeriodSelector
- AppShell handles desktop and mobile layout shifts

---

## 2.2 Data Visualisation
**Suggested path:** `/components/charts`

### Components
- `EmissionsDonut`
  - donut chart for Scope 1, Scope 2, Scope 3 distribution
- `TrendAreaChart`
  - stacked area chart for month on month and year on year emissions
- `SubsidiaryMatrix`
  - custom CSS Grid component
  - sticky first column for subsidiary names

### SubsidiaryMatrix Props
- `completionStatus`
- `value`
- `unit`
- `onClick`

### completionStatus Values
- `complete`
- `incomplete`
- `missing`
- `not_applicable`

---

## 2.3 Form and Input Elements
**Suggested path:** `/components/forms`

### Components
- `CalculationCard`
  - right side preview component showing calculation logic
- `EvidenceUploader`
  - drag and drop uploader with file type validation
- `AnomalyWarning`
  - banner or card rendered when variance exceeds threshold
- `SmartSelect`
  - searchable combobox for subsidiaries, suppliers, or category driven selections

### Supported Evidence File Types
- PDF
- JPG
- PNG
- XLSX
- CSV

---

## 2.4 Status and Feedback
**Suggested path:** `/components/ui`

### Components
- `StatusBadge`
  - pill style status indicator
  - variants:
    - `draft`
    - `submitted`
    - `under_review`
    - `approved`
    - `rejected`
    - `locked`
- `DetailDrawer`
  - right side slide over for record details, history, and quick actions
- `LoadingSkeleton`
  - placeholder for cards and tables

---

## 3. Page Wireframe Specifications

## 3.1 Overview Dashboard Wireframe

### Header Section
- KPI ribbon with 4 to 6 cards

### Primary Section
- full width `SubsidiaryMatrix`

### Secondary Section
Two column layout:
- left: `Recent Submissions` table
- right: `Action Required` panel showing incomplete or missing items

---

## 3.2 Data Entry Workspace Wireframe

### Left Rail
- `CategoryAccordion`
- vertical list of configured categories

### Main View
- `EntryForm`
- focused input fields
- evidence uploader

### Right Rail
- `ContextPanel`
- contains:
  - `CalculationCard`
  - `HistorySparkline` showing previous 3 comparable values for the selected category

### Desktop Layout Ratio
- left rail: 1/4
- main view: 2/4
- right rail: 1/4

---

## 3.3 Emissions Analysis Wireframe

### Header
- tab switcher:
  - Summary
  - Breakdown
  - History
  - Trends

### Content
- Summary view:
  - donut chart
  - KPI cards
- History view:
  - full width data table
  - global search
  - sortable columns

---

## 4. Interaction Patterns

## 4.1 Matrix to Drawer Flow
1. user clicks an `incomplete` cell in `SubsidiaryMatrix`
2. `DetailDrawer` opens from the right
3. if user role is `data_entry`, drawer may show quick edit or jump to Data Entry
4. if user role is `super_admin`, drawer may show review actions such as approve or reject where applicable

## 4.2 Live Calculation Flow
1. user enters value in `ActivityValue`
2. `EntryForm` triggers state update
3. `CalculationCard` updates after a 300ms debounce
4. result update receives subtle visual emphasis

---

## 5. Responsive Behaviour

## Mobile
For screens below `768px`:
- sidebar collapses behind hamburger menu
- matrix becomes horizontally scrollable
- drawers use full width

## Ultra Wide
For screens above `1600px`:
- content is centered
- max width is enforced to protect readability