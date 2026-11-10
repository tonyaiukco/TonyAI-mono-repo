# Proposal

## Why

UAT round 2 (BUG-R2-11) found no Marine Gas Oil (MGO) option under Mobile Combustion, so a pilot holding that operates its own vessels cannot record their fuel. The owner decided on 2026-11-10 (K6) that MGO is needed in the pilot. The reviewer-signed TR factor package (`docs/md_docs/Revision MD.md`) has no marine fuel, and it cannot be edited. MGO therefore needs its own sourced edition.

## What Changes

- **New factor edition:** a supplementary IPCC release, ordinal 2, with its own edition label. It carries MGO factors for TR and reporting years 2024, 2025 and 2026, with one row per gas (CO2e, CO2, CH4, N2O). Every value comes from the IPCC 2006 Guidelines, Vol. 2 Energy: the water-borne navigation emission factors (Ch. 3, §3.5) and the default net calorific value for gas/diesel oil (Ch. 1). It uses the AR6 GWPs that the TR package applies to combustion CH4 and N2O. The edition does not supersede the TR package and does not overlap its coverage. The TR package and its source document stay unchanged.
- **Mass basis:** MGO is priced per kilogram (kgCO2e/kg). No density is used, because marine fuel is delivered and invoiced by mass (Bunker Delivery Note).
- **New activity type:** `marine_gas_oil` under Mobile Combustion. Its TR and EN labels must not be confused with the existing stationary `gas_oil` (UK red diesel).
- **Tonnes input:** Mobile Combustion accepts `tonnes`. The existing definitional conversion (1 t = 1,000 kg) applies. A non-MGO mobile record entered by mass still finds no factor and fails closed, as it does in `kg` today.
- **Boundary copy:** the form states that MGO covers vessels the organisation owns or operates (Scope 1), an operated bareboat or demise charter included. Vessels chartered but not operated (voyage or time charter) and third-party shipping are Scope 3 and outside the pilot.
- **Review:** `reviewedBy` is "TonyAI Sustainability Team", as for the TR package. The owner's approval is recorded in the status file's Decisions log. The MGO values join the list the external carbon reviewer (D24) checks before G4.

Not in this change: loading the edition on hosted QA (an owner-run `--apply`), other marine fuels (HFO, VLSFO, LNG as bunker), litre-based MGO, distance-based marine activity, and Scope 3 shipping.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `emission-factor-library`: the library also holds a supplementary IPCC MGO edition, sourced directly from IPCC 2006 and not from the TR package document.
- `emission-calculation`: a TR mobile record may name MGO, priced per kilogram from the MGO edition, besides the five per-litre vehicle modes.
- `activity-data-entry`: the form and the bulk template offer MGO and the `tonnes` unit for Mobile Combustion, with TR and EN labels and the Scope 1 boundary note.

## Impact

- **Factor data:** a new release file and its builder beside `packages/db/factor-releases/tr-2026-11/`, checked by `validateFactorReleaseImport` and loaded through the factor-release loader (dry run first). Nothing in `ipcc.json`, `etkb.json` or `Revision MD.md` changes.
- **Contract:** `@tonyai/shared-types` gains the `marine_gas_oil` activity type and `tonnes` in Mobile Combustion's units.
- **Data:** one migration re-creates the inventory boundary's `inventory_sources_mapping_check`, which spells out the typed categories' activity types in SQL, so a holding's source list can map an MGO source. No table or column changes. Stored rows are not rewritten.
- **API:** no new endpoint. The single factor lookup (`factor-lookup.ts`) resolves the new key unchanged. The integration-test release loader (`apps/api/test/int/tr-releases.ts`) loads the new edition as well.
- **Web:** Data Entry type and unit options, TR and EN catalogues, and the boundary help text.
- **Docs:** `docs/md_docs/calculation_logic.md` (MGO method), the status file's Decisions log and ledger.
- **Operations:** the hosted QA load is a separate, owner-run step after merge.
