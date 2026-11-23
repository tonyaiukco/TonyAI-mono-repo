# Proposal

## Why

`self-gen-model` (#344, live as `ci78-1`) lets an Electricity record carry a self-generation block, but no screen shows it. Today only a direct API call can create or correct one, and a reviewer approves the record without seeing it. The owner put Case A in the pilot as LP4-07 (Decisions 2026-11-20, D5, D6, D8), and this change is its second half: the form, the fuel-record reminder and notice, and the energy balance warning.

## What Changes

**Data Entry**

- An Electricity record shows a self-generation section, in every geography. It opens by source:
  - no source chosen (the default): no further field, and the record is a plain grid record;
  - a source chosen (`solar`, `wind`, `natural_gas_chp`, `diesel_generator`): the generated kWh (required), the kWh exported to the grid (optional) and the facility's consumption in kWh (optional).
- The topology is not a choice. The section states that it records generation behind the same meter (Case A) and sends `generationTopology: 'A'`.
- The form does not preview or save while the block is incomplete or out of bounds, and says what is missing. The rule is the shared `selfGenerationIssue`, plus the field bounds the API already enforces.
- The quantity is labelled as the kWh imported from the grid, with help text that a netted bill figure (import minus export) is not valid (D8).
- **The form now sends what it shows.** Every Electricity save, an edit included, sends the block on screen, or none when no source is chosen. This replaces `self-gen-model`'s rule that an Electricity edit sends no parameters, which existed only because the block was invisible. A save made on an older version of the record is still refused (`record_changed`), so a stale form cannot overwrite a block.
- Moving a record that holds a stored block to another category shows, before the save, that its self-generation details will be removed. Moving back shows the fields as they were.
- A fuel source (`natural_gas_chp`, `diesel_generator`) shows a reminder to enter the fuel in the site's Natural Gas or Fuel (diesel) record for the same year.
- When the facility consumption is given, an energy balance warning appears if the import differs from consumption − generation + exports by more than 5% (D6). It never blocks.
- A save refused as `record_changed` gets its own Data Entry sentence: the record changed after the form opened it, the form now shows the stored record, and the unsaved changes were not kept.
- TR and EN copy for all of the above (`localise-ui`).

**Review sheet**

- The sheet shows the block read-only: source, generated kWh, and exported and facility kWh when given.
- A fuel-sourced record with no matching fuel record shows a notice, never a block on approval. The match is D5's: the same subsidiary and location (including none), any period of the same reporting year, any status except voided.
- The energy balance notice appears on the sheet under the same rule as on Data Entry.

**API and shared types**

- The record read DTO gains `generationFuelRecord` (`'present' | 'missing' | null`), filled on every read and write answer, with one extra query per list page at most. No new endpoint, no new error code, no migration.
- Shared functions for the energy balance and for the source-to-fuel-record match, so the web and the API read one rule.
- The snapshot input names (`selfGeneratedKwh`, `exportedToGridKwh`, `facilityConsumptionKwh`, `grossToNetRatio`) move from the API to shared-types; the web stops repeating `'grossToNetRatio'`.
- Comments that say no screen shows the block are reworded. The rule they explain stays: an edit that names no version may not change a stored block, which still guards against a tab from before a deploy.

Not in this change:

- bulk upload columns for self-generation (D6: none for the pilot);
- any change to the calculation, the snapshot or a report;
- a marker for self-generation in the records table or the review queue row;
- auto-creating the fuel record (D5 rejected it; an LP7 option);
- market-based Scope 2, certificates, avoided emissions and Cases B and C (LP7-09);
- the other `self-gen-model` review notes, which stay filed under Open questions.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `activity-data-entry`:
  - MODIFIED *Data Entry keeps a stored self-generation block*: the form sends the block it shows; an Electricity edit no longer omits parameters.
  - MODIFIED *A category change in Edit mode resets the category's fields*: the self-generation fields are kept through a category change and back.
  - ADDED requirements for the section and its fields, the save block, the import label, the fuel reminder, the energy balance warning, the notice on a category move, and the `record_changed` sentence.
- `record-lifecycle`:
  - ADDED requirements for the review sheet's block, its missing-fuel-record notice and its energy balance notice, and for the record read's `generationFuelRecord`.

## Impact

- **Shared types** (`packages/shared-types`): `ActivityRecordDTO.generationFuelRecord`; an energy balance function; the source-to-fuel-record map; the four snapshot input name constants; the `seenUpdatedAt` comment.
- **API** (`apps/api`): `activity-records.service.ts` (the fuel-record lookup on list, single read and write answers; `toDTO`), a new lookup helper beside `closed-periods.ts`, `calculations/self-generation.ts` and `tr-rules.ts` (import the moved names), `errors.ts` (comment). No DTO input change.
- **Web** (`apps/web`): `app/data-entry/page.tsx`, `components/data-entry/record-inputs.tsx`, `lib/record-inputs-view.ts`, `lib/record-lifecycle-view.ts`, `lib/conversion-view.ts`, `app/review/page.tsx`, `lib/review-view.ts`, and the `dataEntry` and `review` catalogues in TR and EN.
- **Tests**: shared-types, API and web unit specs; one integration spec for the lookup against Postgres; `e2e/electricity-self-generation.spec.ts` reworked (its edit cases assert today that no parameters are sent) and extended for the form and the review sheet.
- **Docs**: `docs/api/endpoints.md`, `docs/md_docs/calculation_logic.md`, and the planning file (LP4-07 closed, four review notes resolved).
- **Review**: the change touches a tenant-scoped read, the record write path and the shared-types contract, so `security-rls`, `qa-auditor` and `architect` review the diff before the PR opens.
- **Deploy**: no migration. The API deploys before the web, as the QA deploy already does; a web that meets an API without the new field shows no fuel-record notice.
