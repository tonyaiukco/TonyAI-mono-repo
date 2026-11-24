# Proposal

## Why

Fire-suppression equipment has no entry of its own on Data Entry. It can be entered only as equipment lines of a
`Refrigerants` record, in kilograms, among air-conditioning types and refrigerant gases. UAT round 4 files this as
BUG-12 (Çorum soft launch): the data request form the pilot companies fill in has a separate fire-suppression sheet,
collects capacity and refill in grams, and lists CO2, which the factor library does not price. The owner's direction
for round 4 is to follow the v4 documents as written (Decisions 2026-11-24 (third)), and this change reads BUG-12
through those documents alone.

## What Changes

- **A new Scope 1 category, `Fire Suppression`.** It appears wherever a category does: the Data Entry picker, the
  records table, the tracking matrix, the inventory boundary, reports and exports. The documents treat each sheet
  of the data request form as a category (INC-2.9 §1), and the boundary and the evidence list are per category.
- **The entry on Data Entry** asks for the gas and, per line, the device: fire extinguisher, fire suppression system
  or transformer breaker gas. The gas list holds CO2, FM200 (HFC-227ea), SF6 and "Dry powder / foam (no greenhouse
  gas)". An "Other gas" item states that a gas the library does not price cannot be entered; it saves nothing.
- **Grams by default.** Each line has a g / kg selector for its capacity and refill, set to grams on a new line.
  The form converts to kilograms before preview and save and shows the kilogram figure beside the field. Records
  stay in kilograms everywhere else.
- **The same calculation.** A fire-suppression record is priced by the capacity method as a refrigerant record is,
  with the refill rule of BUG-17 and the document's leak rates per device. No formula changes.
- **A supplementary factor edition** (IPCC ordinal 3, beside the TR package, superseding nothing) prices the new
  category for 2024 to 2026: HFC-227ea 3,600, SF6 25,200 and CO2 1 (the package's AR6 values), the leak rates of the
  three devices, and a zero row for "dry powder / foam". The owner signs it before it is loaded as authoritative.
  **This revises the owner's decision of 2026-11-13 (D10)**, which planned CO2 as an erratum under `Refrigerants`;
  see `design.md`, decision 3.
- **A dry powder or foam extinguisher is recorded with a figure of zero.** The record exists, carries its devices
  and evidence, and counts toward completeness. Its zero comes from the edition's own row, never from a missing
  factor.
- **The refrigerant entry offers cooling equipment and refrigerant gases only** for new lines and new records.
  Existing `Refrigerants` records that hold fire devices or fire gases stay as they are and stay editable.
- **Evidence.** `Fire Suppression` is evidence-required like every Scope 1 category, and its Evidence section names
  its own accepted documents (INC-2.9 §2): the equipment tracking sheet, system drawings and photographs. The
  one-document-for-the-year's-gas-records shortcut works within the category.
- **Anomaly ceilings** apply per equipment line with the refrigerant numbers (500 kg, 125% of capacity).
- **Inventory boundary and report datasets.** The boundary gains the category; the report dataset schema becomes
  version 3. A boundary confirmed before the category existed yields a partial, with the category named, until a
  new version decides it (the Fugitive Gas precedent).
- **Bulk upload** accepts fire-suppression equipment rows in kilograms through the columns refrigerant rows use.
  The g / kg selector is a Data Entry control only.

Not in this change: moving or re-categorising existing `Refrigerants` records; refusing fire devices on
`Refrigerants` in the API or the bulk file; a gas list that follows the library at run time (filed, with the five
refrigerant gases the library does not price); a g / kg selector on the refrigerant entry or in the bulk template;
the category permissions of INC-2.6 (WP6); loading the edition on hosted QA (an owner release after the deploy).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `activity-data-entry`: a fire-suppression entry with its gas and device lists, the no-greenhouse-gas option, the
  "other gas" statement and the g / kg selector; the refrigerant entry offers cooling equipment and gases only.
- `emission-calculation`: fire-suppression records are priced by the capacity method with the three devices; a dry
  powder or foam record is calculated as zero; report datasets gain schema version 3.
- `emission-factor-library`: a supplementary IPCC edition prices the fire-suppression category, with its review
  record.
- `record-evidence`: `Fire Suppression` joins the evidence-required categories, names the documents it accepts, and
  has the year's-gas-records shortcut.
- `anomaly-check`: fire-suppression records are checked per equipment line.

## Impact

- **Shared types:** `CATEGORIES` and every map keyed by category (scope, units, activity types, evidence, inventory,
  dataset schema 3); the catalogue entries `CO2` and `dry_powder_or_foam`; one predicate for "priced by the capacity
  method" that replaces the `'Refrigerants'` literals; the equipment types each category accepts and offers; the
  release-import validator's refrigerant rules.
- **Database:** one expand-only migration re-creating six CHECKs (`activity_records_scope_check`,
  `activity_records_parameters_check`, the two boundary category checks, `inventory_sources_mapping_check`,
  `report_datasets_schema_check`) and their md5 pins. No table, column or grant changes.
- **API:** the record DTO's equipment rule per category, the engine's rule selection and release-parameters read,
  the first-period ceiling and its SQL probe mirror, the bulk equipment-row grouping, the dataset and issuance
  gates for schema 3, report vocabulary (TR/EN).
- **Factor data:** `packages/db/factor-releases/tr-fire-2026-11/` (build script, spec, JSON), its package script,
  the integration helper's load list, the `factor-release-import` skill's load order.
- **Web:** Data Entry (picker, fire-suppression lines, the unit selector, the gas list), the evidence vault's note
  and shortcut, the catalogues (`categories`, `dashboard`, `dataEntry`, `evidence`), anything that lists categories.
- **Tests:** shared-types and validator specs, record DTO and CHECK parity specs, engine vectors, the edition's
  build spec and its load on `test:int`, boundary and dataset specs for schema 3, bulk specs, web view specs, one
  e2e spec for the entry.
- **Docs:** `docs/md_docs/calculation_logic.md`, `docs/md_docs/data_entry_page.md`,
  `docs/md_docs/validation_anomaly_rules.md`, `docs/api/`, the planning file and the sprint ledger.
- **Data and operations:** confirmed boundaries on hosted QA read as partial for the new category until a new
  version decides it. The category prices nothing on an environment until the edition is loaded there. Loading
  it withdraws nothing, so no open draft becomes stale.
