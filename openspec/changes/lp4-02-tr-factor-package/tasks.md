# Tasks

## 1. PR1: Source document, exception and decisions (docs only; the deploy skips it)

- [x] 1.1 Commit `docs/md_docs/Revision MD.md` unchanged as the package's signed original. Verify `git diff` shows only the added file and that its sha256 is recorded in the PR body.
- [x] 1.2 Add the language exception to `CLAUDE.md` ("Language (strict)") and to `AGENTS.md` (line ~31): the reviewer-signed factor package source document may stay in Turkish; everything derived from it is English. Verify both files name the same path and the 2026-11-05 decision.
- [x] 1.3 Planning file: add a Decisions 2026-11-05 entry covering:
  - TR only, the document as sole source, and the two values accepted as written;
  - the contradictions resolved, the ETKB data years and the leak-rate alternatives;
  - internal reviewers instead of D24 and `reviewedBy`, and the §5 goldens as the gate;
  - the language exception;
  - "QA deploy" re-enabled 2026-11-05 with merges deploying freely. This changes Decisions 2026-11-04 (4): the drill becomes same-image only once a migration deploys.

  In `close-l10-hosted-acceptance`, update tasks 8.2–8.4 and runbook 11's L10 section to match:
  - the freeze is lifted;
  - QA findings are mapped to the release live when each was found;
  - 8.4 is the drill unless a migration-free ci5 deploys first.

  Update the LP4-02 ledger row, Current status and Next up within the ten-entry cap. Verify the ten-entry and verbatim-archive rules hold.
- [x] 1.4 Commit this OpenSpec change. Verify `openspec validate lp4-02-tr-factor-package` passes. Open the PR for Codex review; the owner merges.

## 2. PR2: Contract and migrations (deploys to hosted QA on merge)

- [x] 2.1 Add `IPCC` and `ETKB` to `FACTOR_PUBLISHERS`. In one new migration, drop and re-add `factor_releases_publisher_check`; update its md5 pin in `runtime-role.mjs`. Remove `testPublishers` from `validateFactorReleaseImport` and its callers, moving the fixture specs onto a registered or internal publisher. Verify the parity spec in `factor-library.spec.ts` passes and that an unregistered name is refused by both the validator and the database.
- [x] 2.2 Contract catalogue:
  - Fuel: `petrol`, `coal`, `lng` and the `kg` unit.
  - Mobile Combustion: the five mode types.
  - Refrigerants: `HFC-227ea`, `SF6` and `R-22`; replace the HCFC exclusion comment with the 2026-11-05 decision.
  - The `Fugitive Gas` category (Scope 1, implicit `gas_network_leakage`, `standard_cubic_metres`).
  - Unblock `standard_cubic_metres`.

  Update `INVENTORY_CATEGORIES`. Verify `factor-model.spec.ts` and the shared-types specs pass.
- [x] 2.3 In the same migration, re-create `activity_records_scope_check`, `inventory_sources_mapping_check` and the two inventory category CHECKs with the new values, and update their md5 pins. Verify `boundary-schema-parity.spec.ts`, `record-checks.spec.ts` and `runtime-role.mjs check` pass on a freshly migrated local database.
- [x] 2.4 Add the `factor_parameters` table under the release seal, with the loader-only INSERT grant, a runtime SELECT grant, RLS consistent with the other factor tables, and an entry in `runtime-role.mjs`. Extend the import contract with `parameters[]` and the validator rules (registered keys, units, one default per subject, an alternative only where one is defined). Verify:
  - integration tests show that an insert into a sealed release is refused;
  - a withdrawal covers the release's parameters;
  - the validator refuses a malformed parameter.
- [x] 2.5 Add the record `parameters` column with a shape CHECK, the shared type, and the create/update DTOs with class-validator rules per category (D3). Writes stay audited. Verify DTO specs cover both the natural gas exclusivity and the required refrigerant fields, and that an audit row is written on a parameter change.
- [x] 2.6 Loader: refuse an overlapping live edition of the same publisher that does not supersede it (D8). Verify `factor-release-loader.int.spec.ts` gains the overlap refusal and the supersede success.
- [x] 2.8 Report dataset schema 2 (D10): the version, the literal per-version categories, the required argument, the CHECK and its pin. Verify schema 1's fingerprints are the exact old values, schema 1 stays final, a new capture of an old confirmed version is partial with the gap named, and a relabelled or unknown version is refused.
- [x] 2.9 Refuse non-null parameters in the API until PR3 (D3), and drop `installedCapacityKg` in favour of the `kg` activity value (D7), in the type, the DTO, the CHECK and its pin. Verify create and update refuse before any write, null and absence pass, and the CHECK refuses a capacity field and a figure a double cannot hold. PR3 replaces this shape with `equipment[]` (3.3).
- [x] 2.10 Parameter contract (D2): `reference_ncv`, one unit per key, a rate of at most 1, positive values and a default beside an alternative. Verify the validator refuses each. Verify the loader writes parameters in its transaction and compares them on a re-run, and that one of two concurrent overlapping loads wins.
- [x] 2.11 Catalogue labels the typed contract requires at once: Fugitive Gas and the new activity types in the web and report catalogues, TR and EN. Verify `messages.spec.ts`, `context.spec.ts` and `report-vocabulary.spec.ts`. PR4's 4.3 keeps the rest, and the wording goes to the owner's Turkish review.
- [x] 2.7 Run `pnpm typecheck`, `pnpm build`, `pnpm test` and `pnpm --filter @tonyai/api test:int`, plus the `security-rls`, `qa-auditor` and `architect` review pass on the diff. Verify all are green and every blocker is fixed or answered in the PR.

## 3. PR3: Engine and snapshot V3

- [ ] 3.1 Add `CalculationResultV3` (D4) and the reader union. V2 stays frozen. Verify:
  - the issuance gate's pinned fingerprints still pass;
  - a V2 fixture round-trips unchanged;
  - `readRetainedDataset` accepts both versions.
- [ ] 3.2 Natural gas chain (D5): the per-record NCV, the billed-GCV correction (8,250 and 9,155 read from the release parameters; the validator refuses a conversion row that disagrees with `reference_ncv`, and an unedited NCV is sent as null) and the metered-m³ volume correction step. The kWh entry is still refused. Verify unit specs cover:
  - the default, edited and GCV-derived multipliers;
  - the refusal when both are given;
  - the refusal for m³ without a factor;
  - kWh refused with `calorific_basis_mismatch`;
  - the snapshot recording each input's origin.
- [ ] 3.3 Refrigerant capacity method (D7): replace PR2's single-equipment shape with `equipment[]` in the type, the DTO and a new migration re-creating the shape CHECK with its pin (also with an upper bound, so `1e400` cannot reach the engine as Infinity). Annual only, the activity value equal to the sum of capacities, NULL parameters refused for TR at create and submit. The default or alternative leak-rate parameter and the term breakdown go in the snapshot. Verify specs cover two equipment types of one gas, a non-annual period refused, a sum mismatch refused, the default and alternative rates, refill only, capacity only, and an equipment type without an alternative refusing `alternative`.
- [ ] 3.4 Include `parameters` in the K11 staleness comparison and in bulk submit. Verify `calculation-staleness.int.spec.ts` shows that a changed parameter makes a draft stale and an unchanged one does not.
- [ ] 3.6 Remove PR2's parameters gate: delete `record-parameters-gate.ts`, its `vi.mock` and its specs. Treat a stored `{}` or all-null object as no difference from NULL for staleness, and compare `parameters` by value, since `sameEngineInputs` uses `===`. Verify a parameter reaches the snapshot through the API, and that a retained V2 dataset still issues.
- [ ] 3.5 Update `calculation_logic.md` and README for the chain, the capacity method and V3. Run the full checks and the three-seat review pass. Verify all are green and the docs match the code.

## 4. PR4: Data Entry and bulk upload

- [ ] 4.1 Data Entry form:
  - the mobile mode select;
  - Fuel kg;
  - the Fugitive Gas category;
  - natural gas NCV (prefilled 8,250, editable), billed GCV (mutually exclusive) and the volume correction factor for m³;
  - refrigerant equipment lines (type, capacity, refill) on an annual period, the total shown as the record's quantity, and accepting a refill-only record (`data-entry/page.tsx` requires a value above 0 today), with the default rate shown and the alternative offered only for split air conditioners and chillers.

  Use `useDecimalInput` for every new number. Verify web specs cover the field visibility rules and Turkish decimal parsing, and the preview's conversion note shows the effective NCV.
- [ ] 4.2 Bulk upload: optional parameter columns (one file row per equipment line, combined into the gas's one annual record), the template workbook and the dry-run echo of the values read. Verify bulk specs accept valid rows, refuse invalid parameter combinations with row-level errors, and show the values read.
- [ ] 4.3 TR/EN catalogues for every new label and error (`localise-ui`). Verify `messages.spec.ts` passes and no key is missing in either language. List the new TR strings in the PR for the owner's Turkish review.
- [ ] 4.4 E2E: one Playwright flow per new form (natural gas with GCV, refrigerant with the alternative rate, mobile mode, leakage) against the local stack, using the fixture publisher. Verify `pnpm e2e` passes for the new specs.

## 5. PR5: TR releases, golden values and the Scope 2 label

- [ ] 5.1 Write the build script that derives both release files (IPCC and ETKB, D1) from the document's values, including `reference_gcv` and `reference_ncv`. Each row carries its `source` (document section) and its `methodology` (arithmetic); `reviewedBy` is "TonyAI Sustainability Team". Verify:
  - the script's output matches D6's table to six decimals;
  - the loader dry run reports no issue for either file.
- [ ] 5.2 Golden integration tests: load both releases into a test database through the loader and calculate the §5 rows, all within ±0.5%:

  | Source | Expected kgCO2e |
  |---|---|
  | Electricity 2025 | 1,814.36 |
  | Electricity 2024 | 1,847.81 |
  | Electricity 2026 | 1,814.36 |
  | Natural gas with billed GCV | 140.37 |
  | Natural gas, default NCV | 193.83 |
  | On-road petrol | 36,864.62 |
  | On-road diesel | 10,090.24 |
  | Leakage | 1,632,467.22 |
  | FM200 | 2,880.00 |

  Also verify that 2023 and UK are refused with `no_factor`, and that a committed placeholder-era record is byte-identical after the load.
- [ ] 5.3 Reports: print a refrigerant's refill and term breakdown beside its total capacity. Label Scope 2 as location-based and print "No market-based result" in the PDF, Excel and CSV outputs, with TR/EN copy. Verify report specs and the issuance fingerprints are updated deliberately, with the fingerprint change explained in the PR.
- [ ] 5.4 Update README, the `factor-release-import` skill (parameters, overlap rule, TR publishers) and the planning file (LP4-02 DONE pending the hosted load). Run the full checks and the three-seat review pass. Verify all are green.

## 6. Hosted QA load (owner; only after L10 closes)

- [ ] 6.1 Provision the hosted loader login, dry-run both releases against hosted QA, and `--apply` on the owner's word. Verify `runtime-role.mjs check` passes, `GET /api/v1/factors` lists both releases as authoritative, and a QA record for 2025 TR electricity shows 0.434 kgCO2e/kWh. Record the receipt without secrets.

## Workflow follow-up

- After 6.1, mark LP4-02 DONE in the planning file and run `/opsx:archive lp4-02-tr-factor-package`.
