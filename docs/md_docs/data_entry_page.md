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
Calculated result differs by more than 50 percent from the rolling average of the previous 3 comparable periods for the same entity and category.

#### UI Behaviour
- right panel alert card border turns amber
- warning message becomes visible
- `Reason for Variance` field appears
- `Reason for Variance` becomes required before submit is enabled

---

## 8. Action Bar

Sticky action bar at the bottom of the page.

### Actions
- `Bulk Upload`
- `Save Draft`
- `Submit for Review`

### Behaviour
#### Bulk Upload
Opens modal for CSV or Excel ingestion workflow

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

## 9. Interaction States

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

## 10. Notes for Development
- This page is for creation and submission, not historical analysis
- Calculation preview must update in real time when enough valid data exists
- Category navigation and badge states must stay in sync with current record state
- Use `tCo2e`, `kgCo2e`, `categoryKey`, and `geographyCode` consistently
- Keep the right side intelligence panel visible on desktop because it is a core value feature