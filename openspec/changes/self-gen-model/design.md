# Design

## Context

See `proposal.md` for the motivation. The decisions this design builds on are D5, D6 and D8 of [`uat3-decisions`](../archive/2026-11-20-uat3-decisions/design.md); none of them is reopened here.

What the code does today (`main`, `4d65e431`):

- **Four gates refuse parameters on an Electricity record**, each with its own hard-coded category list:
  - the DTO rule `recordParametersIssues` (`apps/api/src/activity-records/dto/record-parameters.dto.ts`), reused by create, update and the preview DTO, and applied again by the service's `assertRecordParameters`;
  - the database CHECK `activity_records_parameters_check`, whose last branch is `ELSE false` (last redefined by `20261120120000_ng_kwh_cv_basis`);
  - the engine guard in `CalculationsService.compute`, which answers `parameters_not_applicable` for any category without a TR rule;
  - Data Entry, whose `recordParameters` is null for every category but natural gas and refrigerants, and is sent on **every** save, null included.
- **`RecordParameters` is a structural union** with no discriminator. Readers tell a refrigerant block by `'equipment' in parameters` and treat everything else as natural gas.
- **Parameters are written as sent**, not normalised: a JSON null field reaches the column. `normalizeRecordParameters` drops null fields when the engine and the staleness comparison read them.
- **Electricity is priced on the generic path**: `normalize(value, unit)` × the location-based factor of the year. Its snapshot holds no record inputs.
- **The CHECK's definition is pinned** by md5 in `packages/db/scripts/runtime-role.mjs` (`INTEGRITY_CHECKS`).
- `SnapshotInput.value` is a number, and report text is built from snapshot inputs by name; unknown names are ignored (`apps/api/src/common/calculation-inputs.ts`).

## Goals / Non-Goals

**Goals:**

- One rule for the block, written once and read by the engine now and by the form in `self-gen-form`.
- No change to any figure, snapshot or staleness state of a record without the block.
- No path that erases a stored block silently.

**Non-Goals:**

- Showing or editing the block on Data Entry or on the review sheet (`self-gen-form`).
- The fuel-record notice and its field on the record read DTO, and the energy balance warning (`self-gen-form`).
- A discriminator key inside the stored JSON.
- Listing the block's inputs in reports or issued documents.
- Any change to the first-period ceilings: they keep judging the imported kWh only.

## Decisions

### 1. The block is optional, and one null rule holds on every layer

A record with no block is a plain grid record. A field that is null is an absent field, and a block with nothing left is no block, as `normalizeRecordParameters` already says. The DTO, the engine and the CHECK all follow it, so an all-null block is accepted and stored, and priced as a plain record.

- **Why:** requiring the block on TR Electricity would refuse every bulk row, every existing draft and golden values 1–3.
- **Alternative rejected:** normalising before the write. The gas parameters are stored as sent today, and changing that would alter stored rows' bytes for a rule the readers already apply.

### 2. The category decides the shape, through one resolver

`ElectricityRecordParameters` joins the union. A new shared-types resolver, `recordParameterShape(category)`, answers `'natural_gas' | 'refrigerant' | 'electricity' | null`, and the DTO, the engine guard and the web read it in place of their own category lists. Every reader that tells shapes apart by key presence gets the category first:

- `gasInputsFromRecord` and `recordInputMode` (`apps/web/lib/record-inputs-view.ts`);
- `readInputsLabel` (`apps/web/lib/bulk-upload-view.ts`);
- `reviewCalorificBasis` (`apps/web/lib/review-view.ts`), which already checks the category.

The value lists follow `CV_BASES`: `GENERATION_TOPOLOGIES` (`A`, `B`, `C`), `ACCEPTED_GENERATION_TOPOLOGIES` (`A`) and `SELF_GENERATION_SOURCES`, each frozen, with a type guard.

- **Why:** a third member makes "no `equipment` key, so natural gas" wrong. The category is always known where parameters are read.
- **Alternative rejected:** a `kind` key in the JSON. It changes stored rows and the CHECK's other branches, and a second source of truth could disagree with the record's category.

### 3. The DTO owns the fields, one shared function owns the block, the CHECK backs both

- **DTO** (`ElectricityParametersDto`): each field's type and range, the enum membership (`A`, `B` and `C` all pass here) and unknown keys. A failure is `record_parameters_invalid`. *(Implementation note: the code is set on the shared `IsValidRecordParameters` constraint, so a body whose only refused field is `parameters` answers `record_parameters_invalid` for every category, not only Electricity; it answered `validation_failed` before. This is a move from a generic code to a specific one, which the stability rule allows, and matches what the service's `assertRecordParameters` already throws. A body with another refused field stays `validation_failed`; bulk rows keep `invalid`.)*
- **Block rule**: a pure shared-types function, `selfGenerationIssue(parameters)`, returns the first problem or null, in this order:
  1. a missing `generationTopology`, then `selfGenerationSource`, then `selfGeneratedKwh` → `parameters_required` with `input` naming it;
  2. a topology other than `A` → `parameters_not_applicable`;
  3. `exportedToGridKwh` above `selfGeneratedKwh` → `record_parameters_invalid`.

  The engine calls it and throws the matching `CalculationInputError`. `self-gen-form` will call the same function to block the save button.
- **CHECK**: an Electricity branch placed before `ELSE false`, holding only what the engine accepts:
  - the keys are a subset of the five;
  - either every key is absent or JSON null, or the three required ones are present with topology `A`, a named source and a generation of 0 or more;
  - `exportedToGridKwh` is absent, null, or a number from 0 to the generation;
  - `facilityConsumptionKwh` is absent, null, or a number above 0;
  - numbers use the existing `jsonb_typeof` pattern with the 1e300 bound.

  Every other branch is copied verbatim, so the change is expand-only.

- **Why the engine and not the DTO for rule 1:** `parameters_required` names the input, which the form's sentence needs, and the DTO's failure is one generic code. The engine is also the only gate that every caller passes (create, update, preview, bulk).
- **Why the CHECK stops at `A`:** the database then holds only blocks the engine prices. LP7-09 widens it with another expand-only migration.
- **Alternative rejected:** a new refusal code for exports above generation. Nothing on screen needs to tell it from another malformed field before `self-gen-form`, which validates it in the form.

### 4. The engine guard gains one branch and the pricing path gains none

The guard reads the resolver. Parameters on a category with no shape stay `parameters_not_applicable`. An Electricity block is checked by `selfGenerationIssue` in every geography, and it never reaches `normalize` or the factor lookup. The TR rule selection (`natural_gas` / `refrigerant`, TR only) is untouched.

A table test proves the price is blind to the block: for a range of blocks, the result's figure, factor, conversion and scope equal the same record's without one.

### 5. The snapshot echoes the numbers, at schema 3

The inputs are `selfGeneratedKwh`, then `exportedToGridKwh` and `facilityConsumptionKwh` when given, in that fixed order, with origin `user`. Each input's name is its parameter key, held as an exported constant beside the engine, as `GROSS_TO_NET_RATIO_INPUT` is in `tr-rules.ts`.

- A record without a block keeps `parameters: []`, so its snapshot is byte-identical and nothing goes stale.
- A PATCH that changes the block recalculates, because `sameEngineInputs` already compares the normalised parameters.
- Report and issuance text ignores unknown input names, so no report output changes and no renderer version is bumped. A test holds that.

### 6. Data Entry never erases or reverts the block; it does not show it

The form shows no field for the block, so the only block it holds is the one it read when the record opened. It therefore never writes that block back over the stored one, and every edit names the version it was made on (decision 9):

- **An edit saved as Electricity sends no `parameters`** (`editLeavesParametersToServer(storedCategory, category)`). The API then keeps, and prices with, the block stored at the moment of the save, including one corrected, added or removed by another client after the form opened.
- **A save that moves the record to another category** sends that category's parameters or null, which the API needs: it refuses rather than clears another category's parameters.
- **A copy of a voided record** is a create, so it sends the copied block (`selfGenerationFromRecord`, kept as `ownSelfGeneration` with `ownBasis`).
- **A preview** sends the opened or copied record's block while the category is Electricity (`selfGenerationToSend`); the block changes no figure, so a stale block in a preview misprices nothing.

- **Why now and not in `self-gen-form`:** between the two changes, an Electricity record with a block edited on the web would otherwise lose it on the first save, with no error.
- *(Revised twice in review.)* The first version sent the opened block with every save and cleared it on a category change. `qa-auditor` found that a category picked by mistake and undone then erased the block; the block became the record's own. The outside review of `2c427ed8` found that sending it at all put back an older block over one corrected elsewhere, and erased one added elsewhere to a record opened without one: the server's lock check sees only changes made during the PATCH. Leaving the parameters of an Electricity-to-Electricity edit to the server removes both. The third review then found the cases it does not cover, and the owner chose the version check of decision 9, which covers every field.
- **Alternative rejected (the first design's):** omitting `parameters` for every Electricity save, the moves included. A move away from Electricity must send null, or the API refuses it.
- *(Third review, of `1802e22e`.)* Leaving the parameters to the server does not cover a record opened as another category: a Natural Gas draft another client turned into Electricity with a block, then picked as Electricity in the open form, sends `parameters: null` (the move the form sees) and erased the block. Nor does it cover a tab still running the JavaScript from before the deploy. Both are closed by decision 9, which the form follows: it sends `seenUpdatedAt` with every edit and, on `record_changed`, reads the record and the list again (`reloadAfterLostRace`); typed changes are not kept, since they were made on values that no longer stand.

### 7. Three sentences, no new code

`PARAMETERS_REQUIRED_INPUTS` gains `generationTopology`, `selfGenerationSource` and `selfGeneratedKwh`. Each needs `errors.variants.parameters_required.<input>` in the EN and TR catalogues (`localise-ui`, Recipe B). `parameters_not_applicable` and `record_parameters_invalid` keep their existing sentences, which read correctly for the new cases.

### 8. Golden vectors run against the real releases

`apps/api/test/int/tr-factor-package.int.spec.ts` holds GV-SG-1 and GV-SG-2 beside the existing vectors, on the loaded TR releases. The unit spec gets a TR 2025 Electricity fixture at 0.434 kgCO2e/kWh, labelled as a fixture that mirrors the ETKB row, for the guard, the snapshot and the blind-price table.

v2.5 gives GV-SG-2 no generated kWh, and the block requires one. The test uses 400,000 kWh and says the value is its own.

### 9. Every edit names its version; a block is never changed by a client that names none

*(Added in the review of `1802e22e`, owner's choice of the broad version check.)* `UpdateActivityRecordInput.seenUpdatedAt` is the record's `updatedAt` as the editor read it, optional and an ISO instant (null refused). The service compares it with the record it loads, after the tenant, role, status and author checks (a non-author or another tenant never learns a version from a 409); the lock's `changedSince` then compares that record with the locked row, so the whole window from the page's read to the write is covered. A mismatch is `record_changed` (409), with nothing computed, written or audited.

An edit that names no version is compared as before, with one exception: when the stored record holds a self-generation block and the edit's effective parameters differ from it (removed, replaced, emptied, or the record moved to another category), it is refused with `record_changed` (`EditVersionRequiredError`). No screen shows the block yet, so a client that names no version cannot have seen it.

- **Why `record_changed` and no new code:** the precedent is `ReviewVersionRequiredError` (`seenSubmittedAt`, BUG-R2-03): every client, one from before the deploy included, already words it as "reload and try again", which is the remedy.
- **Why the broad check (every field), not only the block:** Data Entry's edits were last-write-wins for every field; with a version, a second tab's stale save is refused instead of silently overwriting. Only edits and status transitions write the row (evidence links do not), so an upload in the open form does not make its version stale.
- **Alternative rejected:** requiring the version on every edit. Scripts and older clients that touch no block keep working.


## Risks / Trade-offs

- **A block can exist before anyone can see it.** Until `self-gen-form` ships, only a direct API call creates one, and the review sheet does not show it. → The block changes no figure, so what a reviewer approves is right either way. `self-gen-form` is the next change, and the planning file says so.
- **A reader still assumes natural gas.** → Decision 2 lists the readers found; each gets a test with an Electricity record carrying a block. The typecheck catches any reader that narrows the union without the category.
- **The CHECK is redefined by hand.** → Other branches are copied verbatim, the md5 is re-pinned from a freshly migrated database, and `record-write-guards.int.spec.ts` holds every accepted and refused shape.
- **A wrong `selfGeneratedKwh` is not judged by any ceiling.** → It is never priced. `self-gen-form`'s balance warning catches it when the facility consumption is given.
- **The CHP gas has no record of its own** (D5: one Natural Gas record per slot). → Not a code risk here: GV-SG-2 is tested as two records. The notice for a missing fuel record is `self-gen-form`.

## Migration Plan

1. The migration redefines the CHECK. It accepts a superset of what it accepted, so it is safe to apply before the API deploys, and a pre-change API keeps working against it.
2. The API and the web deploy together, the API first (`qa_autodeploy.py` rolls out `api`, then `web`): a web that sends `seenUpdatedAt` must never meet an API from before this change, which refuses the unknown field (`forbidNonWhitelisted`, 400). The deploy's own automatic rollback, on a failed verify or smoke, reverts both images in reverse order; a tab that loaded the new web meanwhile then gets a 400 on every edit until it reloads, and the previous web's window for erasing a block reopens until the fix is rolled forward.
3. **No rollback by images: recovery is forward** (reviews of `2c427ed8` and `1802e22e`). The QA rollback refuses any target whose migration history differs from the live one (`infra/scripts/qa_autodeploy.py`, "Rollback would cross a migration"), so the images from before this change cannot be redeployed once `20261123120000_self_gen_model` is applied. That is also the safe answer: the previous web sends `parameters: null` on every Electricity save and the previous API stores it, so the first edit of any record that holds a block and is, or becomes, editable (a draft, a rejected record, a submitted record recalled, one under review rejected) would erase the block. A defect after the deploy is fixed by a release built on this change, which keeps the migration, the version check and the block. Rolling the CHECK itself back needs no Electricity record holding a block, and is not planned.

No backfill and no data change. No record goes stale.

## Open Questions

- Should an issued report list a record's self-generation inputs in its calculation appendix? Today it lists only inputs it names. This belongs with LP7-09's avoided-emissions disclosure and does not change this change's specs or tasks.
