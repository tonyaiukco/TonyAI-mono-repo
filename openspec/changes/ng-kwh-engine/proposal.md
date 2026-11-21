# Proposal

## Why

Turkish gas bills state consumption in kWh, but the API refuses a TR natural gas record in kWh (`calorific_basis_mismatch`). It does so on purpose: the factor is per **net** kWh, a bill's kWh may be gross, and nothing on the record says which. UAT round 3 (spec v2.5 §1) asks for kWh input with the basis stated. The owner moved it into the pilot on 2026-11-20 (Decisions 2026-11-20, D1–D3; `uat3-decisions`). This is the engine half of LP4-06. The Data Entry form follows as `ng-kwh-form`.

## What Changes

- **A TR natural gas record in kWh or MWh is priced** when it carries `cvBasis` (`net` | `gross`) in its parameters:
  - `net` is priced directly against the release's net-kWh factor;
  - `gross` is first multiplied by `reference_ncv / reference_gcv`, read from the **factor's own release** (8,250 / 9,155 = 0.901147, D2).

  Neither path looks up a conversion row or reads a billed GCV (D3).
- **Refusals:**
  - A kWh or MWh record without `cvBasis`: **`parameters_required` (400)**, not a coverage code. This keeps bulk upload from reporting a forgotten field as a library gap.
  - `ncvKcalPerSm3`, `billedGcvKcalPerSm3` or `volumeCorrectionFactor` on a kWh or MWh record, or `cvBasis` on an Sm³ or m³ record: `parameters_not_applicable` (400).
  - The resolved factor is not on the net basis: `calorific_basis_mismatch` (422).
  - The factor's release lacks either reference row: `parameter_missing` (409).
  - TR natural gas in therms or GJ stays refused (`calorific_basis_mismatch`, 422).
- **Snapshot:** a gross record echoes the ratio as a derived input and cites both release rows. A net record echoes no input. The snapshot schema stays at 3, and Sm³ and m³ snapshots stay byte-identical, so no open draft goes stale.
- **The shared factor resolver gains an explicit direct-basis override.** Today it assumes every fuel kWh is gross, so it cannot reach the TR net factor. With the override, the lookup is direct-only and reads no conversion rows at all. Every other caller keeps its behaviour.
- **One rule for an explicit `null`:** `cvBasis: null` means "absent" in the DTO, the engine and the database CHECK alike, on POST and on PATCH. It never reaches the database as a 500.
- **Bulk upload accepts a `cvBasis` column** (`net` / `gross`), documented in the template, and refused on every other category's row, refrigerant equipment lines included. The dry-run preview shows the basis it read, in TR and EN, so the user can check NET/GROSS before importing.
- **Data Entry keeps a stored basis.**
  - Opening an imported kWh or MWh draft, or copying a voided one, keeps its unit, quantity and `cvBasis`. The basis is shown read-only and sent with every preview and save, so an unrelated edit, a copy or a submit from the form still works.
  - Moving a **net** kWh draft outside the TR rules clears the quantity and asks for the gross figure. Those rules price an energy bill as gross, so a net figure would otherwise be priced as gross without a word.
  - The editable NET/GROSS control is `ng-kwh-form`'s.
- **The review sheet shows the basis** read-only (net/gross, TR/EN), so the approver can compare it with the bill.
- **`parameters_required` gets a gas sentence.** The refusal carries a sentence selector, so screens ask for the net/gross choice instead of showing the refrigerant equipment sentence (TR/EN).
- **Golden vectors (TR 2025):**

  | Vector | Input | Expected |
  | :-- | :-- | :-- |
  | GV-NG-kWh-A | 1,000 kWh, net | 202.16 kg |
  | GV-NG-kWh-B | 1,000 kWh, gross | 182.17 kg ± 0.01 kg |
  | (MWh) | 1 MWh, gross | 182.17 kg |
  | GV-NG-kWh-C | 958.83 kWh, net | 193.83 kg, equal to the live spec's golden value 5 within ±0.5% |

- **Not in this change:** the Data Entry kWh option for a new record, the NET/GROSS control and the derived-net preview (`ng-kwh-form`). The web's unit list for a new TR gas record stays Sm³ and m³ until then.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `emission-calculation`:
  - *Natural gas net-basis chain with per-record calorific inputs* no longer refuses kWh. Therms and GJ stay refused.
  - New requirements for the energy-unit path: the stated basis, net pricing, the gross ratio.
  - *Refusal families answer with their own HTTP status*: the calorific-basis scenario moves to therms, and a missing basis is a 400.
- `activity-data-entry`:
  - *Natural gas per-record inputs* adds bulk upload's `cvBasis` column and its preview;
  - new: Data Entry carries a stored basis, on open and on copy;
  - new: a net energy figure leaving the TR rules is entered again.

  The form's editable fields are unchanged here; `ng-kwh-form` modifies them.
- `record-lifecycle`: new, the review sheet shows a gas energy record's calorific basis.

## Impact

- **Shared types (`packages/shared-types/src/index.ts`):**
  - `NaturalGasRecordParameters.cvBasis` and a `CvBasis` type;
  - `resolveFactorPath`'s direct-basis override;
  - the `cvBasis` bulk column;
  - the `parameters_required` sentence selector and its param.

  `unitsForRecord` is unchanged.
- **API:**
  - `calculations.service.ts`: `compute`, `assertTrGasUnit`;
  - `tr-rules.ts`: a new energy-unit chain;
  - `factor-lookup.ts`: the basis passed through, and no conversion query on a direct-only lookup;
  - `record-parameters.dto.ts`: `cvBasis`;
  - `bulk-upload/record-inputs.ts` (`gasParametersOf`, `equipmentOf`) and `template-workbook.ts`.
- **Database:**
  - one migration that widens `activity_records_parameters_check` to admit `cvBasis` ∈ {`net`, `gross`, JSON null}. Expand-only, with no data change;
  - the CHECK's pinned md5 in `packages/db/scripts/runtime-role.mjs` (`INTEGRITY_CHECKS`) is re-pinned in the same change, or the runtime-role verification refuses the new CHECK.
- **Web:**
  - the `errors.variants.parameters_required` sentence (TR/EN);
  - `dataEntry.bulkColumns.cvBasis` and the basis labels (TR/EN);
  - the bulk preview's input echo (`lib/bulk-upload-view.ts`);
  - the stored-basis pass-through, its read-only line, the copy flow and the leave-TR reset (`lib/record-inputs-view.ts`, `app/data-entry/page.tsx`);
  - the review sheet's basis line (`app/review/page.tsx`).

  No new editable control.
- **Docs:**
  - `docs/md_docs/calculation_logic.md`;
  - `docs/api/endpoints.md`: TR inputs, bulk columns, refusals;
  - `docs/architecture/data-model.md`: the parameters CHECK.
- **Review:** the calculation path, a migration and the shared-types contract are touched. So `security-rls`, `qa-auditor` and `architect` review the diff before the PR.
- **Deploy:** an image change with one migration. The QA deploy runs on merge.
