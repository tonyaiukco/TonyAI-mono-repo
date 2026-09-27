# TonyAI — Frontend / UX Test Feedback (Round 1)

> **Purpose:** Consolidated product-owner feedback from a hands-on walkthrough of the running app, prepared as a developer handoff.
> **Source:** Product-owner walkthrough · local environment · 2026-07-27.
> **Scope under test:** Phase 1 — Scope 1 & 2 carbon accounting. Areas: Subsidiaries, Data Entry, Overview (Carbon Dashboard), Emissions.
> **Prioritisation:** Intentionally left to the developer. This is **feedback only** — it does not scope, estimate, or sequence the work.
> **Emission factors:** Any factor or methodology change below must follow the project rule — never invent factor values; cite source + version; historic calculations remain immutable. Current in-app figures are prototype demo factors, not authoritative DEFRA/AIB values.

**Legend:** 🟥 functional gap / bug · 🟨 UX / interface adjustment · 🟦 new feature / capability

**Related page specs:** Subsidiaries → [`subsidiaries_page.md`](../md_docs/subsidiaries_page.md) (`/dashboard/subsidiaries`) · Data Entry → [`data_entry_page.md`](../md_docs/data_entry_page.md) (`/dashboard/data-entry`) · Overview / Carbon Dashboard → [`overview_page.md`](../md_docs/overview_page.md) (`/dashboard/overview`) · Emissions → [`emissions_page.md`](../md_docs/emissions_page.md) (`/dashboard/emissions`) · Calculation methodology → [`calculation_logic.md`](../md_docs/calculation_logic.md).

---

## 1. Summary Index

| ID | Area | Item | Tag |
| :--- | :--- | :--- | :--- |
| SUB-1 | Subsidiaries | Subsidiaries must be editable | 🟥 |
| SUB-2 | Subsidiaries | Super-admin subsidiary control panel | 🟦 |
| SUB-3 | Subsidiaries | Multiple locations + Google autofill on create | 🟦 |
| DE-1 | Data Entry | Long subsidiary names overlap the location field | 🟨 |
| DE-2 | Data Entry | Status stays yellow until all locations complete | 🟥 |
| DE-3 | Data Entry | Add "standard cubic metres" unit | 🟥 |
| DE-4 | Data Entry | Refrigerants — expand reporting scope | 🟦 |
| DE-5 | Data Entry | Mobile combustion — factors + on-road/off-road | 🟥🟦 |
| DE-6 | Data Entry | Electricity — add Turkey grid region | 🟥 |
| DE-7 | Data Entry | Standardise grid regions to UK + Turkey | 🟨 |
| DE-8 | Data Entry | Evidence upload — support Turkish characters | 🟥 |
| DE-9 | Data Entry | Extend reporting years (2015–2026+) | 🟥 |
| DASH-1 | Overview | Total-locations count must update live | 🟥 |
| DASH-2 | Overview | "Click to view details" boxes are not clickable | 🟥 |
| DASH-3 | Overview | Per-scope / per-category / invoice-level completeness | 🟦 |
| EM-1 | Emissions | Add "sales output" metric + natural-gas units | 🟦 |

---

## 2. Subsidiaries — `/dashboard/subsidiaries`

### SUB-1 — Subsidiaries must be editable 🟥
- **Current:** A subsidiary cannot be edited after it is created.
- **Expected:** Subsidiaries can be edited.

### SUB-2 — Super-admin subsidiary control panel 🟦
- **Current:** There is no dedicated management surface for a subsidiary.
- **Expected:** A subsidiary **control panel** available to **`super_admin` only** (not standard users), supporting:
  - Viewing more detailed information about the subsidiary.
  - Seeing and **adding locations**.
  - Changing **contact information**.
  - Similar management operations on the subsidiary.
- **Notes:** Must respect existing RBAC — this panel and all write actions are super-admin gated; reads remain tenant-scoped for other roles. See [`permissions_and_roles.md`](../md_docs/permissions_and_roles.md).

### SUB-3 — Multiple locations + Google autofill on subsidiary creation 🟦
- **Current:** Creating a **new** subsidiary offers **no option to add further locations** — only whole-subsidiary details are captured. The seeded mock subsidiary **"TonyAI Energy"** does expose additional-location options, so the capability exists in seed data but is not available in the create flow.
- **Expected:**
  - A **multiple-locations** capability in the subsidiary create/edit flow so a subsidiary can hold several locations.
  - **Address entry is not manual typing** — use **Google location / Places autofill**: the user types and selects from autocomplete suggestions to populate the address.
  - **Purpose:** locations define the **operational geographical borders** of the subsidiary. The system must be able to determine **how many locations a subsidiary has**, because that count drives downstream completeness tracking (see DE-2 and DASH-3).
- **Notes / to confirm:** Google Places integration requires an API key + billing and a decision on where the request is made (through the NestJS API vs. the browser). Needs product/infra sign-off before build.

---

## 3. Data Entry — `/dashboard/data-entry`

### DE-1 — Long subsidiary names overlap the location field 🟨
- **Current:** When a subsidiary name is too long, it overtakes / overlaps the adjacent **location** element in the interface.
- **Expected:** Adjust the layout so long names truncate or wrap and never collide with the location field.

### DE-2 — Data-collection status must stay yellow until ALL locations are complete 🟥
- **Current:** On **submit for review**, the data-collection status turns **green immediately**.
- **Expected:** Status stays **yellow** until **every location** of the subsidiary has its data entered. The tool must acknowledge the subsidiary's **full operational borders** (all locations) and turn **green only when all locations' input is keyed in**.
- **Notes:** Depends on SUB-3 (locations define the borders) and shares its completeness logic with DASH-3.

### DE-3 — Add "standard cubic metres" unit 🟥
- **Current:** The activity-data box has no **standard cubic metres** option.
- **Expected:** Add standard cubic metres as a selectable unit. See also EM-1 (`Sm3` / `M3`) and the natural-gas normalisation in [`calculation_logic.md`](../md_docs/calculation_logic.md).

### DE-4 — Refrigerants: expand the reporting scope 🟦
- **Current:** Refrigerant reporting is missing key fields.
- **Expected:** Add to the refrigerants reporting scope:
  - **Make and model** of the unit.
  - **Type** of refrigerant / unit.
  - Whether there was **any refuelling** during that specific reporting year.
  - **Gas type** — emission factors vary by gas type.
  - **Unit to report** — typically **grams** — captured within the activity data.
- **Notes:** Gas-type-specific factors required. Do not invent factor values; cite source + version.

### DE-5 — Mobile combustion: missing factors + on-road / off-road 🟥🟦
- **Current:** The Mobile Combustion reporting scope has **no emission factor**.
- **Expected:**
  - Add factors for **gasoline, diesel, and LPG**.
  - Add a further section within the scope for **"on road"** and **"off road"**.
  - **Refine the calculation logic based on the reference spreadsheet**, including the mobile-combustion **on-road / off-road** metrics.
- **Notes:** Requires the reference spreadsheet to define/verify factor values and methodology; update [`calculation_logic.md`](../md_docs/calculation_logic.md) accordingly. Do not invent factor values.

### DE-6 — Electricity: add Turkey grid region 🟥
- **Current:** In the electricity additional context, the correct **regional grid** must be selectable, but **Turkey is not currently an option**.
- **Expected:** Add **Turkey** as a grid region.

### DE-7 — Standardise grid regions to UK and Turkey 🟨
- **Current:** Grid regions are shown as **Germany (North, South, National)** plus **EU**.
- **Expected:** **Standardise to UK and Turkey for now.**
- **To confirm:** Should Germany / EU options be **removed** or **hidden** for the current focus?

### DE-8 — Evidence upload does not read Turkish characters 🟥
- **Current:** The evidence screen on Data Entry does not read Turkish alphabet characters (e.g. ç, ğ, ı, İ, ö, ş, ü) — likely in filenames.
- **Expected:** Support Turkish characters where feasible ("if possible").
- **Notes:** Investigate encoding / Unicode normalisation on upload, storage key generation, and download. See [`supabase-storage`] flow / evidence module.

### DE-9 — Extend selectable reporting years 🟥
- **Current:** Only **2023** and **2024** are offered as reporting years.
- **Expected:** Extend the range to **2015 through 2026**, and continue **adding new years as they arrive**.

---

## 4. Overview / Carbon Dashboard — `/dashboard/overview`

### DASH-1 — Total-locations count must update live 🟥
- **Current:** When a new subsidiary is added, the **number of companies updates correctly**, but the **total number of locations does not update**.
- **Expected:** The total-locations figure must **update immediately** whenever a location is added.

### DASH-2 — "Click to view details" boxes are not clickable 🟥
- **Current:** The Carbon Dashboard has a large, working **Data Collection Status** box; live data entered on the Data Entry page reflects there correctly. However, the smaller boxes displaying that data are **not clickable**, despite showing the label **"click to view details."**
- **Expected:** Make them clickable so the user can **drill into specific categories per subsidiary** (the detail this should reveal is specified in DASH-3).

### DASH-3 — Data Collection Status: per-scope, per-category, invoice-level completeness 🟦
- **Current:** The Data Collection Status screen shows overall status but lacks scope-/category-level detail and true completeness tracking.
- **Expected:**
  - There are **X emission categories** across the **three main scopes**.
  - Each **subsidiary** can be **clicked** to reveal what is keyed in, what is **missing**, plus a section to **comment and submit**.
  - Add the ability to **click into each scope** to verify whether the relevant reporting data has been entered correctly.

- **Utility invoice completeness rule (electricity, gas, water):**
  - The system knows **how many locations** a subsidiary has (from SUB-3).
  - Each of these three utilities requires **one invoice per month (January–December)** as proof — i.e. **12 invoices per utility per location per year**.
  - **Required invoices = 3 utilities × (number of locations) × 12 months.**
  - The section is marked **"complete" only when every required invoice is submitted**; otherwise it stays **incomplete**.
  - **Worked example:** *Emre Energy* operates 4 plants → the user adds **4 locations** → the system expects electricity + gas + water bills for each location, each month:

    | Utilities | Locations | Months | Invoices required / year |
    | :--- | :---: | :---: | :---: |
    | 3 (electricity, gas, water) | 4 | 12 | **144** |

    The Data Collection Status only reads **complete** once all **144** invoices are in.

- **All other (non-utility) categories:** use a simple **Yes / No** to indicate completed or not.
- **Notes:** This is the core completeness engine; it also drives DE-2 (yellow-until-complete). Needs a data model keyed by **subsidiary → location → utility category → reporting month → invoice/evidence**.

---

## 5. Emissions — `/dashboard/emissions`

### EM-1 — Add "sales output" metric + natural-gas units 🟦
- **Current:** No "sales output" metric.
- **Expected:**
  - Add **"sales output"** as a new metric.
  - List units **`Sm3`** and **`M3`** for **natural gas**.
  - **Focus on energy-sector metrics for now.**

---

## 6. Cross-cutting Observations

Stated as factual relationships between items (not a build order — prioritisation is the developer's):

1. **Locations are foundational.** SUB-2, SUB-3, DE-2, DASH-1, and DASH-3 all rely on a subsidiary owning multiple locations that define its operational borders and drive the invoice/completeness maths.
2. **Shared completeness logic.** DE-2 (Data Entry status) and DASH-3 (Dashboard status) must apply the same rule: `3 utilities × locations × 12 months` for electricity/gas/water; Yes/No for other categories.
3. **Factor & methodology coverage.** DE-4 (refrigerants) and DE-5 (mobile combustion) require confirmed factor values and calculation logic from the reference spreadsheet; never invent values.
4. **Turkey localisation.** DE-6 (TR grid), DE-7 (UK/TR standardisation), and DE-8 (Turkish characters) are the localisation cluster.

---

## 7. Points to Confirm With Product Owner

> **All four answered 2026-07-31** (rationale in the decisions log of
> [`../roadmap_docs/project_status_roadmap_phases.md`](../roadmap_docs/project_status_roadmap_phases.md)):
> **SUB-3** — Google Places is out of scope for now; multi-location ships without it (WP16).
> **DE-5** — no reference spreadsheet available, so mobile combustion defers to the Phase-4 factor package (DE-4 with it).
> **DE-7** — Germany/EU grid options are **hidden, not removed**; deleting EU would break the seeded Munich subsidiary's factor resolution (WP15).
> **DASH-3** — invoice-level tracking covers **Electricity, Natural Gas, Water** only; the other eight categories are complete/incomplete (WP17).
>
> The questions below are preserved as received.


- **SUB-3:** Google Places API — key, billing model, and whether the call routes through the NestJS API or the browser.
- **DE-5:** access to the reference **spreadsheet** for mobile-combustion factors and calculation logic.
- **DE-7:** remove vs. hide the Germany / EU grid regions.
- **DASH-3:** the exact list of "other" categories that use simple Yes/No rather than invoice-level tracking.