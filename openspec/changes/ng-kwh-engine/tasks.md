# Tasks

## 1. Contract and resolver (shared-types)

- [x] 1.1 In `packages/shared-types/src/index.ts`:
  - add `CvBasis = 'net' | 'gross'` with `CV_BASES`;
  - add `cvBasis?: CvBasis | null` to `NaturalGasRecordParameters`;
  - add an optional `directBasis` to `resolveFactorPath`'s input, which replaces `directCalorificBasisFor` only when given and then builds no conversion path, whatever conversions are passed (design 1);
  - update the `parameters_required` comment in `CALCULATION_REFUSAL_CODES`.

  In `factor-model.spec.ts`, add four cases:
  - a net kWh factor resolves directly with `directBasis: 'net'`;
  - a gross-only library still answers `calorific_basis_mismatch`;
  - with `directBasis` and a **non-empty** on-basis conversion list whose factor is reachable only through a conversion, no conversion path is chosen: the result is the direct path when one exists, else a refusal;
  - the default without the field is unchanged, and the :870 assertion stays. Verify: `pnpm --filter @tonyai/shared-types test` and `pnpm typecheck` pass.
- [x] 1.2 Add the sentence selector `input` for `parameters_required` to `API_ERROR_PARAMS` and `API_ERROR_SENTENCE_SELECTORS` (design 4), following the `localise-ui` skill. Add `errors.variants.parameters_required.cvBasis` to `apps/web/messages/{en,tr}/errors.json`. Verify: the shared-types registry specs and the web catalogue parity spec pass, and `apps/web/lib/i18n/errors.spec.ts` shows the gas sentence for `input: cvBasis` and the refrigerant sentence for `input: equipment`.
- [x] 1.3 Add the bulk column constants (design 5):
  - `BULK_GAS_BASIS_COLUMN = 'cvBasis'`, added to `BULK_UPLOAD_COLUMNS`;
  - `BULK_GAS_INPUT_COLUMNS`, the numeric columns plus the basis column;
  - `BULK_GAS_PARAMETER_COLUMNS` stays numeric.

  In the same commit, add `dataEntry.bulkColumns.cvBasis` to `apps/web/messages/{en,tr}/dataEntry.json`, because `COLUMN_LABEL` is typed on `BulkUploadColumn`. Verify: `index.spec.ts` column specs pass, `pnpm typecheck` passes for web as well, and `apps/web/lib/i18n/messages.spec.ts` ("factor web consumer vocabularies") passes in both locales.

## 2. Database shape

- [x] 2.1 Add a migration that redefines `activity_records_parameters_check`. In the Natural Gas branch, `cvBasis` joins the key list, with the existing `CASE COALESCE(jsonb_typeof(...), 'null')` pattern: a string must be `net` or `gross`, a JSON null passes, and anything else fails (design 3). Copy every other branch verbatim from `20261106120000_lp4_02_equipment_parameters`. Generate it, inspect it, and delete any spurious `DROP INDEX activity_records_reporting_entity_period_category_key`. Verify: `pnpm db:migrate` applies cleanly on a reset local database. *Result: applied with `pnpm db:deploy` to the running local database, which other worktrees share and so was not reset; the diff against the previous definition is only the `cvBasis` key and its branch. CI's migrate jobs run it on a fresh database.*
- [x] 2.2 In `apps/api/test/int/record-write-guards.int.spec.ts`, add direct-write cases:
  - `cvBasis` `net`, `gross` and JSON `null` are accepted;
  - `lower`, a number, a boolean and an object are refused;
  - the existing gas and refrigerant cases still hold.

  Verify: `pnpm --filter api test:int -- record-write-guards` passes.
- [x] 2.3 Re-pin `activity_records_parameters_check` in `INTEGRITY_CHECKS` (`packages/db/scripts/runtime-role.mjs` :1029) to the md5 the runtime-role verification reports on a freshly migrated database. Verify: `runtime-role.int.spec.ts` and `packages/db/scripts/runtime-role.spec.mjs` pass, and the runtime-role verification against the migrated local database reports no CHECK difference.
- [x] 2.4 Update `docs/architecture/data-model.md` (`activity_records.parameters`: the calorific basis). Verify: the doc names `cvBasis` and its two values.

## 3. Engine

- [x] 3.1 In `record-parameters.dto.ts`, add `cvBasis` (`@IsOptional @IsIn(CV_BASES)`) to `NaturalGasParametersDto`. Extend `activity-record-write.dto.spec.ts`: `net`, `gross` and `null` pass, and `lower` and `1` fail with `record_parameters_invalid`. Verify: `pnpm --filter api test` passes.
- [x] 3.2 Make `directBasis` a direct-only lookup (design 1). Thread it through `lookupFactorPath` and the service wrapper. In `candidates()`, issue no `unitConversion.findMany` when it is set, in the pricing pass and the diagnostic pass, and hand the resolver `conversions: []`. Add lookup specs:
  - a direct-only lookup that is priced calls `unitConversion.findMany` zero times;
  - a direct-only lookup that is refused, and so diagnosed, calls it zero times;
  - a lookup without the field calls it as before.

  Verify: the new specs pass, and the existing lookup specs pass unchanged.
- [x] 3.3 Add `naturalGasEnergyChain` to `tr-rules.ts` (design 2):
  - `net` gives multiplier 1, with no inputs and no rows;
  - `gross` gives `reference_ncv / reference_gcv`, with a `grossToNetRatio` input (`derived`) and both rows;
  - a ratio that is not finite or not strictly between 0 and 1 → `parameter_missing`, with a message naming the pair.

  Add unit specs for each branch. Verify: `pnpm --filter api test -- tr-rules` passes.
- [x] 3.4 In `calculations.service.ts`:
  - `assertTrGasUnit` takes the parameters and applies design 3's order;
  - for TR gas in kWh or MWh, `compute` looks up in the entered unit with `directBasis: 'net'`, reads the rows from `factor.release.id`, prices `normalize(value, unit)` × the chain multiplier, and records `conversionFactor` / `conversionBasis` with `conversion: null`;
  - the Sm³ and m³ branch is untouched.

  Verify: typecheck passes, and `git diff` shows no change inside the Sm³/m³ branch. Behaviour is proven by 3.5 and 3.6.
- [x] 3.5 Replace `calculations.service.spec.ts`'s "refuses kWh/MWh … gross" case and add cases:
  - GV-NG-kWh-A 202.16 kg (±0.5%);
  - GV-NG-kWh-B 182.17 kg (`toBeCloseTo` ±0.01) with the 181.0–182.8 band checked separately;
  - 1 MWh gross 182.17 kg;
  - GV-NG-kWh-C 193.83 kg against GV5 within ±0.5%;
  - net is priced with no Sm³ conversion in the library, while Sm³ is refused `no_conversion`;
  - a gross-only factor → `calorific_basis_mismatch`;
  - a missing `cvBasis` → `parameters_required` with `params.input = 'cvBasis'`;
  - ncv, billed GCV or volume factor on kWh → `parameters_not_applicable`;
  - `cvBasis` on Sm³ → `parameters_not_applicable`;
  - UK kWh with `cvBasis` → `parameters_not_applicable`, and UK kWh without it priced as before;
  - therms and GJ → `calorific_basis_mismatch`;
  - a gross release lacking `reference_gcv` → `parameter_missing`, while net is still priced;
  - the rows are read from the factor's release.

  Verify: `pnpm --filter api test` passes. Mutation check: reverting the override, or the ratio, fails at least one case each.
- [x] 3.6 Snapshot stability: assert that a GV5 Sm³ and a GV4 billed-GCV snapshot are deep-equal to fixtures captured from `main` before 3.4. Verify: the case passes, and it fails if the Sm³ branch's inputs or rows change.
- [x] 3.7 In `apps/api/test/int/tr-factor-package.int.spec.ts`, add GV-NG-kWh-A, B, C and MWh gross against the real `tr-2026-11` release. Keep "committed records byte-identical" green. Add one `cvBasis: null` case each on POST and on PATCH, through the real record service and database:
  - an Sm³ record is created or updated, priced, and its row passes the CHECK;
  - a kWh record answers 400 `parameters_required`;
  - neither answers 500. Verify: `pnpm --filter api test:int -- tr-factor-package` passes, or CI's `api-integration` passes if the local rate limiter blocks it (Open questions).

  *Result: the golden vectors are in `tr-factor-package.int.spec.ts` (19 pass). The `cvBasis: null` cases run in `calculation-staleness.int.spec.ts`'s TR block, which already holds a TR tenant and the real record service: Sm³ create and PATCH are stored, kWh create and PATCH answer `parameters_required`, none a 500. A gross kWh bill also submits fresh (25 pass).*
- [x] 3.8 Update the docs:
  - `docs/md_docs/calculation_logic.md`: the "Natural gas in Türkiye" paragraph describes the kWh/MWh path, the ratio, and that therms and GJ are refused;
  - `docs/api/endpoints.md`: the TR inputs at :108, the refusals at :122, and the resolver note at :124.

  Verify: `grep -n "kWh" docs/api/endpoints.md` shows no line calling TR gas kWh refused.

## 4. Bulk upload

- [x] 4.1 In `bulk-upload/record-inputs.ts`:
  - have `gasParametersOf` read `cvBasis` (trim, lower-case), and refuse values other than `net` or `gross` as `invalid` with both values named;
  - check `BULK_GAS_INPUT_COLUMNS` with `firstFilled` in both `gasParametersOf`'s other-category refusal and `equipmentOf` (:210), so the basis is refused wherever a numeric gas column is.

  Add `bulk-upload.service.spec.ts` cases:
  - a TR kWh `GROSS` row is accepted at 182.17 kg in the dry run, and the import stores `gross`;
  - an empty basis on a kWh row → `invalid` with the gas message, not `no_factor`;
  - `brut` → `invalid`;
  - an Electricity row with `cvBasis` → `invalid`;
  - an otherwise valid grouped refrigerant equipment line with `cvBasis` → `invalid`, and the record is not written;
  - a dry run persists nothing.

  Verify: `pnpm --filter api test -- bulk-upload` passes.
- [x] 4.2 Add the `cvBasis` reference row to `template-workbook.ts`'s "Calculation inputs (Türkiye)" section, and extend `template-workbook.spec.ts` to assert it. Update `docs/api/endpoints.md` :106: eight optional columns, with the basis column described. Verify: the template spec passes.
- [x] 4.3 In `apps/web/lib/bulk-upload-view.ts`, have `readInputsLabel` echo the basis first, as a translated word: add `dataEntry.inputs.cvBasis.{net,gross}` (EN net / gross; TR net / brüt) and widen `InputsKey`. Extend `bulk-upload-view.spec.ts`:
  - a gross kWh row reads "gross" in EN and "brüt" in TR;
  - an Sm³ row's echo is unchanged.

  Verify: `pnpm --filter web test` and web typecheck pass.

## 5. Data Entry keeps a stored basis

- [x] 5.1 In `apps/web/lib/record-inputs-view.ts` (design 6):
  - `recordInputMode` returns `natural_gas_energy` for a TR natural gas record in kWh or MWh;
  - `GasInputs` and `gasInputsFromRecord` carry `cvBasis`;
  - `gasParameters` sends exactly `{ cvBasis }` in the energy mode when one is stored, and never sends `cvBasis` in the Sm³ or m³ mode.

  Add a pure helper for the leave-TR rule: it says whether to clear the quantity, given the previous and next input modes, the unit and the carried basis.

  Extend `record-inputs-view.spec.ts`:
  - a stored gross basis round-trips;
  - a kWh record without one sends `null`;
  - Sm³ never sends `cvBasis`;
  - `unitsForRecord('Natural Gas','TR')` is still Sm³ and m³;
  - leaving TR clears the quantity for `net` only, never for `gross` and never for Sm³.

  Verify: `pnpm --filter web test` passes.
- [x] 5.2 In `apps/web/app/data-entry/page.tsx` (design 6):
  - build `recordParameters` for the energy mode from the stored basis, so preview (:1029) and save (:1340, :1358) send it;
  - render a read-only basis line (`dataEntry.inputs.cvBasis.*`) and no editable field;
  - `startCopy` sets a copy tuple that `onOwnType` honours, so a copied kWh record keeps its unit and quantity instead of falling back to Sm³ (:1099);
  - when the leave-TR helper says so, clear the quantity and toast `inputs.basisReset` (TR/EN, `localise-ui`).

  Verify: web typecheck passes. In the browser:
  - an imported kWh draft shows the read-only basis and a working preview;
  - copying a voided kWh record keeps kWh, the quantity and the basis;
  - moving a net kWh draft to a UK site clears the quantity and shows the toast;
  - moving a gross one keeps it.

  *Result: checked in the browser by `e2e/natural-gas-energy-bill.spec.ts` (2 pass): an imported gross kWh draft shows the read-only basis and previews 0.18 t; a copied voided net kWh record keeps kWh, 1,000 and its basis; moving it to TonyAI Gas (UK) clears the quantity with the `basisReset` toast. That a gross figure is kept is pinned by `clearsNetEnergyQuantity`'s spec, not in the browser.*
- [x] 5.3 On the review sheet (`apps/web/app/review/page.tsx`), add a read-only "Calorific basis" row under the activity row when `parameters.cvBasis` is present (TR/EN). Add a web spec for the row's presence and wording, and its absence on an Sm³ record. Verify: `pnpm --filter web test` passes.
- [x] 5.4 Add an e2e case (`e2e-flow` skill, TR inputs fixture):
  1. import a TR natural gas kWh row with `cvBasis` `gross` through bulk upload;
  2. open the draft on Data Entry, check the read-only basis, and change an ordinary, always-visible field (an additional-context value, not the variance reason);
  3. attach an evidence PDF with the shared upload helper (Natural Gas requires one at submit), save, and submit from the form;
  4. open the record's review sheet as the consultant and read the basis line.

  Verify: the save and submit succeed; the saved figure equals the import's (180.00 kg on the fixture: 1,000 × 9,000/10,000 × 0.2), with `cvBasis` `gross`; and the review sheet shows "Gross". 182.17 kg stays asserted only in 3.7, against the real release.

## 6. Review, status and integration

- [x] 6.1 Run typecheck, lint, `pnpm build`, `pnpm test` and `openspec validate ng-kwh-engine --strict`. Verify: all pass.
- [x] 6.2 Against the running app:
  - POST a TR natural gas record of 1,000 kWh gross for 2025: expect 182.17 kg, the ratio in the snapshot and both rows cited;
  - POST it without `cvBasis`: expect 400 `parameters_required` with `params.input`;
  - POST it in therms: expect 422 `calorific_basis_mismatch`;
  - run a bulk dry run with one kWh row.

  Verify: the request and response pairs are recorded for the PR body.

  *Result (local API built from this branch, the real `tr-2026-11` release; previews and dry runs only, as the local database is shared): `POST /calculations/preview` TR 2025 1,000 kWh gross → 182.1718 kg, net 901.147 kWh, `conversion: null`, `grossToNetRatio` 0.901147 (derived), rows `reference_ncv` 8,250 and `reference_gcv` 9,155 of `TONYAI-EF-TR-UK-2026.11-AR6-SEALED`; `POST /activity-records` without `cvBasis` → 400 `parameters_required`, `params.input = cvBasis`; in therms → 422 `calorific_basis_mismatch` with `coverage`; bulk dry run: `GROSS` accepted at 0.18217 t, an empty basis `invalid` with the gas sentence, `brut` `invalid` on `cvBasis`, no batch written.*
- [x] 6.3 Run the fresh-eyes pass on the diff, in parallel (calculation path, migration and contract):
  - `security-rls`: the CHECK migration, its JSON-null rule and its re-pinned fingerprint, the CHECK's fail-closed behaviour, no tenant-scoping change, and the override reaching no other caller;
  - `qa-auditor`: the golden vectors, every refusal surface (API, bulk dry run, bulk submit, preview, refrigerant lines), `cvBasis: null` on POST and PATCH, the Data Entry pass-through, the copy flow, the leave-TR reset, the review sheet's basis line, and snapshot stability;
  - `architect`: the resolver override's API and its direct-only query, the sentence selector, and the bulk-column constants.

  Fix every correctness finding, and file the rest under Open questions. Verify: what each seat verified and found is recorded for the PR body.

  *Result: no blocker from any seat. Fixed:*
  - *`qa-auditor` S1 (data integrity): the leave-TR clear now drops the net basis with the figure, so a gross figure typed meanwhile is never priced as net on the way back. The e2e asserts it.*
  - *`qa-auditor` S2: the copy tuple carries the source's priced geography (`copyKeepsOwnUnit`, with a spec).*
  - *`architect` S1: reports name `grossToNetRatio`, and the appendix keys gross bills apart. The renderers are v5. A mutation of the key fails its spec.*
  - *`architect` S2: the spec sentence is limited to volume readings.*
  - *`architect` S3: a catalogue check over `PARAMETERS_REQUIRED_INPUTS`, and `satisfies ParametersRequiredInput` at both throwers.*
  - *Preview copy (`architect` N1 / `qa-auditor` S3): a gross-to-net note, and no "kWh to kWh" line.*
  - *Unused reference fetch (N2/N4), tighter types (N3), a misplaced doc block (N7).*
  - *Tests: the preview DTO basis cases, a K11 stripped and flipped basis at submit and bulk submit, and 1 MWh gross to ±0.01 kg in the integration spec.*

  *Filed under Open questions: a net figure moved off TR through the API, the ratio's plausibility band, a factor-only erratum dropping the reference rows, the CHECK's DROP/ADD window, the "Typed natural gas inputs are bounded" wording on energy units, `cvBasis` on therms (422), and older kWh drafts with no control until `ng-kwh-form`.*

  *`security-rls` verified:*
  - *the migration is expand-only, fail-closed, with branches byte-identical to the previous definition; smuggled values (case, whitespace, types, keys) are refused; the md5 matches the live definition;*
  - *the 404 still comes before the library, and `directBasis` has one caller;*
  - *params are registered, audit rows are untouched, and a rollback refuses rather than misprices.*

  *`qa-auditor` recomputed the golden vectors, ran the old engine against the inline snapshots (identical), and killed 8 of 8 mutations.*

  *`architect` found no Prisma drift and confirmed the md5 and that the bulk column order is read by name.*

  *After the fixes: e2e `natural-gas-energy-bill` 2 pass. The neighbours (`record-edit`, `data-entry-tr-inputs`, `review-shows-gas`, `bulk-upload-api`, `bulk-upload-xlsx`, `smoke`, `void-record`) 37 pass, run with CI's `RATE_*_PER_MINUTE` overrides.*
- [x] 6.4 Update `docs/roadmap_docs/project_status_roadmap_phases.md`:
  - a Current status entry, under the ten-entry rule;
  - Next up, item 4: change 3 of round 3 done;
  - the LP4-06 card's `ng-kwh-engine` box ticked;
  - the ledger row.

  Verify: Current status holds at most ten entries.

## 7. Second review (the owner's branch review, 2026-11-21)

- [x] 7.1 Finding 1: a natural gas unit change between energy and volume clears the quantity and the basis (`unitChangeClearsQuantity`, the unit select's handler, `inputs.dimensionReset`), and an opened or copied record's own unit stays listed (`ownUnit`). Verify: `record-inputs-view.spec.ts` and the e2e case "switching an imported kWh bill to Sm³" pass. *Result: pass.*
- [x] 7.2 Finding 2, web: the net-basis clear is a state checked once the geography is known (`clearsNetEnergyQuantity(category, mode, unit, basis)`), so an opened draft whose site was re-classified, or a copy under a non-TR subsidiary, is caught too. Verify: the helper's spec and the copy-to-UK e2e pass. *Result: pass.*
- [x] 7.3 Finding 2, API: `update` refuses with the new code `activity_value_reentry_required` (400) a stored NET bill moved to another site, category, unit or basis without `activityValue` (`inheritsNetBillQuantityElsewhere`). The code is registered, with TR/EN copy and an `api-error.spec` thrower. Verify: the unit spec and the `calculation-staleness` int case (a refused move, a refused switch to Sm³, the move with its quantity, a gross bill moving freely) pass. *Result: pass (int 27).*
- [x] 7.4 Finding 3: the report appendix keys a path by `factorId|conversionId|conversionBasis`, so kWh and MWh records, and net and gross bills, keep their own lines. Verify: the mixed-unit spec, in both orders, passes. *Result: pass; e2e `reports` green.*
- [x] 7.5 P3: the direct-only factor read keeps its own REPEATABLE READ batch (spec asserts it); `calorific_basis_mismatch` copy is basis-neutral (API, EN, TR); the design states the database guarantees only the value's shape, and covers the rollout window before an automatic rollback. The bulk panel's English row messages in Turkish are filed (Open questions): every bulk issue shows the server sentence, not only these. Verify: typecheck, lint (0 errors), unit tests, `openspec validate --strict`. *Result: api 3,962, web 1,336, shared-types 512, db 251; int 210 (four files); e2e 31 (`natural-gas-energy-bill` 3, `record-edit`, `data-entry-tr-inputs`, `void-record`, `reports`, `smoke`).*

- [x] 7.6 Re-review of the delta (`security-rls`, `qa-auditor`; a second design, the API's re-entry rule): no blocker. Fixed:
  - `security-rls`: `activityValue: null` skipped the re-entry rule (the DTO lets null through and the service inherits it); the guard now reads `== null`, with an int case;
  - both seats: unit spellings are compared as stored (`kwh` is `kWh`), with spec cases;
  - `qa-auditor` S1: `ownUnit` is refreshed on every save and cleared when the form leaves the record, so a unit the record no longer has is not listed;
  - `qa-auditor` S2: an e2e case opens a net kWh draft whose site was re-classified to UK: cleared on opening, one notice;
  - `qa-auditor` N1/N3: picking the own unit again brings back no basis (spec wording and e2e), and the narrowing effect drops a basis with the unit.

  Filed under Open questions: kWh↔MWh keeping the figure, `PATCH {activityUnit: null}` answering 500 (pre-existing), a site missing from the loaded list skipping the form check, the guard's net-only scope. Verify: typecheck, lint (0 errors), unit tests, int, e2e. *Result: api 3,966, web 1,336, shared-types 512, db 251; int 210; e2e 35 (`natural-gas-energy-bill` 4, `record-edit`, `data-entry-tr-inputs`, `locations`, `smoke`).*

## Workflow follow-up

- Branch `feat/ng-kwh-engine` (created). Commit and push on the owner's word. The owner merges, and the QA deploy runs on merge (one migration).
- If the QA rollout fails, the deploy's own rollback restores the previous images. A defect found after a successful deploy is fixed forward, because the on-demand QA rollback refuses a different migration chain (design, Migration Plan).
- Archive with `/opsx:archive`, syncing the `emission-calculation`, `activity-data-entry` and `record-lifecycle` deltas, then record the PR number.
- Next: `/opsx:propose ng-kwh-form` (LP4-06, second change).
