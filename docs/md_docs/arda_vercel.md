Create a modern, professional, executive-level web dashboard for a large holding company to track carbon calculation progress across its subsidiaries.

The dashboard is for sustainability and carbon accounting management. It should look clean, premium, data-driven, and suitable for corporate use. The design language should feel like a high-end enterprise SaaS product. Use a responsive layout and build it with reusable components.

Core purpose:
The dashboard will monitor whether required emissions/activity data has been submitted by each subsidiary under different categories, and whether carbon calculations have been completed.

Main logic:
Each card / status box represents a data category for a company.
Use traffic-light style status colors:

- Green = data fully submitted and complete
- Yellow = data submitted but incomplete / missing some fields
- Red = no data submitted

If the data has been submitted and the carbon calculation is complete, also display the calculated value inside the same box.

Dashboard structure:

- A top header with dashboard title, reporting year selector, holding/company filter, and export button
- A left sidebar navigation
- Main content area with summary KPI cards
- A grid-based status tracking section for subsidiaries and categories
- A detailed table below for deeper review

Suggested KPI summary cards:

- Total subsidiaries
- Completed data categories
- Incomplete data categories
- Missing data categories
- Total calculated emissions
- Calculation completion rate %

Main dashboard sections:

1. Overview
2. Subsidiary tracking matrix
3. Category-based completion tracking
4. Emissions summary
5. Alerts / action-needed section

Subsidiary tracking matrix requirements:

- Rows = subsidiaries
- Columns = emission / data categories
- Each cell should be a status card or colored indicator
- On hover or click, show more detail:
  - data status
  - last update date
  - responsible department
  - whether calculation is completed
  - calculated emission value, if available

Example categories:

- Electricity consumption
- Natural gas consumption
- Fuel consumption
- Mobile combustion
- Refrigerant leakage
- Purchased goods / materials
- Waste
- Water
- Business travel
- Employee commuting
- Logistics / transportation

Status card behavior:

- Red card: show "No Data"
- Yellow card: show "Incomplete Data"
- Green card: show "Complete"
- If calculation completed, also show:
  - CO2e value
  - small label: "Calculated"
- Add tooltips and legend for status meanings

Design requirements:

- Corporate, minimal, modern UI
- Soft shadows, rounded cards, clean spacing
- Strong information hierarchy
- Use professional typography
- Make the color coding easy to scan
- Avoid overly decorative visuals
- Prioritize usability and readability
- Include subtle icons where helpful

Interactions:

- Filters for reporting year, company, category, and status
- Search for subsidiary name
- Click a subsidiary to open a detailed side panel or modal
- Sorting and filtering in the table
- Hover states on cards
- Progress bars for completion percentages

Detailed subsidiary panel:
When clicking a subsidiary, open a detailed view showing:

- Company name
- Overall completion %
- Category-by-category submission status
- Calculated emissions by category
- Missing data points
- Responsible team/person
- Last update timestamps
- Notes/comments area

Data visualization ideas:

- Completion donut chart
- Emissions by subsidiary bar chart
- Status distribution chart
- Trend chart for total emissions by reporting year

Technical / UI expectations:

- Use React with a clean component architecture
- Use Tailwind CSS
- Use a modern component library style similar to shadcn/ui
- Make the dashboard responsive for desktop first, then tablet
- Use realistic sample data
- Include empty states, hover states, and loading states
- Build with modular reusable components

Tone of the interface:
Professional, strategic, trustworthy, sustainability-focused, suitable for C-level and group reporting teams.

Add sample subsidiaries such as:

- Energy Company A
- Gas Distribution Company B
- Manufacturing Company C
- Logistics Company D
- Trading Company E

Also add realistic sample carbon values in tCO2e where calculations are complete.

Make the final result look like a premium carbon management dashboard for a holding structure.
[6:36 PM]Build a modern enterprise sustainability web application called TonyAI.

This is a multi-user sustainability data management platform for holding companies and their subsidiaries. The platform is used to track ESG and carbon-related data collection, monitor data completeness, and display calculated values when available.

The first page should be the main dashboard.

Core product context:

- This is a professional B2B web platform, not a consumer app
- It must support multiple user roles:
  1. Consultant
  2. Super Admin
  3. Standard User
- The interface should adapt to the user role, but keep the same design language across all roles
- The dashboard should help users immediately understand data collection progress, missing data, and available calculated values

Main dashboard purpose:
The main dashboard is used to monitor sustainability data collection and carbon calculation readiness across a holding structure.

Hierarchy:
Holding > Subsidiary > Facility or Location > Data Category

Main data categories may include:

- Electricity
- Fuel
- Energy
- Water
- Waste
- Logistics
- Business Travel
- Refrigerants
- Raw Materials
- Packaging
- Employee Commute
- Purchased Goods and Services

Main dashboard requirements:

1. Show high-level KPI cards at the top:

- Total subsidiaries
- Total locations
- Categories completed
- Categories partially completed
- Categories missing
- Categories with calculated values
- Latest reporting period

1. Show a matrix/grid-based data status section:

- Rows can represent subsidiaries or locations
- Columns can represent data categories
- Each cell should visually show the data status using colors:
  - Green = data complete
  - Yellow = data partially complete
  - Red = no data submitted
- If a calculated value is available, display the calculated emissions or metric value inside the same cell
- Each cell should feel informative, compact, and easy to scan

1. Include filters:

- Reporting year
- Reporting month or quarter
- Subsidiary
- Location
- Data category
- Status
- User responsibility

1. Include a role-aware experience:

- Consultant sees cross-company overview and bottlenecks
- Super Admin sees global system overview and management controls
- Standard User sees only their own assigned entities and categories

1. Add drill-down interaction:

- Clicking a status cell should open a side panel or modal
- The detail view should show:
  - category name
  - entity name
  - reporting period
  - data completeness status
  - calculated value if available
  - missing required fields
  - uploaded files or evidence
  - last update date
  - responsible user
  - validation status

1. Add a section for operational insights:

- show missing data hotspots
- show delayed submissions
- show categories ready for calculation
- show entities with the highest completion rate
- keep this insight area clean and executive-friendly

Design style:

- Premium enterprise SaaS interface
- Minimal, sharp, clean, modern
- Inspired by Vercel, Stripe, Linear, Notion, and modern admin dashboards
- Use soft borders, spacious layout, subtle depth, clean typography
- Use color only where useful and meaningful
- The red-yellow-green system must be visually central because it is the main logic of the dashboard

UI behavior:

- Use cards, tables, matrix views, and modern filter bars
- Avoid cluttered charts
- Prefer clarity over decoration
- The dashboard should feel operational and actionable, not just analytical

Important:

- The system should feel like a sustainability operations platform
- It should be scalable for many subsidiaries and many categories
- It should support enterprise complexity without looking overwhelming

Use realistic placeholder data and build the page as a polished frontend concept for a real software product.
[6:36 PM]Build a professional data entry page for TonyAI, an enterprise sustainability data management platform.

This page is the data input interface used by standard users, consultants, and super admins depending on permissions.

Purpose:
The page should make sustainability data submission simple, structured, and reliable for different user types. It should help users enter required data for carbon accounting and ESG reporting while clearly showing completion status.

User roles:

- Standard User: enters and updates assigned data only
- Consultant: reviews submissions, detects missing fields, supports clients
- Super Admin: manages data structure, validates submissions, oversees all entries

Core concept:
The page should not feel like a generic form. It should feel like a smart operational workspace for sustainability data collection.

Data entry structure:

- Select reporting year
- Select reporting period (month / quarter / annual)
- Select company / subsidiary
- Select location / facility
- Select data category

Example categories:

- Electricity
- Fuel
- Water
- Waste
- Logistics
- Business Travel
- Refrigerants
- Packaging
- Raw Materials

Main UI requirements:

1. Top header area should show:

- selected reporting period
- selected entity
- selected category
- current completion status
- responsible user
- last saved date

1. Main form section:

- dynamic input fields based on selected category
- support numeric fields, dropdowns, file upload fields, text explanations, date fields
- allow supporting document upload such as invoices, utility bills, fuel records, transport data, etc.
- fields should be grouped logically and clearly labeled

1. Status logic:

- Green = all required fields completed and validated
- Yellow = some required fields missing or partially filled
- Red = no usable data entered
- The status should update visually as the user fills in the form

1. Calculation preview:

- If enough data is entered for a calculation, show a preview card with calculated value
- Example:
  - activity data
  - emission factor
  - estimated emissions result
- This preview should be visible but secondary to the data entry process

1. Validation and guidance:

- clearly mark required fields
- show missing field warnings
- show inconsistent data alerts
- allow inline guidance text or helper text for complex fields
- show success feedback when data is saved

1. Workflow features:

- Save draft
- Submit for review
- Mark as completed
- Return for revision
- View previous submissions
- View version history or audit trail
- Show comment thread or reviewer notes if possible

1. Role-aware behavior:

- Standard User can edit only their assigned forms
- Consultant can review multiple entities and identify gaps
- Super Admin can override, validate, edit structures, and monitor all submissions

1. Layout:

- Left side can contain navigation or category list
- Main center area should contain the form
- Right side can contain status summary, completeness meter, and calculation preview
- Alternatively use tabs if cleaner

Design style:

- Clean, professional, premium web app
- Modern enterprise form design
- Similar quality level to high-end SaaS products
- Clear hierarchy, strong whitespace, elegant spacing
- Avoid heavy visual noise
- The page should feel trustworthy, structured, and efficient

Additional expectation:

- Make the interface intuitive for non-technical business users
- Support large enterprise workflows
- Keep the design scalable for many categories and many subsidiaries
- The page should feel like a product used in real corporate sustainability reporting operations

Use realistic sample labels, field names, and placeholder values to make the page feel credible and production-ready.
[6:39 PM]Improve and extend an existing enterprise sustainability dashboard called "TonyAI".

The current UI already includes:

- Dark theme
- Left sidebar navigation
- Top KPI cards (Scope 1, Scope 2, Scope 3, Total)
- Data collection status bar
- Matrix-style data table

Your task is to refine, enhance, and make this dashboard more operational, scalable, and enterprise-ready.

--------------------------------------------------

1) TOP KPI CARDS (KEEP + ENHANCE)

--------------------------------------------------

Existing cards:

- Scope 1 Emissions
- Scope 2 Emissions
- Scope 3 Emissions
- Total Emissions

Enhancements required:

- Keep current layout and style
- Improve hierarchy and readability
- Add:
  - small subtitle (e.g. "Direct emissions", "Purchased energy")
  - trend indicator (percentage change vs previous period)
  - subtle icon or visual cue per scope

- Make "Total Emissions" more prominent:
  - slightly larger
  - visually highlighted (but not using red/yellow/green)

- Add optional drill-down:
  - clicking a card opens breakdown (by category or subsidiary)

--------------------------------------------------
1) DATA COLLECTION STATUS BAR (UPGRADE)

--------------------------------------------------

Current structure is good:

- Complete (green)
- Partial (yellow)
- Missing (red)

Enhancements:

- Add percentage labels above or inside bar
- Add tooltip on hover:
  - explain what "complete", "partial", "missing" means
- Add "calculation readiness":
  - e.g. "27% ready for emissions calculation"

- Make this section feel more actionable:
  - add small alert text if missing data is high

--------------------------------------------------
1) DATA MATRIX (CRITICAL AREA – IMPROVE)

--------------------------------------------------

Current structure:
Subsidiary rows + category columns (ELEC, GAS, FUEL, etc.)

Enhancements:

Each cell must contain:

- status color (green/yellow/red)
- if available:
  - calculated value (e.g. 12.8k tCO2e)
- optional:
  - small dot or icon for quick status

Add the following improvements:

1. Hover interaction:

- Show tooltip with:
  - full category name
  - last update date
  - responsible user
  - completeness % (if possible)

1. Click interaction:

- Open right-side panel with:
  - missing data fields
  - uploaded documents
  - calculation status
  - emission result
  - comments / notes

1. Column grouping:

- Group categories by Scope:
  - Scope 1 (fuel, refrigerants, etc.)
  - Scope 2 (electricity)
  - Scope 3 (travel, logistics, goods, etc.)

1. Add row summary:

- At end of each row show:
  - completion %
  - total emissions for that subsidiary

--------------------------------------------------
1) FILTER BAR (REFINE)

--------------------------------------------------

Existing filters:

- Year
- Period
- Subsidiaries
- Status

Enhancements:

- Improve spacing and alignment
- Add:
  - Location filter
  - Data category filter
  - Responsible user filter

- Add "quick filters":
  - "Show only missing data"
  - "Show calculation-ready entities"

--------------------------------------------------
1) INSIGHTS / ALERTS PANEL (ADD NEW SECTION)

--------------------------------------------------

Add a new section under KPI cards:

Examples:

- "5 subsidiaries have missing electricity data"
- "Scope 2 is 80% complete, ready for calculation"
- "Company X has the highest completion rate"
- "Logistics data is incomplete in 60% of entities"

Design:

- clean cards or list
- no heavy visuals
- very concise, action-oriented

--------------------------------------------------
1) ROLE-BASED VIEW (IMPORTANT)

--------------------------------------------------

Make UI adaptive:

Standard User:

- sees only assigned subsidiary
- limited categories
- simplified matrix

Consultant:

- sees all companies
- can compare performance
- focus on gaps

Super Admin:

- full system visibility
- access to all filters and controls

--------------------------------------------------
1) LEFT SIDEBAR (KEEP + SLIGHT IMPROVE)

--------------------------------------------------

Existing:

- Overview
- Data Entry
- Subsidiaries
- Emissions
- Alerts
- Reports

Enhancements:

- Add icons consistency
- Add active state highlight
- Add subtle hover animation

--------------------------------------------------
1) DESIGN RULES (STRICT)

--------------------------------------------------

- Use red, yellow, green ONLY for data status
- Do NOT use these colors for emissions KPIs
- Keep dark theme
- Use soft borders, modern spacing
- Avoid clutter and unnecessary charts

--------------------------------------------------
1) UX GOAL

--------------------------------------------------

The dashboard must answer instantly:

- Where is data missing?
- Which companies are ready for calculation?
- What is the total carbon footprint?
- Where are the bottlenecks?

This is not just a visual dashboard.
It must feel like an operational sustainability management tool.

--------------------------------------------------
1) OUTPUT EXPECTATION

--------------------------------------------------

- Keep current layout but significantly improve usability
- Make it feel like a real SaaS product used by large enterprises
- Use realistic placeholder data (tCO2e values, percentages, etc.)
- Ensure everything is clean, readable, and actionable[6:39 PM]# TonyAI - Frontend & UX Requirements Prompt

**Project Overview:** TonyAI is an enterprise-level SaaS dashboard designed to calculate Scope 1-2-3 carbon emissions and manage data governance across a multi-company architecture (holding level). The design language should be professional, data-centric, and clean. Please use modern UI libraries like **Shadcn UI**, **Tremor** (for charts), and **Tailwind CSS**.

## 1. App Layout (Main Structure)

The application should feature a responsive layout with a Sidebar (Navigation) on the left and a Main Content Area on the right.
- **Sidebar Menu Items:**
  *Dashboard (Executive Summary & Matrix)
  * Data Entry (Smart Input Forms)
  *Facilities & Companies (Location Management)
  * Reports & Export (Data Export)
  * Settings (Emission Factors & Constants)

## 2. Core Feature: Data Governance Matrix

The centerpiece of the Dashboard. This allows the Sustainability Manager to see missing/completed data at a glance.
- **UI Component:** A Data Grid or Heatmap.
- **Rows (Y-Axis):** Companies and Locations (e.g., Enerya - Konya, Ahlatci Gold Refinery).
- **Columns (X-Axis):** Emission Categories (Electricity, Natural Gas, Water, Vehicles, F-Gases).
- **Cell Status Indicators (Badges/Icons):**
  ***Completed (Green):** Data entered and calculated.
  * **Missing (Red):** Billing period closed, but no data entered.
  ***Pending/Draft (Yellow):** Data entered but awaits approval.
  * *Interaction:* Hovering over a "Completed" cell should display a Tooltip showing the raw entered data (e.g., "15,000 kWh").

## 3. Smart Data Entry Forms (Conditional UX)

Forms must guide the user to prevent data entry errors.
- **Scope 2 (Electricity) Form:**
  *Input 1: Total Consumption (Number) -> Dropdown: Unit (Default: kWh).
  * Toggle Switch: "Do you have Green Energy Certificates (I-REC/YEK-G)?"
  * *Conditional:* If Toggle is ON, reveal a new input: "Certified Amount (kWh)".
- **Scope 1 (F-Gases/Refrigerants) Form:**
  *Dropdown: Gas Type (R134A, R410A, etc.)
  * Radio Group: [ Capacity Declaration Only | Equipment was Refilled ]
  * *Conditional:* If "Refilled" is selected, show an input for "Refill Amount (kg)". Otherwise, only ask for "Equipment Capacity".
- **Data Validation Warning:** If a user enters an unusually high number (e.g., 500% higher than the historical average), trigger a warning Toast Notification: "Are you sure? This value is significantly higher than previous months."

## 4. Executive KPI Widgets (Top Row of Dashboard)

Place these cards and charts above the Data Governance Matrix.
- **KPI Number Cards:**
  *Total Holding Emissions (tCO2e)
  * Month-over-Month (MoM) Change Percentage (with trend arrows)
  * Top Emitting Company (Leaderboard #1)
- **Charts (Use Tremor or Recharts):**
  **Donut Chart:* Distribution of emissions by Scope (Scope 1 vs Scope 2 vs Scope 3).
  * *Bar Chart:* Total emissions comparison across different subsidiary companies.

## 5. Color Palette & Theme

* **Vibe:** Corporate, Trustworthy, Sustainable.
- **Primary Color:** Forest Green (e.g., Tailwind `emerald-700` or `green-800`).
- **Text/Headers:** Navy Blue or Dark Slate Gray.
- **Background:** White with very light gray panels (`gray-50`) for contrast.
- **Status Colors:** Soft green (Success), Soft red (Danger), Amber/Orange (Warning).[6:40 PM]Build a modern enterprise sustainability dashboard web application called "TonyAI".

TonyAI is a multi-user sustainability data management and carbon tracking platform designed for holding companies, consultants, and corporate sustainability teams.

The dashboard is the main page of the platform and must provide both:

1) Data collection status visibility
2) Carbon emissions overview (Scope 1, Scope 2, Scope 3)

User roles:

- Consultant (cross-company visibility and insights)
- Super Admin (full system control)
- Standard User (limited to assigned entities and categories)

Hierarchy:
Holding > Subsidiary > Location > Data Category

Main dashboard purpose:
Enable users to instantly understand:

- which data is missing or incomplete
- which entities are ready for calculation
- what the current emissions footprint looks like

--------------------------------------------------

1) TOP KPI SECTION (VERY IMPORTANT)

--------------------------------------------------

At the top of the dashboard, create a set of prominent KPI cards:

Data KPIs:

- Total Subsidiaries
- Total Locations
- Completed Categories (Green)
- Incomplete Categories (Yellow)
- Missing Categories (Red)

Emissions KPIs (CRITICAL ADDITION):

- Scope 1 Emissions
- Scope 2 Emissions
- Scope 3 Emissions
- Total Emissions

Requirements for emissions KPI cards:

- Show total emissions values (e.g. tCO2e)
- Use clear labels: Scope 1, Scope 2, Scope 3, Total
- Include small trend indicator or delta if possible
- Visually differentiate them slightly but keep consistent design
- These cards should feel executive-level and highly visible

--------------------------------------------------
1) DATA STATUS MATRIX

--------------------------------------------------

Create a grid or matrix layout showing data completeness:

- Rows: Subsidiaries or Locations
- Columns: Data Categories

Example categories:
Electricity, Fuel, Energy, Water, Waste, Logistics, Business Travel, Refrigerants, Raw Materials, Packaging, Employee Commute, Purchased Goods

Each cell must:

- Use strict color logic:
  - Green = data complete
  - Yellow = partially complete
  - Red = no data
- Display calculated value inside the same cell if available (e.g. emissions or activity data)
- Show compact but informative structure:
  - category name (optional)
  - status color
  - calculated value (if exists)
  - last update date (optional)

The matrix should be highly scannable and optimized for fast decision making.

--------------------------------------------------
1) FILTERS AND CONTROLS

--------------------------------------------------

Include a clean filter bar:

- Reporting year
- Reporting period (month / quarter)
- Subsidiary
- Location
- Data category
- Status (green/yellow/red)
- Responsible user

Filters should dynamically update both KPI cards and the matrix.

--------------------------------------------------
1) DRILL-DOWN INTERACTION

--------------------------------------------------

Clicking any matrix cell should open a detail panel or modal:

Detail view should include:

- Entity (company/location)
- Data category
- Reporting period
- Data completeness status
- Calculated value (if available)
- Missing required fields
- Uploaded documents / evidence
- Last update date
- Responsible person
- Validation or approval status

--------------------------------------------------
1) INSIGHTS / ALERTS SECTION

--------------------------------------------------

Add a clean insights section to support decision making:

Examples:

- "5 subsidiaries have missing electricity data"
- "3 locations are ready for Scope 2 calculation"
- "Logistics data is incomplete in 60% of entities"
- "Highest completion rate: Company X"

Keep this section minimal, executive-friendly, and actionable.

--------------------------------------------------
1) ROLE-AWARE EXPERIENCE

--------------------------------------------------

- Consultant:
  - Sees all entities
  - Focus on gaps and cross-company comparison

- Super Admin:
  - Full overview + system-level visibility

- Standard User:
  - Only sees assigned subsidiaries, locations, and categories

--------------------------------------------------
1) DESIGN SYSTEM

--------------------------------------------------

- Premium enterprise SaaS design
- Inspired by Vercel, Stripe, Linear, Notion
- Minimal, structured, clean
- Use whitespace and grid layout
- Avoid clutter and unnecessary charts

Color usage:

- Use red, yellow, green ONLY for data status
- Keep emissions cards neutral but slightly highlighted

--------------------------------------------------
1) UX PRINCIPLES

--------------------------------------------------

- The dashboard must feel operational, not decorative
- Prioritize clarity and speed of understanding
- Make it easy to identify bottlenecks instantly
- Combine data tracking + emissions visibility in one screen

--------------------------------------------------
1) OUTPUT EXPECTATION

--------------------------------------------------

- Build a polished, production-ready dashboard UI
- Use realistic sample data (including emissions values)
- Show Scope 1, 2, 3 and Total emissions clearly
- Ensure the interface looks like a real SaaS product used by large enterprises[6:40 PM]Build the "Subsidiaries" and "Location Management" module for TonyAI, an enterprise sustainability and carbon management platform.

This module is used to define the organizational structure of a holding, including subsidiaries and their multiple locations.

The system must support:
Holding > Subsidiary > Location hierarchy

This is a core foundation module that will be used later for:

- data entry assignment
- emissions calculation
- reporting boundaries
- sustainability reporting

--------------------------------------------------

1) PAGE STRUCTURE

--------------------------------------------------

Create a professional enterprise page with:

A. Header

- Title: Subsidiaries
- Subtitle: Manage subsidiaries, locations, and reporting structure
- Primary button: Add New Subsidiary

B. Main table (Subsidiary list)

C. Right-side drawer or modal:

- Subsidiary form
- Nested Location management

--------------------------------------------------
1) SUBSIDIARY TABLE

--------------------------------------------------

Columns:

- Company Name
- Country
- City
- NACE Code
- Authorized Person
- Location Count
- Child Subsidiary Count
- Status
- Last Updated
- Actions

Features:

- Search
- Filter (country, city, status)
- Sort
- Expandable row:
  → shows locations preview (very important)

--------------------------------------------------
1) SUBSIDIARY FORM

--------------------------------------------------

Sections (collapsible):

A. Company Information

- Official Company Name
- Country
- City
- Postal Code
- Address Information

B. Activity Information

- NACE Code (searchable)
- NACE Description (auto-fill)
- Company Capacity Report (file upload)

C. Contact Information

- Authorized Company Representative
- Representative Contact Information

D. Organizational Structure

- Does the company have multiple locations? (Yes/No)
- Number of Locations
- Does the company have child subsidiaries? (Yes/No)
- Number of Child Subsidiaries

--------------------------------------------------
1) LOCATION MANAGEMENT (CRITICAL NEW PART)

--------------------------------------------------

If "Does the company have multiple locations?" = YES:

Show a new section:

Title: Locations

User should be able to:

- Add multiple locations
- Edit locations
- Delete locations
- View location list inside the subsidiary

Each location should be handled as a structured sub-entity.

--------------------------------------------------
1) LOCATION FORM (FOR EACH LOCATION)

--------------------------------------------------

Each location must include the following fields:

- Location Name
- Address Information
- Activity Description (Faaliyet Hakkında)
- General Information
- Authorized Person
- Email Address
- Department Information

Field types:

- Location Name → text
- Address → textarea
- Activity Description → textarea
- General Information → textarea
- Authorized Person → text
- Email Address → email input
- Department → dropdown or text

--------------------------------------------------
1) LOCATION UI BEHAVIOR

--------------------------------------------------

Location section should be dynamic and user-friendly:

- Show locations as cards or rows inside the form
- Each location card shows:
  - Location Name
  - City or short address
  - Responsible person
  - Department
- Each card has:
  - Edit button
  - Delete button

Add "Add Location" button:
→ opens inline form or modal

Optional:

- Show total location count badge
- Allow expand/collapse for each location

--------------------------------------------------
1) SMART FORM LOGIC

--------------------------------------------------

- If "Multiple Locations" = NO:
  → hide entire location section

- If YES:
  → require at least one location entry

- Auto-update "Number of Locations" based on entries

- Validate:
  - required fields
  - email format
  - empty location prevention

--------------------------------------------------
1) UX ENHANCEMENTS

--------------------------------------------------

- Show completion progress for subsidiary form
- Show summary card:
  - total locations
  - has child subsidiaries
  - has capacity report

- Add helper texts:
  - explain NACE
  - explain reporting boundary
  - explain location definition

- Show small hierarchy preview:
  Example:
  Holding → ABC Energy → 3 Locations

--------------------------------------------------
1) FILE MANAGEMENT

--------------------------------------------------

For "Company Capacity Report":

- Upload file
- Show file name
- Show upload date
- Allow replace / delete
- Optional preview

--------------------------------------------------
1) ROLE-BASED BEHAVIOR

--------------------------------------------------

Super Admin:

- full control (create/edit/delete all)

Consultant:

- can view/edit multiple subsidiaries
- helps structure data

Standard User:

- limited access
- may only edit assigned subsidiary and locations

--------------------------------------------------
1) DESIGN SYSTEM

--------------------------------------------------

- Same design as dashboard
- Dark theme
- Clean enterprise UI
- Soft borders
- Card-based structure for locations
- Minimal but structured layout

DO NOT:

- make it look like CRM
- overload with unnecessary visuals

--------------------------------------------------
1) DATA MODEL LOGIC

--------------------------------------------------

Each subsidiary must support:

- company-level data
- multiple locations (nested)
- optional child subsidiaries

Each location must be stored independently and linked to its parent subsidiary.

This structure will later be used for:

- emissions allocation
- data entry mapping
- reporting scope definition

--------------------------------------------------
1) OUTPUT EXPECTATION

--------------------------------------------------

Build a production-ready module that includes:

- Subsidiary table
- Add/Edit subsidiary form
- Fully functional location management inside form
- Dynamic behavior (yes/no logic)
- Clean UI with realistic placeholder data

The module must feel like a real enterprise sustainability platform component used by large organizations.
