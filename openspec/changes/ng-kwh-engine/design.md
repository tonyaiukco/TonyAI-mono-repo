# Design

## Context

See `proposal.md` (Why) and `uat3-decisions/design.md` (D2, D3, the draft requirements). Checked on `main` at `26db565b` (2026-11-20).

- **The resolver cannot reach the net factor for a kWh record.**
  - `resolveFactorPath` (shared-types) asks `directCalorificBasisFor(category, unit)` for the basis a direct factor must have. For every fuel in an energy unit, that answer is `gross` (`BILLED_ENERGY_CALORIFIC_BASIS`).
  - The TR natural gas factor is `net`. So a kWh lookup finds it, marks `basisMismatch`, and answers `calorific_basis_mismatch`. `factor-model.spec.ts` pins this.
  - The decision record missed it: today's refusal is not only `assertTrGasUnit`.
- **The TR gas path today** (`calculations.service.ts` `compute`):
  - `assertTrGasUnit` refuses every unit except Sm³ and m³.
  - The lookup always runs in `standard_cubic_metres`, so it needs the Sm³ conversion.
  - `naturalGasChain` (`tr-rules.ts`) reads `reference_ncv`, `reference_gcv` and the billed range from the **conversion's** release.
  - Only the conversion's basis is checked. The factor's basis never is.
- **Where the rows live.** In `tr-2026-11/ipcc.json`, the net factor rows (2024–2026), the Sm³ conversions and the four reference parameters are all in **one release**. "The factor's release" and "the conversion's release" are the same rows today.
- **Parameters at the edges:**
  - `NaturalGasParametersDto` whitelists three numeric keys, so `cvBasis` is refused today.
  - `activity_records_parameters_check` (last defined in `20261106120000_lp4_02_equipment_parameters`) allows exactly those three keys for Natural Gas. It has no unit awareness, and neither does the DTO; unit rules live in the engine.
  - Bulk upload's `gasParametersOf` parses every `BULK_GAS_PARAMETER_COLUMNS` entry as a positive number.
- **The lookup always reads conversions.** `candidates()` (`factor-lookup.ts`) runs `unitConversion.findMany` beside the factor query on every lookup, in the pricing pass and in the diagnostic pass. That happens before the resolver is called.
- **Null parameters.** `normalizeRecordParameters` drops null fields for the engine. The record service still writes the caller's raw JSON. The CHECK tolerates that today only because every numeric gas key accepts a JSON `null`.
- **The CHECK is fingerprinted.** `INTEGRITY_CHECKS` in `packages/db/scripts/runtime-role.mjs` pins the md5 of `activity_records_parameters_check`. The runtime-role verification and `runtime-role.int.spec.ts` refuse any other definition.
- **Data Entry builds gas parameters only for Sm³ and m³.** `recordInputMode` returns `null` for a kWh record, so the form sends `parameters: null` on preview (`page.tsx` :1029) and save (:1340, :1358). An opened record keeps its own unit in the unit list (`unitOptions`).
- **Bulk columns reach the web's types.** `COLUMN_LABEL: Record<BulkUploadColumn, string>` is the EN catalogue's `bulkColumns`, and `messages.spec.ts` requires both catalogues to match `BULK_UPLOAD_COLUMNS`. `readInputsLabel` echoes only the three numeric gas keys. `equipmentOf` refuses gas columns on a refrigerant line through `BULK_GAS_PARAMETER_COLUMNS` alone.
- **Snapshot.** `SnapshotInput.value` is numeric. There is no engine-version constant, and `snapshotSchema` is 3. `compareSnapshots` treats any change in the stored output as stale, so the Sm³ path's output must not change by a byte.
- **Anomaly check.** It compares tCO2e across a series, so a site that moves from Sm³ to kWh keeps a comparable history. The first-period ceiling already has a natural gas kWh value: 2,500,000 kWh, with MWh at × 1,000.

## Goals / Non-Goals

**Goals:**
- Price TR natural gas in kWh and MWh on a stated basis, exactly as the spec delta says, with no effect on any Sm³, m³, UK or non-gas calculation.
- Make the basis choice impossible to skip through the API and the bulk file: the engine refuses a TR energy bill without one, on create, update and every recompute. The database CHECK guarantees only the value's shape (`net`, `gross` or JSON null), not that a TR energy record has one (review of the change).

**Non-Goals:**
- The Data Entry kWh option for a new record, the NET/GROSS control and the derived-net preview (`ng-kwh-form`). `unitsForRecord` stays Sm³ and m³ until then, so no screen offers a unit the form cannot complete. An imported kWh record is the one case the form must already carry (Decision 7).
- `GET /factors/parameters` keeps reading the Sm³ conversion's release. The rows are identical today; `ng-kwh-form` decides what the form reads for its ratio preview.
- The billed-GCV question for either unit (D3). It stays with the external reviewer.
- Therms and GJ.
- The coverage report and matrix. They still describe TR gas by its Sm³ path.
- `GET /factors/parameters` for the energy path: `ng-kwh-form`'s ratio preview needs it to resolve `(kWh, directBasis 'net')` and the factor's release (`architect` review), so that change takes it.

## Decisions

### 1. A direct-basis override on the resolver, set only by the TR gas energy path

`resolveFactorPath` and `lookupFactorPath` take an optional `directBasis`. When it is given, the lookup is **direct-only**:
- a factor must be in the base unit and on that basis;
- `candidates()` issues **no `unitConversion` query**, in the pricing pass and in the diagnostic pass alike, and still reads the factors in a REPEATABLE READ batch of its own (second review: Prisma reads a factor and its release in two statements, and a withdrawal between them would drop the factor chosen);
- the resolver receives `conversions: []`;
- the resolver itself builds **no conversion path** when `directBasis` is given, whatever conversions it is handed. The shared contract does not rely on its caller passing an empty list.

Without the field, `directCalorificBasisFor` decides as today, and both queries run. `compute` passes `'net'` only for a TR natural gas record in kWh or MWh.

- A net factor resolves directly, with no conversion row read.
- A gross-only library still answers `calorific_basis_mismatch`, which is what the spec requires. No separate factor-basis check is needed after resolution.
- A coverage scan, a UK kWh lookup and the Sm³ path never pass the field, so their results cannot change. `factor-model.spec.ts` adds the override cases, and its existing gross-default assertion stays. One case hands the resolver a non-empty, on-basis conversion list with a factor reachable only through it: with `directBasis`, the result is a refusal or the direct path, never that conversion path.
- A lookup spec asserts that `unitConversion.findMany` is never called for a direct-only lookup, priced or refused. It also asserts that a lookup without the field still calls it.

**Alternatives:**
- **Look up in Sm³ and divide out the conversion.** Rejected: it needs a conversion row the energy path does not use, and a missing row would answer `no_conversion` for a kWh bill.
- **Make `directCalorificBasisFor` geography-aware.** Rejected: it would change the answer for every TR caller, coverage included, and hide a rule that belongs to one path.

### 2. Its own chain in `tr-rules.ts`

`naturalGasEnergyChain(parameters, rows)` returns the same `{ multiplier, inputs, rowsUsed }` shape as `naturalGasChain`.

| `cvBasis` | multiplier | inputs | rowsUsed | reads release rows |
| :-- | :-- | :-- | :-- | :-- |
| `net` | 1 | none | none | no |
| `gross` | `reference_ncv / reference_gcv` | `grossToNetRatio` (`derived`) | both rows | yes |

- `reference()` already answers a missing row with `parameter_missing`.
- A ratio that is not finite or not strictly between 0 and 1 is a library defect and answers `parameter_missing`, with a message naming the pair. A new code was rejected: it would mean registry and catalogue churn for a state that the sealed release cannot reach.
- `compute` reads the rows from **`factor.release.id`**, as the refrigerant path already does, and never from a conversion, which this path has none of.
- The priced quantity is `normalize(value, unit)` (MWh → kWh, × 1,000) times the multiplier.
  - `conversionFactor` is the whole multiplier from the entered unit to net kWh;
  - `conversionBasis` names both steps;
  - `conversion` is `null`, which `isAuthoritativeSnapshot` already accepts.
- The Sm³ branch is not edited, so its snapshots stay byte-identical.

### 3. Parameter rules: the engine owns the unit rules; the DTO and CHECK own the shape

- **One rule for `null`: an explicit `null` is an absent basis, at every layer.** This is the rule the three numeric gas keys already follow.
  - **DTO.** `NaturalGasParametersDto` gains `cvBasis?: 'net' | 'gross' | null` (`@IsOptional` passes `null` and `undefined`; `@IsIn` checks a present value).
  - **Engine.** `normalizeRecordParameters` already drops `null`, so the engine sees no basis.
  - **Database.** A new migration redefines `activity_records_parameters_check`. The Natural Gas key list gains `cvBasis`, with the same `CASE COALESCE(jsonb_typeof(...), 'null')` pattern as the other keys: `'string'` → the value is `net` or `gross`; `'null'` → true; anything else → false. The refrigerant and `ELSE false` branches are copied unchanged.
  - **Fingerprint.** The same change re-pins the CHECK's md5 in `INTEGRITY_CHECKS` (`runtime-role.mjs`), measured from a freshly migrated database.

  The record service keeps writing the caller's JSON as it does, so a stored `{"cvBasis": null}` passes the CHECK and reads as absent. POST and PATCH both get a `cvBasis: null` case, in Sm³ (priced, stored, 2xx) and in kWh (400 `parameters_required`). Neither may end in a 500.

  **Rejected: stripping nulls before the write.** It would change what is stored, and audited, for the existing gas keys too, which is outside this change.
- **Engine.** The unit rules are checked in one place, `assertTrGasUnit`, which now takes the parameters. The order is:
  1. Sm³ inputs on kWh or MWh, or `cvBasis` on Sm³ or m³ → `parameters_not_applicable`;
  2. kWh or MWh without `cvBasis` → `parameters_required`;
  3. the existing Sm³ and m³ rules;
  4. any other energy unit → `calorific_basis_mismatch`.

  Inapplicable inputs are named before a missing one, so a record carrying both mistakes is told about the one that is wrong.
- **Rejected: a unit-aware CHECK** (referencing `activity_unit`). It would duplicate an engine rule in SQL that the CHECK has never held for the other gas inputs, and a record cannot be written without a successful calculation anyway.

### 4. `parameters_required` names what is missing: a sentence selector

The web sentence for `parameters_required` is refrigerant-only ("List the equipment for this refrigerant…"). The code gets a sentence selector `input` in `API_ERROR_PARAMS` / `API_ERROR_SENTENCE_SELECTORS`, the mechanism `variance_reason_required` uses:

| Thrower | `input` | Sentence shown |
| :-- | :-- | :-- |
| Refrigerant path | `equipment` | the code's own sentence, unchanged |
| Gas energy path | `cvBasis` | `errors.variants.parameters_required.cvBasis` (TR/EN): "state whether the energy figure is net or gross" |

The API's English `message`, which bulk upload shows as the row's message, says the same thing (`localise-ui` skill).

**Rejected: a generic sentence for both.** The refrigerant author would lose the guidance it gives today.

### 5. Bulk upload: a separate basis column, parsed as text

- `cvBasis` joins `BULK_UPLOAD_COLUMNS` as its own constant, `BULK_GAS_BASIS_COLUMN`, not inside `BULK_GAS_PARAMETER_COLUMNS`. That list is typed and looped as numeric by `gasParametersOf`, by the template and by the web's `bulk-upload-view` input echo, and a string entry would break all three.
- `gasParametersOf` reads it trimmed and lower-cased. It refuses anything other than `net` or `gross` as `invalid` with a message naming both values, and refuses it on another category through `notThisCategory`, as for the other gas columns.
- `equipmentOf` checks the basis column beside `BULK_GAS_PARAMETER_COLUMNS`, so a refrigerant equipment line that carries one is refused, never silently dropped. Both checks read one shared list, `BULK_GAS_INPUT_COLUMNS` = the numeric columns plus the basis column, so no third reader can miss it.
- **Web.**
  - `dataEntry.bulkColumns.cvBasis` is added to the TR and EN catalogues. `COLUMN_LABEL` is typed on `BulkUploadColumn`, and `messages.spec.ts` checks both catalogues against the column list.
  - `readInputsLabel` echoes the basis as a translated word (EN net / gross; TR net / brüt) before the numeric inputs, so the dry-run preview shows what the server read.
- A missing basis reaches the engine. Its `parameters_required` is a `BadRequestException`, so the row reads `invalid` with the gas message, never `no_factor`. That is why the decision record chose 400.
- The template's "Calculation inputs (Türkiye)" section gains a `cvBasis` row.

This deviates from the decision record's parenthetical "(`BULK_GAS_PARAMETER_COLUMNS`)", only in which constant holds the column. The behaviour is as drafted.

### 6. Data Entry carries a stored basis it does not yet show

Once this change ships, bulk upload can create TR kWh drafts, and Data Entry can open them before `ng-kwh-form` exists. As the form stands, it would send `parameters: null`, so every preview, unrelated edit and form submit of such a draft would be refused with `parameters_required`.

- `recordInputMode` gains a third mode, `natural_gas_energy`, for a TR natural gas record in kWh or MWh. In this change it renders **no editable field**, only a read-only line with the stored basis (net / gross, TR/EN), so the author sees what is sent.
- `gasInputsFromRecord` reads `cvBasis`. In the energy mode, `gasParameters` sends exactly `{ cvBasis }` when one is stored, and `null` otherwise. Without a stored basis, the API's `parameters_required` is the correct answer.
- Switching the unit to Sm³ or m³ drops the basis, since `gasParameters` sends it only in the energy mode. A category change resets the inputs as today.
- **Copy to new draft.** A copy opens as a new record (`editingId === null`), so `onOwnType` is false. The unit effect (`page.tsx` :1099) then replaces kWh with Sm³, the first unit `unitsForRecord` offers, and clears the quantity. That breaks the live requirement that a copy keeps the source's unit, value and inputs.
  - `startCopy` records the source's category, activity type and the geography its snapshot was priced under, as a copy tuple (`CopySource`).
  - `onOwnType` is also true while the form is still on that tuple (`copyKeepsOwnUnit`), so the source unit stays listed and is not reset. A copy moved across the TR rules is narrowed like a new record, as before (`qa-auditor` review: without the geography, a UK kWh copy moved to TR kept a unit the TR rules cannot complete, and a UK diesel copy kept a type TR does not offer).
  - `resetInputs(values.parameters)` already restores the inputs; with `gasInputsFromRecord` reading `cvBasis`, the basis is restored too.
  - The tuple is cleared on save and on a category or type change, as for an opened record.
- **Leaving the TR rules with a net figure.**
  - The trigger: the effective geography leaves the TR rules (another subsidiary or site, or a copy into one) while the unit is kWh or MWh and the carried basis is `net`.
  - Outside TR, `directCalorificBasisFor` prices a fuel's energy as gross (`BILLED_ENERGY_CALORIFIC_BASIS`), and no basis is sent. So the net quantity would be priced as if it were gross, about 10% low, with no refusal.
  - The form therefore clears the quantity and shows a toast asking for the bill's gross figure (`inputs.basisReset`, TR/EN), the pattern `inputs.unitReset` already uses.
  - A gross basis keeps the quantity, because gross is what the target prices.
  - A net basis is cleared **with** the quantity (`qa-auditor` review, data integrity). Kept, it would come back on a return to TR and price the gross figure typed meanwhile as net, about 11% high. After the return the API answers `parameters_required` until a basis is stated.
- **The preview names the step.** A gross bill's preview says it was reduced to net by the release's ratio (`preview.grossToNet`, from `grossToNetRatioOf`), and the "converted from kWh to kWh" line is no longer shown when the unit did not change.
- **A state, not a move (second review).** The net-basis clear is a condition the form checks once the geography is known, not a transition it watches: an opened draft whose site's geography changed since, or a copy placed under a non-TR subsidiary, is caught too (`clearsNetEnergyQuantity(category, mode, unit, basis)`).
- **Energy and volume do not share a number (second review).** A natural gas unit change between kWh/MWh and Sm³/m³ clears the quantity and the basis (`unitChangeClearsQuantity`, the select's handler); before, 1,000 kWh became 1,000 Sm³, about ten times the figure. The opened or copied record's own unit stays listed while the form is on its own type (`ownUnit`), so the change can be undone.
- **No release fetch in the energy mode.** `GET /factors/parameters` resolves the Sm³ path; the energy mode reads nothing from it, so the form does not call it.
- **Review sheet.** `apps/web/app/review/page.tsx` adds a read-only "Calorific basis" row under the activity row when `record.parameters.cvBasis` is present. The record read DTO already carries `parameters`. Without it, the approver could not check the basis against the bill, which is the guard the Risks section relies on.
- **Specs.**
  - `record-inputs-view.spec.ts`: an imported gross draft round-trips its basis through `gasInputsFromRecord` and `gasParameters`; the Sm³ mode never sends `cvBasis`; the leave-TR rule clears the quantity for `net` only.
  - A web spec covers the copy tuple keeping kWh and the quantity.
  - The e2e case:
    1. imports a kWh gross row;
    2. opens the draft, changes an ordinary, always-visible field (an additional-context value, not the variance reason, which shows only on a flag), and attaches its evidence PDF (Natural Gas requires one at submit);
    3. saves and submits;
    4. on the review sheet, reads the basis line.

    The e2e asserts that the figure after save equals the import's. The TR e2e fixture (reference NCV 9,000 and GCV 10,000, factor 0.2) gives 180.00 kg for 1,000 kWh gross, so 182.17 kg is asserted only in `tr-factor-package.int.spec.ts`, against the real release.
- `ng-kwh-form` then puts the NET/GROSS control on this mode and adds kWh and MWh to `unitsForRecord`.

**Alternative: ship the engine and the form as one PR.** Rejected. It doubles the reviewed diff on a calculation-path change, and the pass-through is the form's own first step anyway.

### 7. No snapshot or schema bump

The snapshot stays at schema 3. A new snapshot key or a schema bump would mark every open TR gas draft stale for no change in its figure. A test asserts that a GV5 Sm³ snapshot is deep-equal to a fixture captured before the change. `tr-factor-package.int.spec.ts` "committed records byte-identical" stays green.

### 8. Reports disclose the gross-to-net step

Added after the `architect` review. A report's calculation-inputs cell (`common/calculation-inputs.ts`, shared by live and issued reports) names a gross bill's `grossToNetRatio` ("gross to net ×0.901147"). The factor appendix keys a path by its factor, its conversion row **and its conversion steps** (`factorId|conversionId|conversionBasis`, second review): records that share a factor and no conversion can still differ in their steps (net against gross, kWh against MWh's ×1,000), and the first record seen would otherwise lend its steps to the others.

- A report that mixed kWh and MWh records of one factor now shows two lines where it showed one, the second naming MWh's ×1,000. That corrects an existing misattribution; no figure changes.
- The issuance renderers become `tonyai-issuance-pdf-v5` and `tonyai-issuance-tables-v5`. No issued dataset holds a gross bill, so no figure, row or fingerprint of an earlier issuance changes.

### 9. The API asks for a net bill's quantity again when an update moves it (second review)

An update inherits every field it does not send, the quantity included. A stored net kWh bill moved by the API to a UK site with its basis dropped would be priced as a gross figure. `ActivityRecordsService.update` therefore refuses, with `activity_value_reentry_required` (400), an update to a stored NET bill that changes its site, category, unit or basis without the quantity (`inheritsNetBillQuantityElsewhere`). Data Entry always sends the quantity, so only direct API callers meet it. A gross bill moves freely, since gross is what every geography prices.

- **Alternative: compare the geography of the old and new site.** Rejected: it needs the site lookup before the rule, and a stricter rule costs a direct caller one field.

## Risks / Trade-offs

- **[Risk] The override leaks to a caller that should get gross** → only `compute` sets it, and only behind `trRule === 'natural_gas'` with an energy unit. The resolver spec asserts the default is still gross when the field is absent.
- **[Risk] An author picks `net` for a gross bill** → the figure is about 11% high. That overstates emissions, and never understates them. The basis has no default, and `ng-kwh-form` shows the derived net for gross. The reviewer checks the bill under D01 against the basis the review sheet now shows (Decision 6). The engine cannot tell the two apart.
- **[Risk] A net figure is moved outside TR and priced as gross** → the form clears the quantity and asks for the gross figure (Decision 6). A direct API caller could still send the net figure to a UK record. The API cannot know which basis a bare UK quantity is on; that is today's rule for every non-TR energy bill, and the UK reviewer's bill check covers it.
- **[Risk] Ratio 8,250 / 9,155 is a derived pairing, not a signed value (D2)** → it is cited row by row in every snapshot. It is on the external review list. A reviewer's answer arrives as a release parameter in a new edition, which reprices only open records, without a contract change.
- **[Risk] The API accepts kWh before the form offers it** → only bulk upload and direct API calls can create a kWh record until `ng-kwh-form` ships. Both must state the basis. Data Entry preserves a stored basis (Decision 6), so such a draft can be edited and submitted from the form. The web's records table and review sheet show the unit and value as for any record, and the snapshot carries the ratio. The author cannot change the basis on screen until `ng-kwh-form`; until then a wrong basis is corrected by re-importing.
- **[Trade-off] `parameter_missing` also covers an inconsistent pair** → the message names the pair, and the state needs a malformed release, which the loader's review would catch first.
- **[Risk] The CHECK migration is a contract in SQL** → it is expand-only (the old shape still passes), copies the other branches verbatim, and `record-write-guards.int.spec.ts` gains `cvBasis` cases, both accepted and refused, including JSON null. The `NULLS NOT DISTINCT` drift is inspected and removed if `migrate dev` emits it.
- **[Risk] The pinned fingerprint is forgotten** → the QA deploy's runtime-role verification would then refuse the migrated database. The re-pin is a task in the same group as the migration, and `runtime-role.int.spec.ts` must pass before the PR.

## Migration Plan

- **Order.** One migration, expand-only. Deploy order is migrate → image, as usual; the old image never writes `cvBasis`. The re-pinned `INTEGRITY_CHECKS` hash ships in the same PR, so the runtime-role verification reads the new definition as expected.
- **The window before a failed rollout's rollback (second review).** `QA deploy` serves the new API before its smoke check (`infra/scripts/qa_autodeploy.py`), so a record written with `cvBasis` in that window meets the old image after an automatic rollback. The old image refuses to recompute or edit it (its engine refuses kWh, its DTO refuses the key): the record reads as stale and is fixed after the forward fix ships. Nothing is mispriced, and the CHECK still admits the row. On QA no pilot data is written in a rollout window.
- **A rollout that fails (automatic).** `QA deploy`'s rollback step (runbook 11, step 7) redeploys the previous images when rollout, verification, smoke, budget or cancel fails. The migration stays applied, since migrations are never rolled back. The old image runs against the widened CHECK safely: it never writes `cvBasis`, and the expand-only CHECK still admits every shape it writes.
- **A rollout that succeeded, then a defect (fix forward).** The on-demand `QA rollback` refuses a candidate whose migration chain differs from the live source's (runbook 11, "On-demand rollback"). After this change, every earlier candidate differs. So a defect found after a successful deploy is fixed forward, with a new PR through `QA deploy`.
  - A calculation defect can be contained in that fix by refusing the energy path again: `assertTrGasUnit` answers `calorific_basis_mismatch` for kWh, with no migration. Open kWh records then read as stale, which is fail-closed, never mispriced.
  - Approved or locked records keep their snapshots, as for any engine change.
  - The CHECK is never narrowed while a stored row could hold `cvBasis`.
