# Proposal

## Why

Spec v2.5 §2 asks that a facility with its own generation behind the meter (Case A) be recorded without a data gap. The owner moved it into the pilot as LP4-07 (Decisions 2026-11-20, D1, D5, D6, D8). Today an Electricity record takes no parameters at all: the DTO, the database CHECK and the engine each refuse them. So a site with a solar roof or a CHP unit can state only its grid import, and nothing records that the rest of its consumption was generated on site, from what source.

This change is the model half of LP4-07. `self-gen-form` follows with the form, the fuel-record notice and the energy balance warning.

## What Changes

- An Electricity record MAY carry a self-generation block in its `parameters`:
  - `generationTopology` (`A`; `B` and `C` are named but refused until LP7-09);
  - `selfGenerationSource` (`solar`, `wind`, `natural_gas_chp`, `diesel_generator`);
  - `selfGeneratedKwh`;
  - `exportedToGridKwh` (optional);
  - `facilityConsumptionKwh` (optional).
- The block is all-or-nothing. When any field is present, the topology, the source and the generated kWh are required. A record with no block stays a plain grid record, exactly as today.
- The block never changes the price. Scope 2 stays the record's value (the kWh imported from the grid) × the year's grid factor, location-based. `selfGeneratedKwh` and `exportedToGridKwh` are never priced and never subtracted.
- The block is accepted in any geography, because it does not touch the price. This narrows the live rule that parameters outside the TR natural gas and refrigerant rules are refused.
- Refusals, all HTTP 400 input refusals:
  - topology `B` or `C` → `parameters_not_applicable`;
  - a missing topology, source or generated kWh → `parameters_required`, naming the input;
  - exports above generation, or a malformed field → `record_parameters_invalid`.
- A request body whose only refused field is `parameters` answers `record_parameters_invalid` for every category (it answered `validation_failed`), the code the service's own check already throws.
- Every edit MAY name the version it was made on (`seenUpdatedAt`, the record's `updatedAt`); an older version is refused with `record_changed` (409), and an edit that names none may not change or remove a stored block (also `record_changed`). Data Entry names it on every edit and reads the record again on `record_changed` (added in the review of `1802e22e`).
- There is no rollback by images once the migration is applied (the QA rollback refuses to cross a migration); recovery is forward.
- The snapshot echoes the three numeric fields with origin `user`. The snapshot schema stays 3, so no existing record goes stale.
- The database CHECK on `activity_records.parameters` gains an Electricity branch (expand-only).
- Data Entry keeps a stored block when an Electricity record is opened, edited or copied. Without this, every web edit would send `parameters: null` and erase it. The fields are not shown or editable yet; that is `self-gen-form`.
- Golden vectors GV-SG-1 (260.40 t) and GV-SG-2 (two records: 260.40 t Scope 2 + 969.17 t Scope 1 = 1,229.57 t) join the test suites.

Not in this change:
- the form fields, the fuel-record reminder and notice, the energy balance warning and the review sheet's display (`self-gen-form`);
- bulk upload columns (the pilot has none for self-generation);
- market-based Scope 2, certificates, avoided emissions (GV-SG-3) and Cases B and C (LP7-09);
- any report change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `emission-calculation`:
  - MODIFIED *Calculations write the new snapshot, and TR rules follow geography*: an Electricity record's self-generation block is accepted in any geography.
  - ADDED requirements for the block's shape, its refusals, the unchanged Scope 2 figure and the snapshot echo.
- `activity-data-entry`: ADDED *Data Entry keeps a stored self-generation block*.
- `record-lifecycle`: ADDED *An edit is made on the version it names* (review of `1802e22e`).

## Impact

- **Shared types** (`packages/shared-types`): `UpdateActivityRecordInput.seenUpdatedAt`, the version an edit is made on (review of `1802e22e`). `ElectricityRecordParameters` joins the `RecordParameters` union, with its value lists and a per-category parameter-shape resolver; three new `parameters_required` input selectors.
- **API** (`apps/api`): `record-parameters.dto.ts`, the engine's parameter guard and snapshot in `calculations.service.ts` and `calculations/self-generation.ts`, the service's parameter assertion; `update-activity-record.dto.ts` (`seenUpdatedAt`) and the service's version checks (`EditVersionRequiredError`). No new endpoint and no new error code.
- **Database** (`packages/db`): one migration redefining `activity_records_parameters_check`; its pinned md5 in `scripts/runtime-role.mjs` (`INTEGRITY_CHECKS`). No column, table or grant changes.
- **Web** (`apps/web`): Data Entry's parameter wiring (the record's own block for previews and copies; no parameters on an Electricity-to-Electricity edit), the edit version on every edit and a reload on `record_changed` (`reloadAfterLostRace`), readers that tell parameter shapes apart by key presence, three sentences in each of the TR and EN error catalogues.
- **Docs**: `docs/api/endpoints.md`, `docs/architecture/data-model.md`, `docs/md_docs/calculation_logic.md`, and the planning file (LP4-07; LP4-06's closure).
- **Review**: the change touches the calculation path and the shared-types contract, so `security-rls`, `qa-auditor` and `architect` review the diff before the PR opens.
- **Deploy**: one expand-only migration. A pre-change API keeps working against the new CHECK.
