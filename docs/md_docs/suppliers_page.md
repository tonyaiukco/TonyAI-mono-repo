# Page Spec: Supplier Management
**Route:** `/dashboard/suppliers`

## 1. Page Purpose
This page acts as the central supplier database for value chain and Scope 3 related intelligence.

It allows users to:
- register and manage supplier records
- review supplier sustainability metadata
- track supplier climate targets and ESG related scores
- support procurement decisions
- provide supplier level inputs for future Scope 3 calculation logic

---

## 2. Access Rules

### super_admin
- full create, read, update, delete access

### consultant
- read access
- can edit supplier sustainability metadata if enabled
- cannot delete suppliers by default

### data_entry
- read only access

### executive_viewer
- read only access

---

## 3. Page Header

- **Title:** `Supplier Network`
- **Description:** `Monitor and manage value chain sustainability performance.`

### Actions
- Primary Button: `Add Supplier`
- Secondary Button: `Import Supplier List`
- Search Bar: `Filter by company, sector, or SBTi status`

### Import Logic
The `Import Supplier List` action should support CSV and Excel upload.

---

## 4. Supplier KPI Ribbon

Use a top row KPI ribbon to summarise supplier network health.

### Suggested KPIs
- Total Suppliers
- SBTi Aligned
- Average ESG Score
- Top Risk Sector

### Definitions
- **Total Suppliers:** count of supplier records in the current organisation scope
- **SBTi Aligned:** percentage of suppliers with `Committed`, `Near-term Target`, or `Net-zero` status
- **Average ESG Score:** average supplier ESG score shown on a 0 to 100 scale
- **Top Risk Sector:** sector with the highest configured average supplier risk score

---

## 5. Supplier Master Table

Use a high density table with strong filtering and sorting support.

| Column | Data Type | Detail / Logic |
| :--- | :--- | :--- |
| Company Name | Text and logo | Supplier brand name and legal entity name |
| Country | Badge or text | Country of headquarters or primary operations |
| Sector | Text | Industry classification |
| ESG Score | Status tag | 0 to 100, color coded |
| SBTi Status | Badge | `None`, `Committed`, `Near-term Target`, `Net-zero` |
| Net-zero Year | Year | Target year where available |
| Contact Person | Text or link | Key supplier or ESG contact |
| Actions | Icon menu | View Details, Edit, Delete |

### ESG Score Color Rules
- `80 and above` = green
- `50 to 79` = amber
- `below 50` = red

### Table Interaction
Clicking a row opens the Supplier Detail Side Drawer.

---

## 6. Supplier Detail Side Drawer

Triggered when a supplier row is clicked.

### 6.1 Supplier Profile
- company logo
- supplier name
- website link
- country
- sector

### 6.2 Sustainability Summary
A short text block showing:
- current climate strategy summary
- target status summary
- optional internal notes

### 6.3 Target Tracking
Display:
- Near-term Target
- Net-zero Target
- CDP Water Score
- CDP Climate Score
- ESG Score
- explanation or notes

### 6.4 Data Integration Section
If supplier specific emissions data is available, display it here.

Suggested fields:
- supplier reported emissions value
- reporting year
- methodology note
- source note

### Integration Note
Direct supplier emissions data may be used as a preferred input over spend based estimates where configured by the calculation logic.

---

## 7. Add or Edit Supplier Modal

Use a structured modal with grouped form sections.

### General Section
- Company Name
- Legal Name
- Sector
- Country
- Website

### Climate Status Section
- SBTi Alignment
- Near-term Target Year
- Net-zero Status
- Net-zero Year
- ESG Score
- explanation

### Contact Section
- Contact Name
- Contact Email
- Contact Phone

### Optional Disclosure Section
- CDP Water Score
- CDP Climate Score
- supplier reported emissions
- reporting note

---

## 8. Functional UI States

### Empty State
`No suppliers registered. Add your first supplier or upload a bulk list to begin tracking Scope 3 performance.`

### Filtering Logic
Users should be able to filter by:
- SBTi Status
- sector
- country
- ESG Score range
- Net-zero Status

### Badge Update Logic
If a supplier record is updated to `Net-zero`, the status badge should refresh immediately using the correct green styling.

### Read Only State
For `data_entry` and `executive_viewer`:
- table and drawer visible
- no add supplier button
- no edit or delete actions

---

## 9. Notes for Development
- supplier sustainability data is stored metadata unless live integration is later added
- keep filtering fast and table dense
- support import from CSV and Excel
- supplier level data should be organisation scoped
- this page should support future Scope 3 enhancement without forcing full calculation logic into the current prototype