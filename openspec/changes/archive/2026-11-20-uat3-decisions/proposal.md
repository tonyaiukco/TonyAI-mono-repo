# Proposal

## Why

The UAT round 3 bug report (v3, 2026-11-20) merges the sealed calculation spec v2.4 with the increment spec v2.5. v2.5 adds two features: natural gas entered in kWh, and on-site self-generation (Case A, behind the meter). Checked against `main` at `ac5853a9`, rounds 1 and 2 are almost entirely shipped. v2.5, however, cannot be built as written, for four reasons:

- **v2.5 contradicts the code and a live spec.** It says the engine "already handles natural-gas kWh". In fact the `emission-calculation` requirement *Natural gas net-basis chain* refuses a TR natural gas record in kWh with `calorific_basis_mismatch`, and `CalculationsService.assertTrGasUnit` enforces that refusal.
- **v2.5 has no recorded approver.** v2.4 was signed by the CEO and the COO; v2.5 was not.
- **v2.5's arithmetic needs fixing.** Its gross→net default of `× 0.9` has no source. Its billed-GCV formula gives a ratio above 1 inside the release's own accepted GCV range.
- **v2.5's self-generation model leaves open questions.** It does not say where the data lives, how the generation fuel avoids double counting, or what "net from the grid" means on a bidirectional meter.

This is a compliance product, so these points must be settled before any calculation-path code is written. This change records the decisions and turns the remaining work into task cards. The later changes will build from settled answers, as LP7-07 did from `uat2-refrigerant-multigas-design`.

## What Changes

- **A decision record, and nothing that runs.** There is no code, migration, API contract or UI change, and the system's behaviour is unchanged. The change opts out of spec deltas (`skip_specs: true`). `design.md` holds the decisions, each with its options, its recommendation and the evidence from the code. It also holds the draft requirements that the build changes will carry as spec deltas.
- **Decisions put to the owner (D1–D9):**
  - **D1:** v2.5 enters the pilot scope, and its approver is recorded.
  - **D2:** for a gross kWh bill, the gross→net default is the release's own `reference_ncv / reference_gcv` (8,250 / 9,155 ≈ 0.9011), not the constant 0.9.
  - **D3:** a billed GCV does not change the kWh ratio. The v2.5 formula `NCV_ref / GCV_bill` is not adopted and goes on the external review list.
  - **D4:** coverage refusals (`no_factor`, `placeholder_refused`, `no_conversion`, `calorific_basis_mismatch`) return HTTP 422 as v2.4 §1.1 states, not today's 404.
  - **D5:** self-generation lives in the Electricity record's `parameters`. The record's value is the grid import. The generation fuel stays an ordinary Natural Gas or Fuel record, and is never a second priced quantity.
  - **D6:** the field names, with one optional facility-consumption field.
  - **D7:** market-based Scope 2, certificates (I-REC / YEK-G), avoided emissions and Cases B/C move to LP7.
  - **D8:** `gridFromKwh` is the meter's import register, never import minus export.
  - **D9:** BUG-09 (password visibility), the BUG-10 remnant and the R2-12 remnant ship before the pilot as an owner exception.
- **A fact recorded, not changed:** the K4 typo ceiling does not conflict with golden vector GV-SG-2 (500,000 Sm³). The ceiling flags a first-period record and asks for a variance reason, but never blocks it. The engine never reads the ceiling.
- **Status file** (`docs/roadmap_docs/project_status_roadmap_phases.md`):
  - a Decisions log entry;
  - new cards LP4-06 (natural gas kWh), LP4-07 (self-generation Case A) and LP7-09 (market-based Scope 2, certificates, avoided emissions, Cases B/C), plus their ledger rows;
  - Next up names the change order;
  - Open questions takes what stays open.
- **The Turkish source reports under `docs/uat/` are not committed** (the language rule). Their substance enters the repo in English, through this change and the status file.

## Capabilities

### New Capabilities

None. This change is a decision record only (`skip_specs: true`). The build changes will modify `emission-calculation`, `activity-data-entry`, `record-evidence` and `anomaly-check`. Their draft requirements are in `design.md`.

### Modified Capabilities

None.

## Impact

- **Code, API, database, shared types, factor releases:** none.
- **Docs:**
  - `openspec/changes/uat3-decisions/design.md`, the deliverable;
  - `docs/roadmap_docs/project_status_roadmap_phases.md`: Decisions, the new LP cards and their ledger rows, Next up, Open questions.
- **Deploy:** none, because the change touches no image.
- **Later, not this change:**
  - `uat3-ui-polish` (D9);
  - `calc-refusal-422` (D4);
  - `ng-kwh-engine` and `ng-kwh-form` (LP4-06);
  - `self-gen-model` and `self-gen-form` (LP4-07).
