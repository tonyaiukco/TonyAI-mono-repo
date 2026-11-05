# Design

## Context

What exists on `main` (`3f78d7e`, investigated 2026-11-05):

- **Contract and loader.** The contract (`FactorReleaseImport`) and the loader (`apps/api/src/factor-releases/`) work end to end. A dry run is the default; `--apply` loads and seals the release in one transaction as `tonyai_factor_loader`. Re-running the same file is a no-op.
- **Publishers.** The registry admits only `TonyAI prototype` and `TonyAI test fixture`. The `factor_releases_publisher_check` CHECK enforces this, with a parity spec and an md5 pin in `runtime-role.mjs`.
- **Engine.** It computes `value × factor`, with at most one cross-family `unit_conversions` step.
  - `CalculationInput` carries no per-record parameter. The record's `input` JSON is free-form and never read.
  - No calculation takes more than one input.
  - `standard_cubic_metres` is still `blocked` as a unit, and is pinned to 15 °C, 101.325 kPa.
  - Directly entered fuel kWh resolves on the gross basis.
- **Categories and activity types.** They are plain strings, but four database CHECKs list them by hand, each with an md5 pin and a parity spec:
  - `activity_records_scope_check`;
  - `inventory_sources_mapping_check`;
  - two inventory category CHECKs.
- **Snapshots.** `CalculationResultV2` is immutable once committed (TA001). Drafts are recomputed at submit and approve (K11).
- **Reports.** Excluded and unsupported sources already print with their reasons, so purchased heat and steam can be declared "Out of scope (N/A)" today. There is no market-based Scope 2 and no method label.
- **Owner decisions of 2026-11-05.** Recorded in the conversation and to be written into the planning file in PR 1:
  - TR only.
  - The document is the sole source and is followed as written, including the GCV correction and the LNG NCV.
  - The contradictions are resolved as proposed.
  - ETKB data years 2023, 2024 and 2024.
  - Internal reviewers are accepted in place of D24's external one, with `reviewedBy` = "TonyAI Sustainability Team".
  - LP4-02 closes on the document's §5 golden values.
  - The Turkish document is committed under a language exception.

## Goals / Non-Goals

**Goals:**
- Every pilot Scope 1/2 source in the document's §1 is either priced or explicitly excluded.
- The §5 golden values reconcile within ±0.5%.
- Committed snapshots are untouched.

**Non-Goals:**
- Correcting the document's values.
- UK coverage.
- Market-based inputs.
- An equipment register (each refrigerant record carries its own equipment inputs).
- The UAT UI findings.
- Changing how placeholders are allowed locally.

## Decisions

### D1. Two releases, one per publisher
The document names IPCC (fuels, gases, GWPs) and ETKB (grid) as publishers. Each release has one publisher, so we load:
- **`IPCC`:** edition `TONYAI-EF-TR-UK-2026.11-AR6-SEALED`, `gwpSet: AR6`. It holds natural gas, stationary fuels, mobile modes, leakage, refrigerant GWPs, the leak-rate parameters and the reference GCV.
- **`ETKB`:** the same edition code. It holds grid electricity 2024–2026.

Rows that rely on national values (NCVs, densities) or on the holding's own figures (leakage composition, leak rates) cite the document's section in `source` and give the arithmetic in `methodology`.

*Alternative:* a single "TonyAI Sustainability Team" compiled release. Rejected, because the document assigns the values to IPCC and ETKB, and the reviewer would then also be the publisher.

### D2. Calculation parameters as a sealed child table of a release
Leak rates (nine defaults plus two alternatives), the reference GCV 9,155 and the reference NCV 8,250 are sourced numbers, so they must not live in code.

We add:
- a `factor_parameters` table: release, key, equipment type or subject, value, unit, `is_default`, source, methodology;
- the import's `parameters[]`.

Each key has one unit: `leak_rate` is a `fraction` (0.02, at most 1), `reference_gcv` and `reference_ncv` are `kcal/Sm3`. Every value is positive, since a zero would silently price nothing. The database holds the same rules. An alternative rate needs a default beside it.

They are sealed with the release and withdrawn with it. Their import, seal and runtime guards follow the existing `unit_conversions` pattern. A calculation's snapshot cites each parameter it used.

*Alternative:* contract constants. Rejected, because they wouldn't be versioned or cited, and an erratum would need a deploy.

### D3. Per-record inputs as a typed, validated block
Records gain a typed `parameters` object, separate from the free-form `input`. Each category validates it:

| Category | Fields |
|---|---|
| Natural Gas | `ncvKcalPerSm3?`, `billedGcvKcalPerSm3?` (mutually exclusive), `volumeCorrectionFactor?` (a TR record in m³ needs it; the engine refuses one without, D5) |
| Refrigerants | `equipment[]`, one or more of `{ equipmentType, capacityKg, refillKg, leakRateChoice: 'default' \| 'alternative' }`, each type at most once (from PR3, D7) |

A refrigerant record's `kg` activity value is its total installed capacity, the sum of `capacityKg` (D7).

It is stored in its own column and validated by DTOs (class-validator) and a database CHECK on shape, which refuses a key the category does not define. An edit is checked against the effective category: moving a record whose stored parameters do not fit the new category is refused until they are cleared with null. `CalculationInput` carries the object, and staleness (K11) compares it.

PR2 ships a single-equipment shape behind the gate below. PR3 replaces the type, the DTO and the shape CHECK with `equipment[]`, in a new migration; the column holds only NULL until then.

**Until PR3 the API refuses non-null parameters** (owner decision 2026-11-05). The engine does not read them before PR3, and PR2 deploys to hosted QA on merge, so a saved value would sit beside a figure that never used it and freeze when the record is committed. PR3 removes the gate in the same change that makes the engine read them.

*Alternative:* reading `input` JSON. Rejected, because it is free-form, unaudited as calculation input and invisible to staleness.

### D4. Snapshot V3
`CalculationResultV3` adds:
- `parameters`: each input with its origin (`default`, `user`, `derived`) and value;
- `parameterRows`: the release parameters used;
- for refrigerants, the term breakdown (capacity × rate and refill).

V2 readers stay as they are. A reader union accepts both versions, and the issuance gate's pinned fingerprints keep old datasets issuable. Placeholder-era snapshots are never rewritten.

### D5. Natural gas chain
- **Factor:** a TR `kWh` net-basis row, 0.20215548 kgCO2e/kWh = 56,154.3 kg/TJ × 3.6e-6. The 56,154.3 is 56,100 + 1 × 27 + 0.1 × 273.
- **Conversion:** a TR Sm³ → kWh net row, 9.588333 kWh/Sm³ = 8,250 × 4.184 / 3,600. Its reference conditions are 15 °C, 101.325 kPa.
- **One source for 8,250:** `reference_ncv` is the value. The release validator refuses a Sm³ → kWh net row that differs from `reference_ncv × 4.184 / 3,600` beyond rounding, so the snapshot can never cite 8,250 beside another multiplier. An unedited NCV is sent as null, not as 8,250, so its origin stays `default`.
- **Per-record override:** it replaces the multiplier before the step. An edited NCV gives `NCV × 4.184 / 3,600`. A billed GCV gives an effective NCV of `8,250 × 9,155 / GCV`, with 8,250 and 9,155 read from the release parameters.
- **Metered m³:** a per-record `× volumeCorrectionFactor` step runs first. This is the only metered-volume route for TR, so no national m³ row is loaded (an earlier review note).
- **kWh entries** stay gross and are refused with `calorific_basis_mismatch`.
- `standard_cubic_metres` is unblocked.

Golden values 4 and 5 check this chain.

### D6. Fuels, mobile modes, leakage: per-unit rows computed at import
The document's per-TJ factors become per-unit rows, `density × NCV × 4.184e-9 × (CO2 + CH4 × 27 + N2O × 273)`. Each row also gets per-gas disclosure rows beside its CO2e total.

| Source | Value | Unit |
|---|---|---|
| Stationary diesel | 2.633422 | kgCO2e/L |
| Stationary petrol | 2.224216 | kgCO2e/L |
| LPG | 2.880190 | kgCO2e/kg |
| Coal | 2.526194 | kgCO2e/kg |
| LNG | 2.224506 | kgCO2e/kg |
| Fuel oil | 3.118712 | kgCO2e/kg |
| On-road petrol | 2.307825 | kgCO2e/L |
| On-road diesel | 2.666195 | kgCO2e/L |
| On-road LPG | 1.655666 | kgCO2e/L |
| Off-road petrol | 2.277026 | kgCO2e/L |
| Off-road diesel | 2.905286 | kgCO2e/L |
| Leakage | 19.254571 | kgCO2e/Sm³ (0.646127 kg CH4/Sm³ × 29.8) |

- **Fuel** gains `kg`, a mass family, so a per-kg factor needs no conversion.
- **Mobile modes** are new activity types: `on_road_petrol`, `on_road_diesel`, `on_road_lpg`, `off_road_petrol`, `off_road_diesel`. The existing `diesel`, `petrol`, `lpg` and `cng` stay valid for existing records, and the TR releases do not price them.
- **Fugitive Gas** is a new Scope 1 category with the implicit type `gas_network_leakage` and the unit `standard_cubic_metres`.

The implementer re-derives every value from the document in the release-building script, and the table above is the check.

### D7. Refrigerant capacity method
A record is one gas in one site's year, with one line per equipment type:

`kgCO2e = Σ (capacityKg × rate + refillKg) × GWP`

- The rate comes from the line's equipment type, as the default parameter or, where one exists, the alternative.
- **Equipment list (owner decision 2026-11-05).** The record's key ends at the gas, so a split air conditioner and a chiller using the same gas at one site share a record. Their rates differ, so one capacity could not price them. The list keeps the record key, the bulk slot check and boundary attachment unchanged.
- **Annual only (owner decision 2026-11-05).** The document's rates are yearly, so a monthly or quarterly record would overstate the leak. The capacity method refuses a record whose period is not `annual`; pro-rating is not in the document.
- **Sum.** The service and the engine refuse a record whose activity value differs from the sum of its `capacityKg`. A refill-only record has an activity value of 0 and lines of capacity 0.
- **No parameters.** A TR refrigerant record with NULL parameters is refused at create and submit, because the method cannot price it. Committed records are not touched.
- The GWP is the gas's per-kg CO2e row: HFC-227ea 3,600; R-410A 2,256; R-134a 1,530; R-32 771; R-404A 4,728; R-22 1,960; SF6 25,200.

Reports print the activity value as the total capacity, which is not the priced mass, so PR5 prints the refill and the term breakdown beside it. R-22 and SF6 join the list, which reverses the comment that excluded HCFCs; the owner decided this on 2026-11-05.

Equipment types:

| Equipment type | Default rate | Alternative |
|---|---|---|
| `fire_suppression_system` | 0.02 | |
| `fire_extinguisher` | 0.04 | |
| `transformer_breaker` | 0.0001 | |
| `split_air_conditioner` | 0.01 | 0.10 |
| `water_dispenser` | 0.001 | |
| `refrigerator` | 0.001 | |
| `chiller` | 0.02 | 0.08 |
| `mobile_air_conditioner` | 0.15 | |
| `portable_air_conditioner` | 0.10 | |

### D8. Edition overlap (follow-up 12)
The loader refuses a live, non-superseding release that overlaps another live release of the same publisher on any factor identity. This keeps one live edition per slot, so an erratum to an older edition cannot outrank a newer one.

### D10. Report dataset schema 2
Issuance recomputes a retained dataset's assessments with today's code and refuses one that differs (K2), and `boundaryGaps` reads the list of categories a boundary must decide. Adding Fugitive Gas to that list would make every dataset retained before it unissuable. So:
- `REPORT_DATASET_SCHEMA_VERSION` becomes 2, and `report_datasets_schema_check` admits 1 and 2;
- `BOUNDARY_CATEGORIES_BY_DATASET_SCHEMA` spells out each version's categories as literals, never aliased to today's list;
- `assessDataset` takes the version as a required argument, so a caller cannot silently mean today's rule;
- schema 1's pinned fingerprints stay as they were, and schema 2 has its own.

A new capture of a version confirmed before Fugitive Gas existed is **partial**, with `applicability_undetermined` on Fugitive Gas, until a new version decides it (`copyOf` provides the remedy). Failing closed is deliberate: a boundary that was never asked about a source has not excluded it. Accepted by the owner on 2026-11-05.

### D9. PR sequence

```text
PR1 docs ─► PR2 contract+migrations ─► PR3 engine+V3 ─► PR4 forms+bulk ─► PR5 releases+goldens+report label
(PR1 skips the deploy; PR2 onward deploys to hosted QA on merge — "QA deploy" re-enabled 2026-11-05)
```

- **PR2:** publishers, categories, types, units, CHECKs, the parameters table and the loader's support for it, the record parameters column with its write path refused (D3), pins and parity specs, removing `testPublishers`, D8, D10, and the catalogue labels the typed contract requires at once.
- **PR3:** D3–D7 in the engine, the snapshot union and staleness, `equipment[]` with its migration, and the removal of PR2's parameters gate.
- **PR4:** the Data Entry form, bulk columns and template, and the TR/EN catalogues.
- **PR5:** the two release files with their build script, the golden integration tests, the Scope 2 label and the docs.

PR2 and PR3 merge separately (owner decision 2026-11-05). Hosted QA load is a separate owner step after L10 closes.

## Risks / Trade-offs

- **Two values are accepted as written: the GCV correction direction and the LNG NCV.** Mitigation: they are recorded as owner decisions in the planning file and cited in the rows' methodology. A later correction is an erratum edition.
- **The migrations cross the L10 rollback drill.** The owner accepted this on 2026-11-05 and re-enabled "QA deploy": once PR2 deploys, L10's drill is the same-image fallback (close-l10 task 8.4), and the cross-version rollback is recorded as not rehearsed.
- **QA's round runs against moving releases.** Mitigation: each finding is mapped to the release that was live when it was found (deploy run, digest), and probe A is rerun on the final release (close-l10 task 8.6).
- **A deploy applies each migration to hosted QA's database.** Mitigation: the migrations are additive, though an image rolled back past D10 answers a schema 2 dataset with an internal error (it fails closed), and "Rollback QA" refuses to cross a migration. The deploy's verification and smoke run on every merge, with the automatic image restore on failure.
- **A snapshot V3 change could make older retained datasets unissuable.** Mitigation: a reader union, a frozen V2 path, and the issuance fingerprints kept green.
- **Four hand-listed CHECKs with md5 pins can drift.** Mitigation: one migration updates all of them together, and the parity specs and `runtime-role.mjs check` fail if they don't match.
- **Internal reviewers and internally derived golden values aren't independent (D24).** Mitigation: accepted by the owner on 2026-11-05 and recorded. The goldens are only as good as the document.
- **Old mobile types stop pricing in TR, so existing drafts become `no_factor` at submit.** Mitigation: no TR pilot data exists yet. Release notes tell users to re-enter drafts with a mode.

- **Confirmed boundaries lose `final` in hosted QA once PR2 deploys (D10).** Mitigation: it fails closed and names the gap. The PR warns QA that a new version must decide Fugitive Gas.
- **The category appears before it can be priced.** Fugitive Gas and Sm³ are selectable from PR2, and a record is refused with `no_factor` or `no_conversion` until PR5's releases load. The tracking matrix shows the new category's cell as missing meanwhile.

## Migration Plan

1. PR1 (docs) merges first.
2. PR2–PR5 merge in order, each on green CI plus Integration, and each deploys to hosted QA on merge. The risky ones (PR2, PR3, PR5) get the `security-rls`, `qa-auditor` and `architect` review pass.
3. Locally and in CI the releases load through the loader: dry run first, then `--apply`.
4. After L10 closes, the owner provisions the hosted loader login and runs the dry run and `--apply` against hosted QA, then the readback (`runtime-role.mjs check`, `GET /api/v1/factors`).
5. **Rollback.** Before any hosted load, rollback is the existing image rollback; the migrations are additive. After a load, an error is corrected by an erratum edition or a withdrawal, never by deleting rows.

## Open Questions

- The TR catalogue wording of the new labels and of "No market-based result" goes to the owner's Turkish review, as with LP4-04.
