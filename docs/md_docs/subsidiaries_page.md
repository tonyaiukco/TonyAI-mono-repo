# Page Spec: Subsidiaries Management
**Route:** `/dashboard/subsidiaries`

## 1. Page Purpose
This page manages the organisational hierarchy and reporting entities within the platform.

It allows authorised users to:
- define subsidiaries and reporting entities
- assign entities to the correct geography for factor selection
- manage reporting boundaries
- view entity level reporting health
- assign user access to entities

---

## 2. Access Rules

### super_admin
- full access
- can add subsidiaries
- can edit entity settings
- can assign users
- can update geography and reporting boundary

### consultant
- read access
- may review entity details
- may comment or flag issues if that feature is enabled
- no structural edits by default

### data_entry
- read only list and detail access
- no create, edit, or delete

### executive_viewer
- read only access

---

## 3. Page Header

- **Title:** `Subsidiaries and Entities`
- **Description:** `Manage reporting boundaries and organisational structure.`

### Actions
- Primary Button: `Add New Subsidiary`
- Search Bar: `Search by name, sector, or ID`

---

## 4. Subsidiary Summary Cards

Use a top row of summary cards to show group reporting health.

### Suggested Cards
- Total Entities
- Active Reporting
- Regional Split

### Definitions
- **Total Entities:** count of active reporting entities
- **Active Reporting:** count of entities with one or more records in the selected reporting period
- **Regional Split:** grouped count by `geographyCode`, for example:
  - `UK: 2`
  - `TR: 1`
  - `EU: 2`

---

## 5. Subsidiary Master Table

Use a high density table with sorting and filtering.

| Column | Data Type | Logic / Detail |
| :--- | :--- | :--- |
| Entity Name | Text and icon | Trading name plus optional industry icon |
| Geography | Badge | `UK`, `TR`, or `EU` |
| Sector | Text | Example: Manufacturing, Logistics, Utilities |
| Reporting Progress | Progress Bar | percent of categories in `complete` status for the active period |
| Primary Contact | User reference | Assigned ESG or reporting contact |
| Last Activity | Timestamp | Date of last data entry, update, or evidence upload |
| Actions | Menu | View Dashboard, Edit Settings, Manage Users |

### Interaction
Clicking a row opens the Subsidiary Detail Side Drawer.

---

## 6. Subsidiary Detail Side Drawer

Triggered when a table row is clicked.

### 6.1 Profile Header
- Logo placeholder
- Trading name
- Legal name
- Registration ID

### 6.2 Geographic Configuration
This section is critical because it affects factor selection.

#### Field
- `geographyCode` dropdown
  - `UK`
  - `TR`
  - `EU`

#### Help Text
`This setting determines which configured factor set is used for geography dependent calculations such as purchased electricity.`

### 6.3 Reporting Boundary
Use checkbox controls for:
- Scope 1
- Scope 2
- Scope 3

### 6.4 Capacity and Context Fields
- Capacity Note
- Annual Output Capacity
- Total FTE
- Business Area

### 6.5 User Assignment Summary
Show:
- assigned data entry users
- assigned consultants
- primary contact

---

## 7. Add Subsidiary Modal

Use a multi step modal.

### Step 1: General Information
- Trading name
- Legal name
- Sector
- Registration ID
- Logo upload if supported

### Step 2: Geography Configuration
- select `geographyCode`
- show short note explaining factor relevance

### Step 3: User Assignment
- assign `data_entry` users
- assign primary contact
- optionally assign consultant visibility

### Step 4: Reporting Boundary
- select included scopes
- save entity

---

## 8. Functional UI States

### Empty State
`No subsidiaries found. Add your first reporting entity to begin.`

### Read Only State
For `data_entry` and `executive_viewer`:
- list view only
- drawer visible
- no edit controls
- no add subsidiary button

### Recalculation Alert
If a user changes `geographyCode`, show a warning modal:

`Warning: Changing the geography will change the configured factor basis for geography dependent calculations. This may require recalculation of affected Scope 2 records for selected reporting periods. Do you want to continue?`

### Save Success
Show toast:
`Subsidiary settings updated successfully.`

---

## 9. Notes for Development
- use `geographyCode` consistently
- do not silently overwrite historical calculations without confirmation
- reporting progress must respect current global filters
- subsidiary configuration affects downstream calculation behaviour, so this page should be treated as a governance page, not just a directory