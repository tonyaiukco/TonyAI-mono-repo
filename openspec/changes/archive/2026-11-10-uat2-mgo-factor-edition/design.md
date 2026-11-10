# Design

## Context

See proposal.md for why. The current state that shapes the approach:

- The TR package is two sealed releases built by `packages/db/factor-releases/tr-2026-11/build.mjs` from `docs/md_docs/Revision MD.md`: `etkb.json` (ETKB, ordinal 1) and `ipcc.json` (IPCC, ordinal 1, edition `TONYAI-EF-TR-UK-2026.11-AR6-SEALED`, 171 factors). Its 60 Mobile Combustion rows are the five vehicle modes × 2024–2026 × four gases, all `kgCO2e/L` on `normalizedUnit: litres`, `calorificBasis: not_applicable`.
- Release identity is unique on `(publisher, ordinal)` and `(publisher, edition)`. The loader refuses a release that overlaps a live one from the same publisher on category, activity type, geography, year, gas and scope-2 method, unless it supersedes it.
- The one factor lookup keys on category, activity type, geography and year. `selectByRelease` takes the highest-ranked status, refuses two publishers at that rank as `ambiguous`, and then takes the highest ordinal. A new activity type is a new key, so its candidates never meet the TR package's rows.
- `resolveFactorPath` holds conversion targets only for metered and standard volume. A mass record meets only mass factors, and a volume record meets only volume factors. A mismatch ends in `no_factor`.
- `normalization.ts` already converts `tonnes` to `kg` by definition (×1,000).
- The builder already emits per-kg rows (`density: null`) for LPG, coal, LNG and fuel oil.
- The integration tests load the TR releases from `apps/api/test/int/tr-releases.ts`, which reads the `tr-2026-11` directory.
- The inventory boundary's `inventory_sources_mapping_check` (last re-created in `20261105120000_lp4_02_tr_publishers`) lists each typed category's activity types in SQL. `boundary-schema-parity.spec.ts` asserts that it matches `recordActivityTypesFor`, and `packages/db/scripts/runtime-role.mjs` pins the constraint's definition hash.
- The API's validation and the bulk template allow units per category (`CATEGORY_UNITS`). For a new TR record, Data Entry narrows that further through `offeredActivityTypes` and `unitsForRecord(category, geography)` in shared-types: TR Mobile Combustion offers only the five vehicle modes, in litres only. Their only callers are `apps/web/app/data-entry/page.tsx` and `apps/web/lib/record-inputs-view.spec.ts`.

## Goals / Non-Goals

**Goals:**
- MGO is priced on TR records for 2024–2026 from values that trace to named IPCC 2006 tables only.
- Nothing in the TR package, its source document, or any committed snapshot changes.
- The edition can be corrected or withdrawn on its own, without touching the TR package.

**Non-Goals:**
- A general marine-fuel catalogue (HFO, VLSFO, bunker LNG), a litre or density path for MGO, distance-based marine activity.
- Any change to factor selection, the loader, the import contract's shape, or any table or column.
- Per-activity-type unit validation in the API or the bulk template.
- Loading on hosted QA. That is the owner's operation after merge.

## Decisions

### D1. A supplementary IPCC release, not a new edition of the TR package's IPCC release
The MGO rows ship as IPCC ordinal 2 with their own edition label (working name `TONYAI-EF-TR-MGO-2026.11-AR6`). The release does not supersede ordinal 1.
- **Why:** the coverage does not overlap, so the loader accepts it as is. The TR release stays the faithful image of `Revision MD.md`, and the MGO rows keep a provenance of their own. A later correction to either one is a narrow erratum.
- **Alternative rejected:** re-issuing the whole IPCC release with MGO added and `--supersedes`. That would mix two provenances in one release, re-seal 171 rows that did not change, and make every TR snapshot cite a superseded edition for no reason.
- **Alternative rejected:** a new publisher. The registry is closed, and IPCC is the true publisher.
- **Consequence:** `selectByRelease` will rank the two IPCC releases by ordinal only within a key. No key is shared today. A future erratum to the TR package's IPCC release must take IPCC ordinal 3 or higher (ETKB's next stays 2, so the TR builder's shared ordinal must split) and must keep its coverage clear of MGO: `--supersedes` names one edition, so no single release can replace both. Load order is permanent: ordinal 1 (`tr-2026-11/ipcc.json`) must be loaded before ordinal 2 on every database, or ordinal 1 is refused for good (factor-release-import skill).

### D2. Its own directory and builder
New directory `packages/db/factor-releases/tr-mgo-2026-11/` with `build.mjs`, `build.spec.mjs` and `ipcc-mgo.json`, and a `factor-releases:tr-mgo` script beside `factor-releases:tr`. The builder holds the cited inputs (the IPCC table values, the NCV and the AR6 GWPs) and computes each row, writing the formula with its numbers into `methodology`, in the TR builder's style.
- **Why:** `tr-2026-11/build.mjs` documents itself as built from `Revision MD.md`. Adding a second source to it would blur what it builds from.
- **Alternative rejected:** a hand-written JSON. The TR package set the convention that every derived value is recomputable and spec-tested.

### D3. Mass basis, `kgCO2e/kg`
Rows use `normalizedUnit: kg`, `factorUnit: kgCO2e/kg` and `calorificBasis: not_applicable`, as the TR mobile rows use. The factor is `NCV (TJ/kg) × (CO2 + CH4 × 27.0 + N2O × 273)`. The gas rows carry each gas's share, as the TR mobile rows do. 27.0 and 273 are the AR6 values the TR package applies to combustion CH4 and N2O.
- **Why:** BDNs state metric tonnes. IPCC gives no density, and ISO 8217 gives only a maximum. A mass basis needs no value that is not in the source.

### D4. Sources and the extraction step
- CO2: IPCC 2006 Vol. 2 Ch. 3, Table 3.5.2 (water-borne navigation, gas/diesel oil).
- CH4 and N2O: Vol. 2 Ch. 3, Table 3.5.3 (ocean-going ships).
- NCV: Vol. 2 Ch. 1, Table 1.2 (gas/diesel oil default).

The `data-factors` agent extracts each value from the published PDF and records the table, row and page in the builder. A second reader checks it before the PR. **The values are not stated in any planning artifact.** CO2 is expected to match the gas/diesel oil value the TR package already uses for diesel (74,100 kg/TJ). The builder's spec asserts that match, as a cross-check on the extraction.
- **Alternative rejected:** the TR package's diesel NCV (10,200 kcal/kg). It belongs to the TR document, and MGO is not in that document. Borrowing it would cite a source that does not cover the fuel.

### D5. Activity type and units in the contract
`marine_gas_oil` (label "Marine gas oil (MGO)") is appended to Mobile Combustion's types in `@tonyai/shared-types`, and `tonnes` to its units. Both flow to the form, the bulk template and DTO validation from that one list. The TR label must read as marine diesel fuel, not as kerosene (the existing `gas_oil` warning in the code).
- **Form narrowing:** under the TR rules, `offeredActivityTypes` offers the five vehicle modes plus `marine_gas_oil`. `unitsForRecord` gains an optional activity-type argument: TR MGO is offered `kg` and `tonnes`, and a TR vehicle mode keeps `litres` only. Data Entry passes the selected type and re-narrows the unit when the type changes.
- **API and bulk:** these stay per category. Adding `tonnes` to Mobile Combustion lets any mobile type arrive in tonnes through the API or a bulk file. Every non-MGO type then ends in `no_factor`, exactly as `kg` does today. MGO in litres ends in `no_factor` too.
- **Alternative rejected:** per-type unit validation in the API and the bulk template. That is a new contract surface, wider than this fix. Failing closed already prevents a wrong figure.

### D6. Re-create the inventory mapping CHECK
A new migration drops and re-creates `inventory_sources_mapping_check`. Its definition is the same as before, with `marine_gas_oil` added to Mobile Combustion's list. The same change updates the constraint's hash in `runtime-role.mjs`. `boundary-schema-parity.spec.ts` then proves the SQL list matches the contract.
- **Why:** without it, the parity spec fails, and a holding's source list cannot map an MGO source, so the boundary would report MGO as unmapped.
- **Care:** a hand-written SQL migration. Any `prisma migrate dev` run beside it must have the spurious `DROP INDEX activity_records_reporting_entity_period_category_key` removed (CLAUDE.md).

### D7. Review gate before authoritative
The release file ships with `status: authoritative` and `reviewedBy: "TonyAI Sustainability Team"`. The PR records the owner's approval in the status file's Decisions log and adds the MGO values to the D24 external-review list for G4. Until that entry exists, the PR is not merged.

## Risks / Trade-offs

- [The extracted value is misread from the PDF] → a second reader, the builder spec's CO2 cross-check, and the D24 external review before G4. A rejection is an erratum edition (ordinal 3, `--supersedes`).
- [Two live IPCC releases confuse a reader of the factor library screen] → both are listed by edition. The MGO edition's title and notes say "supplementary: marine gas oil".
- [A future TR erratum overlaps MGO by accident] → the loader's overlap rule refuses it at dry run.
- [A user enters the fuel of a vessel it charters but does not operate as Scope 1, or leaves out an operated bareboat charter] → boundary copy on the form names both cases (operational control). This is the reporter's responsibility under the GHG Protocol and is out of the system's control.
- [The ocean-going ships CH4/N2O row overstates inland or harbour craft] → an accepted simplification for the pilot. It is stated in the methodology and in `calculation_logic.md`.

## Migration Plan

1. Merge with the release file, the migration, tests, contract and UI. Merging deploys to QA and applies the migration there (QA deploy policy). The integration tests load the new edition after the TR releases (`tr-releases.ts`); `pnpm setup` and the seed load neither.
2. Owner, on hosted QA (where the TR IPCC release, ordinal 1, is already loaded) and on any new database AFTER `tr-2026-11/ipcc.json`: build, dry run, read the report (no overlap, no supersession, 12 rows), then `--apply --allow-remote`, following the factor-release-import skill.
3. **Rollback:** withdraw the MGO edition with the loader (a withdrawal, not a delete). Records priced from it keep their snapshots. New MGO records answer `no_factor`. The UI type can stay, since it fails closed.
