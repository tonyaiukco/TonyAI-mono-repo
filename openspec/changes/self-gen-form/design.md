# Design

## Context

See `proposal.md` for the motivation. The decisions this design builds on are D5, D6 and D8 of [`uat3-decisions`](../archive/2026-11-20-uat3-decisions/design.md) and the model in [`self-gen-model`](../archive/2026-11-23-self-gen-model/design.md); none of them is reopened here, except `self-gen-model`'s decision 6, which was written for a form that shows no field and is replaced by decision 1 below.

What the code does today (`main`, `a7d31812`):

- **Shared types** hold the block's type, value lists and rule: `ElectricityRecordParameters`, `SELF_GENERATION_SOURCES`, `recordParameterShape(category)` and `selfGenerationIssue(parameters)`, which returns the first of: a missing topology, source or generated kWh (`parameters_required` with `input`), a topology other than `A`, exports above generation. It does not check number bounds; the DTO, the engine and the CHECK do.
- **Data Entry** (`apps/web/app/data-entry/page.tsx`, 2,975 lines) holds the opened record's block in `ownSelfGeneration` and never shows it.
  - `recordParameters` falls through to `selfGenerationToSend(category, ownSelfGeneration)`.
  - An Electricity-to-Electricity edit sends no `parameters` (`editLeavesParametersToServer`).
  - Every edit sends `seenUpdatedAt`; on `record_changed` the form reads the record again (`reloadAfterLostRace`).
- **The category-specific inputs** are components in `components/data-entry/record-inputs.tsx` (`CalorificBasisChoice`, `NaturalGasInputs`, `EquipmentLines`), mounted in the Activity card on `recordInputMode(...)`. Each takes an `issue` and prints its own sentence; the page folds the issue into `hasValidInput`, which gates the preview and both save buttons.
- **`recordInputMode`** answers null for Electricity. Its callers read a non-null mode as a TR pricing rule: the reference-parameter read and `unitCategoryAfterReset` both take it.
- **The review sheet** (`apps/web/app/review/page.tsx`) reads its record from the list row (`GET /activity-records`, `sort: "review_queue"`) and, after a review step, from the write's answer. It makes no single-record read. Its lines and notices are inline; `lib/review-view.ts` holds the helpers (`reviewCalorificBasis`).
- **`toDTO`** (`activity-records.service.ts`) builds every record answer. Fields resolved at read time (`locationName`, the actor names, `evidenceCount`) are passed in, and `ResolvedRecordFields` keeps them out of the audit snapshot. A list page resolves its extras in one query each (`closedRecordIds` in `closed-periods.ts`).
- **Access is per subsidiary.** `accessibleSubsidiaryIds` is the only scope; there is no location-level access.
- **The slot** is the unique index on subsidiary, location, year, period granularity, period value, category and activity type, voided records apart. Natural Gas stores no activity type; stationary diesel is category `Fuel`, type `diesel`.
- **Snapshot input names** are constants in the API (`calculations/self-generation.ts`, `tr-rules.ts`). The web repeats `'grossToNetRatio'` as a string in `lib/conversion-view.ts`. No screen lists snapshot inputs by name; unknown names are skipped.
- **`saveErrorDescription`** (`lib/record-lifecycle-view.ts`) words a save's refusal for Data Entry; it special-cases `record_duplicate` and 5xx only, so `record_changed` gets the generic sentence, which describes a race during the request.

## Goals / Non-Goals

**Goals:**

- What the form shows is what the save sends; no hidden block state.
- One rule each for the block, the energy balance and the fuel-record match, written in shared-types and read by both sides.
- No change to any figure, snapshot, staleness state or report.
- The fuel-record lookup adds no way to learn about a subsidiary the reader cannot access.

**Non-Goals:**

- Storing, auditing or snapshotting the balance result or the fuel-record state. Both are computed on read.
- A new `recordInputMode` value, a new endpoint, a new error code, a migration.
- Constants for the three volume gas input names (`ncvKcalPerSm3`, `billedGcvKcalPerSm3`, `volumeCorrectionFactor`), which are bare strings on both sides today and are not in the review note.
- Tightening the version rule: an edit that names no version is still compared as `self-gen-model` decision 9 says.

## Decisions

### 1. The block is form state, and every Electricity save sends it

The page gets one piece of state for the section (source and three kWh fields), filled when a record is opened or copied and emptied on reset, where `ownSelfGeneration` is set and cleared today. `recordParameters` builds the block from it while the category is Electricity: the four values plus topology `A` when a source is chosen, null otherwise. The same value goes to the preview, the create and the edit.

`editLeavesParametersToServer` and `selfGenerationToSend` are removed with their specs. `ownSelfGeneration` shrinks to one fact the notice of decision 8 needs: whether the opened record held a block.

- **Why sending is safe now:** `self-gen-model` omitted the parameters because the form would have written back a block the user never saw. The user now sees and owns every field, and each edit names its version, so a form older than the stored record is refused before anything is compared.
- **What carries the safety:** the version check alone. The three stale-form e2e tests (a block corrected elsewhere, added elsewhere, a draft turned into Electricity elsewhere) stay and must pass unchanged in outcome.
- **Alternative rejected:** sending the block only when the user touched it. It keeps a hidden "untouched" state and a second code path, for a case the version check already covers.

### 2. The section is decided by the category's shape, not by a new input mode

The page shows the section when `recordParameterShape(category) === 'electricity'`, in any geography. `recordInputMode` keeps answering null for Electricity.

- **Why:** its callers treat a mode as a TR pricing rule (the reference read, the unit reset after a submit). The block is geography-blind and changes no price.

### 3. One component, one view model, the existing number field

- `SelfGenerationInputs` joins `record-inputs.tsx`, mounted in the Activity card after `EquipmentLines`. It takes the form state, an `issue`, the balance result, the page's `epoch` and `onChange`, like its siblings.
- The source is a select with a "none" entry first. The kWh fields use the file's `ParameterNumberField`, so they read decimals by the locale and remount on the epoch as the gas fields do.
- `record-inputs-view.ts` gets the pure parts, each with specs: the form state's type, its reading from a record (replacing `selfGenerationFromRecord`'s caller, the function itself stays), the block the form would send, and the form's issue.
- The topology is a sentence, not a control. D6 accepts only `A`, and a one-option control invites no decision. The sentence says what Case A is and that a plant on its own meter cannot be recorded yet, so an author with another arrangement stops instead of filing it as `A`.
- **Alternative rejected:** a radio group with `B` and `C` disabled. It shows two options nobody can pick, and LP7-09 will define them properly.

### 4. The save gate is `selfGenerationIssue` plus the API's bounds

The form's issue is computed on the block it would send, in this order:

1. a field the number input could not read (its `refused` flag), or a negative generation or export, or a facility consumption of zero or less;
2. `selfGenerationIssue(block)`: the missing generated kWh, then exports above generation.

A missing topology or source cannot occur: the form adds the topology, and no source means no block. The issue joins `hasValidInput`, so one gate holds the preview and both save buttons, as the calorific basis does. The component prints the sentence for the issue under the fields (`role="status"`, amber, as `CalorificBasisChoice` does).

- **Why the bounds are checked on the web and not added to `selfGenerationIssue`:** the engine calls that function and its refusal order is pinned by tests; the bounds are already the DTO's and the CHECK's. The web check exists to say which field is wrong before a 400 does.
- **Why the preview is held too:** the preview sends the block, and the API refuses an incomplete one. A preview that passes also proves the save will.

### 5. The energy balance is a shared pure function, computed on read

`selfGenerationBalance(importValue, importUnit, block)` in shared-types returns the import in kWh, the expected import and whether it warns, or null when nothing can be checked (no block, no facility consumption, no generated kWh, no quantity, or a unit with no kWh route).

- Expected import = `facilityConsumptionKwh − selfGeneratedKwh + (exportedToGridKwh ?? 0)`.
- The import goes to kWh through `CEILING_UNIT_MULTIPLIERS`, whose parity with the API's normaliser an API spec already pins.
- It warns when `|import − expected| > expected × ENERGY_BALANCE_TOLERANCE` (0.05, an exported constant), or when `expected ≤ 0` and `import > 0`. The comparison is strict, so exactly 5% does not warn; a spec pins the boundary.

Data Entry calls it with the form's quantity, unit and block; the review sheet with the record's. Both print the two figures with the locale's number format.

- **Why not on the server:** the result depends only on the record's own fields, which every reader already has. D6 asks for no stored state and no variance reason.
- **Why shared-types and not a web helper:** the 5% rule is a methodology value (D6) that LP7-09 will reuse for Cases B and C, and the API may one day report it.

### 6. The fuel-record state is resolved at read time, like the evidence count

**The contract.** `ActivityRecordDTO.generationFuelRecord: 'present' | 'missing' | null`, required, with its value list and type in shared-types. A shared map names the fuel record each source needs: `natural_gas_chp` → category `Natural Gas`, no activity type; `diesel_generator` → category `Fuel`, type `diesel`; `solar` and `wind` → none.

**The lookup.** A helper beside `closed-periods.ts` takes the records about to be answered and returns the state of each one that needs it:

- It keeps the Electricity records whose normalised block names a fuel source. With none, it runs no query.
- It runs one `findMany` for the rest: one `OR` branch per distinct subsidiary, location, year and fuel record, with `status ≠ voided`, selecting only those key columns.
- `locationId` is matched as stored, null to null: a whole-company Electricity record looks for a whole-company fuel record (D5: "the same location, including none").
- Every branch carries the record's own `subsidiaryId`, and the query also carries `subsidiaryId IN accessibleSubsidiaryIds`. The records were loaded through the same scope, so the second filter changes no result; it keeps the rule that no query runs without the accessible set.

**The callers.** `toDTO` takes the state as an argument, as it takes the evidence count. `listPage` resolves the whole page in the one query; the single read, create, update and the status transition resolve their one record. The field joins `ResolvedRecordFields`, so the audit snapshot cannot carry it.

- **Why on every answer and not on the list item only:** the review sheet replaces its record with the answer to a review step. A field present on the list and absent on that answer would make the notice vanish when the reviewer starts the review.
- **Why not a dedicated endpoint:** D5 names a field on the record read, and the sheet has no single-record request to hang another one on.
- **Why not computed on the web:** the lists the web holds are paged and filtered, so "no fuel record in what I loaded" is not "no fuel record".
- **What it does not do:** it is not stored, not audited, not part of the snapshot and not a K11 input. It blocks nothing.

### 7. The review sheet reads the block from `parameters`

`review-view.ts` gets `reviewSelfGeneration(record)`, which returns the block's display values for an Electricity record with a normalised block, else null, as `reviewCalorificBasis` does for the basis. The sheet prints the lines in its label and value grid, and the two notices in its existing notice style, below the anomaly notice. The fuel notice names the fuel record through the shared map and the record's site and year.

- **Why `parameters` and not the snapshot inputs:** the source and the topology live only in `parameters`, and the commit freeze protects them once the record is submitted for approval.

### 8. A category move says what it removes

In Edit mode, when the opened record held a block and the category's shape is no longer `electricity`, the page shows one line beside the category (amber, `role="status"`, as the location-move notice is). It goes when the category returns to Electricity. The section's state is not cleared by a category change, so the fields come back as they were; this is the behaviour `self-gen-model` already tested for the hidden block, now visible.

- **Why a notice and not a confirmation dialog:** the save that removes the block is made on the current version, by the author, and the audit row keeps the block in its `before`. The gap the review found was that no screen showed what was lost.

### 9. Snapshot input names live in shared-types

`SELF_GENERATED_KWH_INPUT`, `EXPORTED_TO_GRID_KWH_INPUT`, `FACILITY_CONSUMPTION_KWH_INPUT` and `GROSS_TO_NET_RATIO_INPUT` move to shared-types with their `satisfies` checks. The API imports them from there (no re-export, so each name has one definition), and `conversion-view.ts` reads `GROSS_TO_NET_RATIO_INPUT` instead of the string. The values do not change, so no snapshot, report or test expectation does.

The web still does not read the three self-generation names: it reads the block from `parameters` (decision 7). They move with the fourth so that the names of what the engine writes sit beside the type they are keys of.

### 10. `record_changed` gets a Data Entry sentence

`saveErrorDescription` gains a case for `record_changed` and `SaveErrorKey` a key for it, in the `dataEntry` catalogue (EN and TR, `localise-ui`). The sentence says three things: the record was changed after the form opened it; the changes on the form were not saved; the form is reading the record again. It does not promise what the form will show, because the toast is raised before the reload answers and the reload closes the record when it is no longer editable. The generic `errors.codes.record_changed` sentence stays for the other screens, where the race it describes is the real one.

### 11. Comments that say no screen shows the block

Reworded, not removed, in: the `seenUpdatedAt` doc comment (shared-types), `EditVersionRequiredError`'s rationale and the comment at its throw site (API), the page's `ownSelfGeneration` comment, three comments in `record-inputs-view.ts`, and the header of `e2e/electricity-self-generation.spec.ts`. The new wording gives the reason that still holds: a client that names no version, such as a tab running the JavaScript from before a deploy or a script, cannot be shown to have read the block it would change.

`EDIT_VERSION_REQUIRED_MESSAGE` is left as it is. It speaks of the page that sent the edit, and for a page that names no version it is still true.

## Risks / Trade-offs

- **The form now writes the block on every Electricity edit.** A bug in reading the stored block into the form would write a wrong block back. → The reading and the building are pure functions with a round-trip spec over every shape the CHECK accepts (the three required fields only, optional fields null, all five), and the first e2e test reads the saved block back after an edit that touches only the quantity.
- **A required DTO field breaks every fixture that builds an `ActivityRecordDTO`.** → The typecheck names each one. A required field is chosen over an optional one because an absent value would read as "no notice" without anyone deciding so.
- **A list page costs one more query when it holds a fuel-sourced Electricity record.** → It costs none otherwise, and the query has one branch per distinct site and year, on indexed columns.
- **The notice can be wrong in good faith.** A CHP site whose gas is recorded for the whole company, or a generator filed under another fuel type, reads `missing`. → D5's rule is followed as written, and the outcome is a notice the reviewer can check against the bill; nothing is blocked.
- **The balance compares a period's import with figures the author typed for the same period.** A wrong facility consumption warns on a correct record. → The warning names both figures and blocks nothing.
- **The page is already 2,975 lines.** → The section is a component and its logic is in `record-inputs-view.ts`; the page gains state, one mount, one issue and one notice.
- **The e2e lane.** The model's spec keeps its block drafts on the Manchester Office site in Trading Q4 because `review-queue` uses the whole-company slot. The fuel-record tests add a Natural Gas record to that site and year. → Before placing it, grep `e2e/` for the site, the category and `lockPeriod` (`gates.spec` locks Trading Q1).

## Migration Plan

1. No migration and no data change. No record goes stale.
2. The API deploys before the web, as `qa_autodeploy.py` already orders it. A new web against the previous API reads no `generationFuelRecord` and shows no fuel notice; everything else works, because the previous API accepts the block and the version.
3. A tab still running the previous web keeps working: it sends no parameters on an Electricity edit and names its version.
4. Rollback by images is possible again, since no migration is crossed. The previous web keeps a stored block and the previous API holds the version rule, so a rollback erases nothing; blocks entered meanwhile stay stored and become invisible again until the fix rolls forward.

## Open Questions

- Does a UK site's `gas_oil` (red diesel) Fuel record satisfy `diesel_generator`? D5 names diesel, and the UK is outside the pilot. If the owner says yes, the shared map gains a second accepted type; no spec outside that scenario changes.
- Should Data Entry also show the missing-fuel-record state after a save, now that the answer carries it? D5 asks for a reminder there and the notice on the review sheet. It can be added later without a contract change.
