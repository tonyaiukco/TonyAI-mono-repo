# Design

## Context

See `proposal.md` (Why). This section gives only the current state that the decisions rest on. Everything was checked on `main` at `ac5853a9` (2026-11-20).

**Natural gas in Türkiye today:**
- **Input units.** The TR factor (`packages/db/factor-releases/tr-2026-11/ipcc.json`) is per **net kWh**: 0.20215548 kgCO2e/kWh, which is 56,154.3 kgCO2e/TJ × 3.6e-6. The engine turns Sm³ or metered m³ into net kWh (`tr-rules.ts`, `naturalGasChain`) and prices that.
- **kWh refused on purpose.** A kWh record is refused at three points:
  - `CalculationsService.assertTrGasUnit` throws `calorific_basis_mismatch`;
  - `unitsForRecord` offers TR gas only Sm³ and m³;
  - `directCalorificBasisFor` treats every fuel kWh as gross.

  The live requirement *Natural gas net-basis chain* in `openspec/specs/emission-calculation/spec.md` states this refusal.
- **Release rows the chain reads.** The same release holds `reference_ncv` 8,250, `reference_gcv` 9,155, and the accepted billed-GCV range of 8,100–10,427 kcal/Sm³.
- **Record parameters.** `NaturalGasRecordParameters` carries `ncvKcalPerSm3`, `billedGcvKcalPerSm3` and `volumeCorrectionFactor`. There is no calorific-basis field.

**Refusal status.** `CALCULATION_REFUSAL_STATUS` (shared-types) maps the coverage refusals `no_factor`, `placeholder_refused`, `no_conversion` and `calorific_basis_mismatch` to **404**. v2.4 §1.1 states **422**. The web client keys its handling on `code`. The one status check in `lib/api.ts` is for `registration_unavailable`.

**Electricity and Scope 2:**
- Pricing is location-based only (`PILOT_SCOPE2_METHOD`). A market-based row may be stored but is never resolved.
- An Electricity record takes no parameters: the engine refuses them with `parameters_not_applicable`.
- No self-generation field exists in Prisma, shared types, DTOs or reports. `renewable_kwh` is context metadata only, and the engine never sees it.

**K4 typo ceilings** (`FIRST_PERIOD_CEILINGS`):
- The limits are Electricity 1,000,000 kWh, and natural gas 250,000 Sm³ / m³ or 2,500,000 kWh.
- They apply only to a series' first period, strictly above the limit.
- They flag the record and ask for a variance reason before submit. They never block, and the engine never reads them.

## Goals / Non-Goals

**Goals:**
- Settle every v2.5 question that would otherwise change a build change's specs or approach.
- Give each decision its options, a recommendation and the evidence, so the owner can answer one by one.
- Draft the requirements the build changes will carry, so they copy rather than re-derive them.

**Non-Goals:**
- Writing the code, migrations, contracts or UI, which are the later changes.
- Editing `docs/md_docs/Revision MD.md`. A correction to it is a new edition, never an edit.
- Re-opening v2.4's sealed chain, the golden vectors GV-1..GV-8 or the UAT round 2 decisions.

## Decisions

**Owner's answers (2026-11-20, in chat, `/opsx:apply`):** all nine recommendations are accepted as written, so each **Recommended** below is the decision. Under D1, the owner moved v2.5 into the pilot scope. The v2.5 sign-off by the signatories of v2.4 (CEO `super_admin`, COO `consultant`) is not recorded yet; it is filed under Open questions, and no name is written until it is given.

### D1 — v2.5 enters the pilot, with a named approver

The pre-pilot rule files anything that is not a defect. v2.5 is new scope, so it needs an explicit owner decision.

- **Recommended:** v2.5 §1 (natural gas kWh) and §2 Case A (self-generation) enter the pilot as LP4-06 and LP4-07. The approvers are recorded the way v2.4 recorded its own (CEO `super_admin` and COO `consultant`). This change does not write those names; the owner states them on review.
- **Alternative:** move v2.5 to LP7. Then nothing below is built before G6.

### D2 — Gross→net default for a kWh bill: the release's own ratio

v2.5 gives `kWh_net ≈ kWh_gross × 0.9` with no source. The repo rule is never to invent a factor value.

- **Recommended:** the ratio is `reference_ncv / reference_gcv`, read from the factor's own release: 8,250 / 9,155 = 0.901147. The snapshot cites both rows (`rowsUsed`) and records the ratio with origin `derived`. No new release and no erratum are needed.
- **Effect on the golden vectors:**
  - GV-NG-kWh-B becomes 1,000 kWh gross → 901.147 kWh net → **182.17 kgCO2e**. That is inside v2.5's own band (181.0–182.8). The constant 0.9 would give 181.94 kg, only 0.13% away, so a ±0.5% assertion cannot tell the two ratios apart. The test asserts 182.17 kg to ±0.01 kg and checks the band separately.
  - GV-NG-kWh-A (202.16 kg) and GV-NG-kWh-C (958.83 kWh net = 100 Sm³ at 8,250 → 193.83 kg) do not change. C is checked against v2.5's GV-4, which is the live `emission-calculation` spec's **golden value 5** (100 Sm³, 193.83 kg). The live spec's golden value 4 is the billed-GCV case (140.37 kg).
  - The vectors run as TR 2025, which v2.5 leaves unstated. The net factor is the same for 2024–2026.
- **The ratio needs sign-off.** The signed package (`Revision MD.md`) gives 8,250 and 9,155 as values. It never pairs them as a net/gross ratio, so the pairing is a derived method, not a signed value. It goes on the external review list. That list also asks whether both values use the same Sm³ reference conditions (15 °C, 101.325 kPa): the `reference_gcv` row does not state them.
- **Alternative:** a literal 0.9. This needs a sourced release parameter (`gross_to_net_ratio`) in a new edition and external review. It is rejected because the release already holds the ratio's inputs.

### D3 — A billed GCV does not change the kWh ratio

v2.5 proposes `kWh_net = kWh_gross × (NCV_ref / GCV_bill)`. That formula divides a reference net value by a different gas's gross value:
- at GCV 8,100, the release's own minimum, the ratio is 1.0185, so net would exceed gross;
- at 10,427, the maximum, the ratio is 0.791, a 12% understatement against 0.901.

For one gas, net/gross is a property of its composition and stays close to constant. A bill's GCV says how much energy a cubic metre holds, which a kWh figure already states.

- **Recommended:** the kWh path takes no billed GCV. `billedGcvKcalPerSm3` and `ncvKcalPerSm3` stay Sm³ inputs only, and a kWh record carrying either is refused (`parameters_not_applicable`). The v2.5 formula goes on the external review list beside the billed-GCV correction and the LNG NCV (Next up, item 4). If the reviewer supplies a sourced per-bill ratio, it arrives as a release parameter in a new edition.
- **The same test questions the sealed Sm³ correction.** v2.4's live Sm³ rule `NCV_eff = 8,250 × 9,155 / GCV_bill` (owner decision 2026-11-05, "taken as written from the source document") gives:
  - NCV 9,325 at GCV 8,100, so net is above gross;
  - NCV 7,244 at GCV 10,427, where a constant ratio would give 9,396.

  This change does not touch that rule: it is sealed, and it is already on the external review list (Next up, item 4). The two formulas go to the reviewer as **one question**: how a billed GCV should enter, for a volume bill and for an energy bill. The kWh path stays out of it until the reviewer answers.
- **Alternative:** adopt v2.5's formula as written. It is rejected because it gives a ratio above 1 inside the accepted range. Adopting it would add a second unreviewed billed-GCV rule beside the one already under review.

### D4 — Coverage refusals return HTTP 422

- **Recommended:** `no_factor`, `placeholder_refused`, `no_conversion` and `calorific_basis_mismatch` move from 404 to **422**, as sealed v2.4 §1.1 requires. Input refusals stay 400 and library conflicts stay 409.
- **Why:** this is a contract change. 404 tells a client the resource does not exist, but the record and route exist; the request cannot be processed against the library. The web client keys its handling on `code`, so screens do not change.
- **Ships as its own change,** `calc-refusal-422`, ahead of the kWh work, so `ng-kwh-engine` is written against 422. The status map and the exception class must change **in one commit**: `toErrorBody` (`apps/api/src/common/api-error.ts`) downgrades a code whose thrown status differs from the registry, so a map change alone would lose the code. Its scope:
  - `CALCULATION_REFUSAL_STATUS` and the `statusCode` union of the error body (shared types);
  - the base class of `NoEmissionFactorError` (`apps/api/src/calculations/errors.ts`) becomes `UnprocessableEntityException`, and its comment is updated;
  - the docs: `docs/api/endpoints.md` and the stability note in `docs/architecture/localisation.md`;
  - the specs: `errors.spec.ts`, `api-error.spec.ts`, `calculations.service.spec.ts` and `activity-records.service.spec.ts`.

  No web flow and no e2e test keys on 404 for these codes. Bulk upload sorts its errors by exception class, and bulk submit wraps refusals in `CalculationStaleError`; both are unaffected.
- **Alternative:** keep 404 and record a deviation from v2.4. It is rejected because the spec is signed and the change is small.

### D5 — Self-generation data model: Electricity record parameters; the fuel stays its own record

v2.5 asks for one form with grid, generation and fuel fields. It also asks that the fuel "feed the Stationary Combustion module" with "no new calculation path".

- **Recommended:**
  - Self-generation is a set of **parameters on the Electricity record**. The record's value stays what it prices: the kWh **imported from the grid** (v2.5's `gridFromKwh`; see D8).
  - The **generation fuel is an ordinary Natural Gas or Fuel record**, with its own evidence, lifecycle and approval. The Electricity record never carries a priced fuel quantity. It names the source only.
  - Fuel burnt in a CHP unit or generator is Scope 1 whether it makes heat or power. It is usually on the site's gas bill already. One record for it is the only way to rule out double counting.
  - **Natural Gas allows one record per slot.** Natural Gas has no activity type, and the unique index treats NULLs as equal. So CHP gas cannot be a second record beside the boiler gas: it is **included in the site's Natural Gas record** for that slot. A diesel generator's fuel is the site's Fuel (diesel) record.
  - Data Entry reminds the author to enter the fuel. The review sheet shows a notice, never a block, when a fuel-sourced Electricity record has no matching fuel record. A match is:
    - `natural_gas_chp` → Natural Gas, `diesel_generator` → Fuel (diesel);
    - the same subsidiary, and the same location, including none;
    - any period of the same reporting year;
    - any status except voided.

    This is buildable with today's scoping: the Electricity record's subsidiary is already in the reviewer's accessible set. The notice needs a new field on the record read DTO.
  - Golden vector GV-SG-2 becomes two records: Electricity 600,000 kWh plus TR natural gas 500,000 Sm³. Scope 2 = 260.40 t, Scope 1 = 969.17 t, total 1,229.57 t.
- **Rejected:**
  - (b) Fuel fields priced inside the Electricity record: one record would then hold two scopes. That breaks the rule that a record's scope is its category's (`factor_scope_mismatch`) and every per-category total.
  - (c) The form auto-creates a linked Natural Gas draft: two records from one save, coupled evidence and approval, and partial-save states. That is too much lifecycle risk before the pilot.

### D6 — Field names and the energy balance

- **Recommended parameters on an Electricity record:**

  | Field | Type | Rule |
  | :-- | :-- | :-- |
  | `generationTopology` | `'A' \| 'B' \| 'C'` | Required when any self-generation field is present. Only `A` is accepted; `B` and `C` are refused (`parameters_not_applicable`) until LP7-09. |
  | `selfGenerationSource` | `'solar' \| 'wind' \| 'natural_gas_chp' \| 'diesel_generator'` | Required with the topology. An Electricity record is always Scope 2, so the source does not set the scope. It decides which fuel record the notice looks for (D5) and how the record reads in review. Without a source, the record is refused. |
  | `selfGeneratedKwh` | number ≥ 0 | Required. Used for the energy balance and the audit trail; never priced. |
  | `exportedToGridKwh` | number ≥ 0 | Optional. Must not exceed `selfGeneratedKwh`, which Case A rules out physically; otherwise refused. |
  | `facilityConsumptionKwh` | number > 0 | Optional. When present, the energy balance is checked. |

- **Field name.** v2.5 uses both `selfGeneratedKwh` and `selfGenerationKwh`, and the Scope 2 Dual schema it cites does not exist in the code. One name is used: `selfGeneratedKwh`.
- **Energy balance:**
  - The expected import is `facilityConsumptionKwh − selfGeneratedKwh + exportedToGridKwh`.
  - The record's import is first normalised to kWh, because the record may be in MWh.
  - A warning is shown when the import differs from the expected import by more than **5% of the expected import**. When the expected import is ≤ 0, any positive import warns.
  - Data Entry shows the warning and the review sheet a notice. Nothing is blocked and no variance reason is asked for, as v2.5 says ("warn, do not block").
- **Geography.** The parameters are allowed in any geography, because they never change the price. This contradicts the live `emission-calculation` requirement *Calculations write the new snapshot, and TR rules follow geography*, which refuses parameters outside the TR rules (enforced by the engine guard, `record-parameters.dto.ts` and the parameters CHECK, whose last version ends in `ELSE false`). `self-gen-model` therefore MODIFIES that requirement, and its scope names:
  - the CHECK migration;
  - the DTO;
  - the `RecordParameters` union;
  - the engine guard.
- **Snapshot.** `SnapshotInput.value` is a number, and the web formats it as one. A new snapshot version would mark every draft and submitted record stale. So the snapshot echoes only the **numeric** fields: `selfGeneratedKwh`, `exportedToGridKwh` and `facilityConsumptionKwh`, with origin `user`. `generationTopology` and `selfGenerationSource` live in the record's `parameters`, which the existing commit freeze protects.
- **Bulk upload.** The self-generation fields are **not in bulk upload** for the pilot. A bulk Electricity row stays a plain grid record, and Data Entry is the only way in.

### D7 — Market-based Scope 2, certificates, avoided emissions and Cases B/C move to LP7

The pilot is location-based only (D08, `PILOT_SCOPE2_METHOD`). v2.5 item 10, a zero-factor certified row, needs a market-based method that does not exist yet.

- **Recommended:** new card **LP7-09** takes:
  - market-based Scope 2, with the GHG Protocol fallback hierarchy;
  - certificate fields (I-REC / YEK-G reference and certified kWh);
  - the avoided-emissions disclosure (GV-SG-3: 400,000 kWh × 0.434 = 173.60 t, never in totals);
  - Cases B and C.

  The pilot report states nothing about avoided emissions.
- **Alternative:** an "information only" avoided line in the pilot report. It is rejected because it adds report-dataset schema work for a figure no total uses.

### D8 — `gridFromKwh` is the import register

v2.5 says "Scope 2 = only the kWh drawn NET from the grid". It also says exports "do not reduce scope". These two statements agree only if "net" means *after self-consumption*, not *import minus export*. GHG Protocol Scope 2 counts the electricity imported, and exports never offset it.

- **Recommended:** the record's value is the **import** reading (the bill's drawn-from-grid register). The form labels it so. A bill that states only a netted figure (import − export) is not a valid Case A source; the help text says so. The energy balance (D6) catches a netted figure only when the facility consumption is given and the exports exceed 5% of the expected import. Otherwise the label, the help text and the reviewer's check of the bill are the guard.

### D9 — The small round-1/2 remnants ship before the pilot

These items are not G4 (Next up). They are not defects, so the pre-pilot rule would file them.

- **Recommended:** the owner makes them an exception, as for `input-border-contrast`, and they ship as one small change, `uat3-ui-polish`:
  - BUG-09: a show/hide toggle on the sign-in password field;
  - BUG-10: remove `generator: 'v0.app'` from the root layout metadata;
  - R2-12: the remaining bulk-upload and void wording.
- **Alternative:** file them under Open questions until after the pilot.

### Recorded fact — K4 and GV-SG-2 do not conflict

GV-SG-2's 500,000 Sm³ is above the 250,000 Sm³ ceiling. The ceiling applies where history cannot judge the record:
- the series' first period;
- three or more earlier periods that average zero (`isCeilingEligible`).

A metered m³ reading is compared as m³ × its correction factor. Where the ceiling applies, it flags the record and asks for a variance reason; where history can judge, the ceiling does not apply. In neither case is the record blocked. The golden vectors run against the engine, which never reads the ceilings. No ceiling changes. GV-SG-1's 1,000,000 kWh is the source's facility consumption, not the record's import (600,000 kWh), so it never meets the electricity ceiling.

## Draft requirements for the build changes

These become spec deltas in the named changes. They are written here so the build copies them.

**`emission-calculation` (`ng-kwh-engine`): MODIFIED *Natural gas net-basis chain with per-record calorific inputs*.** The sentence "A TR natural gas record in kWh SHALL be refused with `calorific_basis_mismatch`" is replaced by the following:
- A TR natural gas record in kWh or MWh SHALL carry `cvBasis` (`net` | `gross`) in its parameters. The name `cvBasis` is v2.5's own. It is chosen over `calorificBasis`, which a snapshot already uses at top level for the *factor's* basis. The snapshot echoes the gross→net ratio (derived) as a number. `cvBasis` itself stays in the record's `parameters`, as `SnapshotInput.value` is numeric.
- TR natural gas in `therms` or `gj` stays refused, as today.
- Bulk upload SHALL accept `cvBasis` as a gas parameter column (`BULK_GAS_PARAMETER_COLUMNS`), as `activity-data-entry` *Natural gas per-record inputs* requires bulk to accept the same gas inputs.
- `net` SHALL be priced directly against the net factor, with no NCV step and no conversion to volume.
- A kWh or MWh record SHALL look up **no conversion row**. Today the TR gas path always looks up an Sm³ conversion (`lookupUnit = 'standard_cubic_metres'`) and reads its parameters from the conversion's release; the kWh path SHALL do neither. The resolved factor row SHALL be on the `net` basis, or the record is refused with `calorific_basis_mismatch`.
- `gross` SHALL first be multiplied by `reference_ncv / reference_gcv`, both read from the **resolved factor's release**. A release lacking either row SHALL answer `parameter_missing`. The snapshot SHALL record the ratio (derived) and both rows.
- A kWh or MWh record without `cvBasis` SHALL be refused with **`parameters_required` (400)**:
  - **Why 400, not 422.** v2.5 asks for a "raw 422" here. But `calorific_basis_mismatch` is a coverage code, and bulk upload reports every coverage refusal as a row `no_factor`, so a forgotten field would read as "cannot be priced yet".
  - **v2.5's intent still holds:** no silent assumption, and the field is required.
- `ncvKcalPerSm3`, `billedGcvKcalPerSm3` and `volumeCorrectionFactor` SHALL be refused on a kWh or MWh record. `cvBasis` SHALL be refused on an Sm³ or m³ record.
- Scenarios (TR 2025):
  - GV-NG-kWh-A: 202.16 kg.
  - GV-NG-kWh-B: 182.17 kg ± 0.01 kg.
  - 1 MWh gross: 182.17 kg.
  - GV-NG-kWh-C: 193.83 kg, equal to the live spec's golden value 5 within ±0.5%.
  - A missing basis is refused; a billed GCV on a kWh record is refused.

**`emission-calculation` (`calc-refusal-422`): MODIFIED.** Coverage refusals SHALL answer HTTP 422.

**`activity-data-entry` (`ng-kwh-form`): MODIFIED *Natural gas per-record inputs*.**
- TR natural gas SHALL offer kWh (and MWh, as `CATEGORY_UNITS` already does outside TR) beside Sm³ and m³.
- Choosing kWh SHALL show a required NET / GROSS choice.
- GROSS SHALL show the derived net kWh and the ratio before save.

**`emission-calculation` (`self-gen-model`): MODIFIED *Calculations write the new snapshot, and TR rules follow geography*** (Electricity takes the D6 parameters in any geography). **ADDED *Self-generation behind the meter (Case A)*:**
- An Electricity record MAY carry the D6 parameters. The snapshot echoes the numeric ones only.
- Scope 2 SHALL be the record's import × the year's grid factor. `selfGeneratedKwh` SHALL never be priced, and the result SHALL never be negative.
- Topology B or C, a missing source, or exports above generation SHALL be refused.
- Scenarios: GV-SG-1 (260.40 t, Scope 1 0), GV-SG-2 (two records; 260.40 t plus 969.17 t).

**`activity-data-entry` (`self-gen-form`): ADDED.**
- The fields SHALL open by source.
- A fuel source SHALL show the reminder to enter the fuel record.
- The energy balance warning SHALL follow D6.

**`record-evidence`:** unchanged. Electricity already requires evidence (K3).

## Risks / Trade-offs

- **The owner answers differently from a recommendation** → the Decisions log records the answer as given, and `design.md`'s draft requirements are corrected in the same change before archive.
- **D4 changes a public status code** → its own change, with every 404 assertion found and changed. The exception class and the map change together, and `docs/api/` is updated in the same PR. No external client exists before the pilot.
- **A missing `cvBasis` answers 400, not v2.5's "raw 422"** (`architect` review) → v2.5's aim is kept: no silent default, and the field is required. The coverage code would mislabel a forgotten field as a library gap in bulk upload.
- **D5 relies on the author entering the fuel record** → the reminder on Data Entry, the notice on the review sheet, and the reviewer's D01 approval. Auto-creation stays an LP7 option.
- **D3 leaves no per-bill correction for kWh** → the reference ratio is the one the reviewer-signed package itself implies (8,250 / 9,155), and the external review is asked whether it holds across the accepted GCV range. A sourced per-bill ratio can arrive later as a release parameter without a contract change.
- **D3's test also questions the sealed Sm³ billed-GCV rule** → this change does not alter a sealed rule. It joins the rule's existing external review as one question with v2.5's kWh formula, and an erratum edition follows if the reviewer rejects it.
- **v2.5's own numbers change** (GV-NG-kWh-B 181.94 → 182.17 kg; GV-SG-2 becomes two records) → both stay inside v2.5's stated bands or totals, and the Decisions log names the change.

## Migration Plan

None: the change is documentation only. The build changes follow in this order:
1. `uat3-ui-polish` (D9). Independent; it can run beside the next two.
2. `calc-refusal-422` (D4).
3. `ng-kwh-engine`, then `ng-kwh-form` (LP4-06).
4. `self-gen-model`, then `self-gen-form` (LP4-07).

Each build change that touches the calculation path gets the `security-rls` and `qa-auditor` review pass. The changes that reshape shared types or Prisma add an `architect` pass.
