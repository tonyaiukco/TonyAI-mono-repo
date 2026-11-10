# Tasks

## 1. MGO release file and its review record

- [x] 1.1 Extract the MGO inputs from the published IPCC 2006 Vol. 2 PDF with the `data-factors` agent: CO2 from Ch. 3 Table 3.5.2 (gas/diesel oil), CH4 and N2O from Ch. 3 Table 3.5.3 (ocean-going ships), and the default NCV for gas/diesel oil from Ch. 1 Table 1.2. Record the table, row and page of each value. Verify by having a second, independent reader (a fresh agent given only the PDF and the table references) reproduce the same values, and quote both readings in the PR description.
- [x] 1.2 Create `packages/db/factor-releases/tr-mgo-2026-11/build.mjs` and the `factor-releases:tr-mgo` script in `packages/db/package.json`, following `tr-2026-11/build.mjs` (design D2, D3). The builder writes `ipcc-mgo.json`: publisher IPCC, ordinal 2, its own edition label, `status: authoritative`, AR6, `reviewedBy: "TonyAI Sustainability Team"`. Rows cover `marine_gas_oil` × TR × 2024–2026 × CO2e/CO2/CH4/N2O, as `kgCO2e/kg` on `kg`, `calorificBasis: not_applicable`. Each row's `source` cites the IPCC tables and its `methodology` states the formula with its numbers. Verify that `pnpm --filter @tonyai/db factor-releases:tr-mgo` writes the file and that a second run leaves it byte-identical.
- [x] 1.3 Add `tr-mgo-2026-11/build.spec.mjs` asserting: the file is what the build writes; it passes `validateFactorReleaseImport` with no issue; 12 rows; per-gas rows sum to each CO2e row; CH4 and N2O use 27.0 and 273; CO2 equals the gas/diesel oil value already in the TR package's diesel rows (74,100 kg/TJ, the extraction cross-check); and no `source` cites `Revision MD.md`. Verify with `pnpm --filter @tonyai/db test`.
- [x] 1.4 Record the owner's approval of the MGO edition (K6, 2026-11-10, and the values from 1.1) in the status file's Decisions log, and add the MGO values to the D24 external-review list for G4 (design D7). Verify that the entry names the edition label and the source tables.

## 2. Contract and database

- [x] 2.1 In `@tonyai/shared-types`, add `marine_gas_oil` ("Marine gas oil (MGO)") to Mobile Combustion's activity types and `tonnes` to `CATEGORY_UNITS['Mobile Combustion']` (design D5). Verify with `pnpm typecheck` and the shared-types tests.
- [x] 2.2 Extend `offeredActivityTypes` to offer the five vehicle modes plus `marine_gas_oil` under the TR rules. Give `unitsForRecord` an optional activity-type argument: TR MGO gets `kg` and `tonnes`, and a TR vehicle mode keeps `litres` only. Extend `apps/web/lib/record-inputs-view.spec.ts` with both cases and the unchanged UK lists. Verify with the web Vitest run.
- [x] 2.3 Add a migration that drops and re-creates `inventory_sources_mapping_check` as it last stood, with `marine_gas_oil` added to Mobile Combustion's list (design D6). Update the constraint's definition hash in `packages/db/scripts/runtime-role.mjs`. Inspect the generated SQL for a spurious `DROP INDEX activity_records_reporting_entity_period_category_key` and delete it. Verify that `pnpm db:migrate` applies locally and that `boundary-schema-parity.spec.ts` and `runtime-role.spec.mjs` pass.

## 3. Calculation proof

- [x] 3.1 Make `apps/api/test/int/tr-releases.ts` load the MGO edition beside the two TR releases. Run the loader dry run on the local database (`pnpm --filter @tonyai/api factor-release load --file=<ipcc-mgo.json> --operator=<role>`). Verify that its report shows IPCC ordinal 2, 12 factor rows, no overlap and no supersession, then `--apply` locally and confirm that a re-run answers `already_loaded`.
- [x] 3.2 Add an integration spec for MGO through the engine. It covers: 12.5 t and 12,500 kg give the same kgCO2e, with the expected value computed in the test from the cited table values, not from the builder; the snapshot names the MGO edition, its rows' source and methodology, and the tonnes-to-kg conversion; MGO in litres → `no_factor`; MGO for 2027 → `no_factor` (not 2023, which the e2e fixture holds); on-road diesel in kg and in tonnes → `no_factor`. Verify with `pnpm --filter @tonyai/api test:int`, with the TR package's golden-value specs still green beside the second IPCC release.
- [x] 3.3 Document the MGO method in `docs/md_docs/calculation_logic.md`: mass basis, formula, sources, the ocean-going ships simplification and the Scope 1 boundary. Verify that the formula and table references match the builder.

## 4. Data Entry, bulk and copy

- [x] 4.1 In `apps/web/app/data-entry/page.tsx`, pass the selected activity type to `unitsForRecord`, re-narrow the unit when the type changes (preselect `kg` for MGO and `litres` for a vehicle mode), and show the Scope 1 boundary note for MGO. Use the `localise-ui` skill for the TR and EN catalogue entries: the MGO label must differ from the Fuel `gas_oil` label and must not read as kerosene. Verify with the catalogue parity tests and in the browser on the local stack (TR and EN).
- [x] 4.2 Confirm that the bulk template lists `marine_gas_oil` and `tonnes` for Mobile Combustion from the shared lists. Add a `bulk-upload.service.spec.ts` case where a Mobile Combustion / `marine_gas_oil` / `tonnes` row is accepted and priced like the form's record. Verify with `pnpm --filter @tonyai/api test`.
- [x] 4.3 Extend `e2e/data-entry-tr-inputs.spec.ts`: add an MGO row to its own TR-2023 fixture release (round values, labelled as a fixture), then pick MGO, see `kg`/`tonnes` and the boundary note, and save a calculated record. Update the fixture description in `docs/development/testing.md`. Verify with `pnpm e2e -- data-entry-tr-inputs`.
- [x] 4.4 Update `docs/api/endpoints.md` ("Data Entry's TR inputs") so that TR Mobile Combustion is one of the five vehicle modes in litres, or MGO in kg or tonnes. Verify that the text names the same helpers and units as the code.

## 5. Integration and review

- [x] 5.1 Run `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm --filter @tonyai/api test:int` and the affected e2e specs. Verify that all are green, and record the counts in the PR description.
- [x] 5.2 Run the fresh-eyes review before opening the PR: `security-rls`, `qa-auditor` and an `architect` contract review in parallel, on the branch diff (factor library, migration, shared-types contract). Each reviewer reports what it verified. Resolve or file every finding, and verify that the re-run checks from 5.1 stay green.
- [x] 5.3 Update the status file (Current status, ledger and Next up) with the change and its PR. Verify that no other status or roadmap file was created.

## Workflow follow-up

- Open the PR from a `feat/` branch with green CI. The owner merges it, and the merge deploys to QA and applies the migration.
- Owner, on hosted QA: build, dry-run, read the report, then `--apply --allow-remote` the MGO edition (factor-release-import skill).
- Archive the change after the merge and the hosted load are recorded.
