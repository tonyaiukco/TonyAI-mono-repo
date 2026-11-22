# Proposal

## Why

Since `ng-kwh-engine` (#340, `ci74-1`), the API prices a TR natural gas bill in kWh or MWh when the bill states its calorific basis. Data Entry still offers TR natural gas only as Sm³ or m³. Only bulk upload and direct API callers can create a kWh record, and the form shows an imported record's basis read-only. UAT round 3 (spec v2.5 §1.3) asks the form itself to take a gas bill in kWh: choosing kWh shows a required NET / GROSS choice, and a gross bill shows its net figure before save. This is the second and last change of LP4-06 (Decisions 2026-11-20, D1–D3; `uat3-decisions`, `ng-kwh-engine` Decision 6 and Non-Goals).

## What Changes

- **Data Entry offers TR natural gas in kWh and MWh** beside m³ and Sm³, on a new record as on an opened one. The new-record default stays the volume unit it is today.
- **A required NET / GROSS choice** replaces the read-only basis line. It appears whenever a TR natural gas record is in kWh or MWh. It has no default.
  - Until a basis is chosen, nothing is previewed or saved, and the form says what is missing. The API's `parameters_required` (400) stays as the backstop for direct callers.
  - An opened or copied record preselects its stored basis, and the author may change it. Changing the basis keeps the quantity: the figure is the bill's, and the basis says how to read it.
- **GROSS shows its net figure before save.** With a quantity entered, the form shows the derived net quantity in the record's own unit and the ratio (`reference_ncv / reference_gcv` of the factor's release, 0.901147 on the TR release) with its release cited. The calculation preview stays the authoritative figure, and its ratio is the same one.
- **`GET /factors/parameters` resolves the energy path.** An optional `unit` query: for TR natural gas in kWh or MWh, the endpoint resolves the factor as the engine does (direct-only, net basis) and returns the **factor's** release parameters. Without `unit`, or with a volume unit, the answer is unchanged (the Sm³ conversion's release).
- **Live requirements that assumed no kWh option are updated:**
  - a UK kWh copy moved to TR now keeps kWh (TR offers it) and asks for the basis;
  - a net figure re-entered after a round trip outside TR shows an empty, required choice, not "no basis shown".
- **Not in this change:**
  - a billed-GCV input for a kWh bill (D3; external review);
  - v2.5's flat ×0.9 (replaced by the release ratio, D2);
  - therms and GJ for TR;
  - the coverage report and matrix;
  - self-generation (LP4-07).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `activity-data-entry`:
  - *Natural gas per-record inputs*: the form offers kWh and MWh for TR natural gas, with the required basis choice.
  - *Data Entry carries a stored calorific basis*: the basis is preselected and editable, no longer read-only.
  - *A net energy figure leaving the TR rules is entered again*: on return to TR, the choice is empty and required.
  - New: *A gross gas bill shows its net figure before save*.
- `emission-factor-library`: new, *Release parameters for a gas energy bill*. The parameters read resolves the factor's release for a TR natural gas bill in kWh or MWh.

## Impact

- **Shared types (`packages/shared-types/src/index.ts`):**
  - `unitsForRecord` offers kWh and MWh for TR natural gas, after the volume units;
  - `ReleaseParametersQuery` gains an optional `unit`.
- **API:**
  - `dto/release-parameters-query.dto.ts`: `unit`, validated against the unit vocabulary;
  - `calculations.service.ts` (`releaseParameters`): the energy path through `lookupFactorPath` with `directBasis: 'net'`, and the factor's release;
  - its spec.

  The calculation path itself is unchanged.
- **Web:**
  - `lib/record-inputs-view.ts`: basis gating, the derived net figure;
  - `components/data-entry/record-inputs.tsx`: the NET / GROSS choice replaces `StoredCalorificBasis`;
  - `app/data-entry/page.tsx`: unit list, release fetch in energy mode, `hasValidInput`;
  - `lib/api.ts` (`releaseParameters` takes `unit`);
  - TR/EN `dataEntry.json`.
- **e2e:** `e2e/natural-gas-energy-bill.spec.ts` adds form-created kWh and MWh bills (net, gross, no basis) and updates its round-trip assertion.
- **Docs:**
  - `docs/api/endpoints.md` (`GET /factors/parameters`);
  - `docs/md_docs/calculation_logic.md`, if it describes the form's units;
  - the status file.
- **No migration, no snapshot or schema change, no factor release.**
- **Review:**
  - the change touches the shared-types contract (`unitsForRecord`, `ReleaseParametersQuery`) and the input side of a calculation, so `security-rls`, `qa-auditor` and `architect` review the diff before the PR.
- **Deploy:** an image change, no migration. The QA deploy runs on merge.
