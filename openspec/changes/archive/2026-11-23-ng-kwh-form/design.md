# Design

## Context

See `proposal.md` (Why) and `ng-kwh-engine/design.md` (Decision 6, Non-Goals). Checked on `main` at `667372a6` (2026-11-23).

- **Units.**
  - `unitsForRecord` (`packages/shared-types/src/index.ts`) narrows TR natural gas to `only(['standard_cubic_metres', 'cubic_metres'])`. `only` keeps `ACTIVITY_UNITS` order, so a new TR gas record starts on m³: the form's narrowing effect and the category handler both take `units[0]`.
  - In catalogue order kWh and MWh come **first**. Simply adding them would move every new TR gas record onto kWh.
  - The unit ids are the plain `kWh` and `MWh`, shared with Electricity. The category filter (BUG-04) keeps them apart, and the labels are plain `kWh` / `MWh`.
- **The form already carries a basis.**
  - `recordInputMode` returns `natural_gas_energy` for TR natural gas in kWh/MWh.
  - `gasParameters` sends `{ cvBasis }` or `null`, and `gasInputsFromRecord` reads it.
  - `StoredCalorificBasis` (`components/data-entry/record-inputs.tsx`) renders it read-only, and nothing at all when no basis is stored.
  - The unit-change, own-unit, copy-tuple and leave-TR helpers (`unitChangeClearsBasis`, `basisAfterUnitChange`, `copyKeepsOwnUnit`, `clearsNetEnergyQuantity`) are in `lib/record-inputs-view.ts`, with specs.
- **Gating.**
  - `hasValidInput` checks `gasProblem` and `gasRefused`, and both apply only to the `natural_gas` mode.
  - An energy record without a basis therefore counts as valid. It is previewed and saved, and the API refuses it with `parameters_required`.
- **Release parameters.**
  - `GET /factors/parameters` (`CalculationsService.releaseParameters`) always looks up natural gas in `standard_cubic_metres` and returns the **conversion's** release.
  - The form's release effect skips the energy mode.
  - The engine prices a gross bill with `reference_ncv / reference_gcv` from the **factor's** release (`naturalGasEnergyChain`). It reaches that factor through `lookupFactorPath(…, unit, 'net')`, direct-only.
  - On the TR release both rows are in one release today. That is not guaranteed.
- **Preview.** A gross preview already names the ratio (`preview.grossToNet`, from the snapshot input `grossToNetRatio`). It appears only after a full preview, in the preview panel.
- **e2e fixture.** `E2E_TR_INPUTS` uses NCV 9,000 and GCV 10,000, a ratio of **0.9**. That equals v2.5's unsourced flat factor, so an e2e run alone cannot tell the release ratio from a hard-coded 0.9.
- **Anomaly ceiling.** `FIRST_PERIOD_CEILINGS['Natural Gas'].kWh` is 2,500,000, with MWh at ×1,000. It judges the quantity as entered. This change does not touch it.

## Goals / Non-Goals

**Goals:**
- A TR gas bill can be entered on the form in kWh or MWh, and the basis cannot be skipped there, with no change to any Sm³, m³, UK or non-gas behaviour.
- A gross bill's derived net figure is shown from the same release rows the calculation reads, never from a constant.

**Non-Goals:**
- Any calculation, snapshot, migration or factor change. The engine is `ng-kwh-engine`'s.
- A billed GCV on a kWh bill (D3), and therms or GJ under TR.
- Bulk upload, the review sheet and reports. They already handle `cvBasis`.
- The coverage report and matrix, which still describe TR gas by its Sm³ path.
- The unit labels (`kWh` stays plain in the gas list; Open Questions).

## Decisions

### 1. The volume units stay first; kWh and MWh follow

`unitsForRecord` returns TR natural gas in a fixed order: m³, Sm³, kWh, MWh. It builds that order explicitly, as the MGO branch already does, instead of filtering `ACTIVITY_UNITS`.

- A new record starts on m³, as today. Nothing changes for the users and e2e flows that enter volumes.
- **Found during apply: order alone is not enough.** The form starts on Electricity in kWh, and a category change kept any unit the new category offers. Once kWh is in the TR gas list, picking Natural Gas, or arriving by a dashboard link, would keep kWh.
  - The page therefore records the category a unit was chosen for (`unitCategory`): by the user, as an opened or copied record's own, or as a category's first unit.
  - A unit carried over from another category is replaced by the new category's first unit, once the geography is known.
  - A geography change alone (a site or subsidiary) keeps the unit exactly as before. An unchosen m³ on a new TR record moved to a UK site stays m³, and TR marine gas oil on kg moved to the UK stays on kg (`architect` review of a first, boolean version, which re-defaulted on any geography change).
  - **Changed outside TR gas:** a unit no longer carries over a category change. For example, UK Electricity in MWh → Natural Gas now starts on kWh. The category change already clears the figure, so no number is lost.
  - **Kept:** *New* after an opened record keeps that record's category and unit, as it always has (an Sm³ record carried Sm³ before this change). After an opened kWh bill, New therefore offers kWh with an empty basis choice, which holds the save until a basis is chosen (`security-rls` and `architect` note; not changed, by the pre-pilot rule).
- An opened or copied kWh record keeps its unit through the existing own-unit and copy-tuple rules. kWh is now also in the TR list, so a UK kWh copy moved to TR keeps its unit and its figure. With no basis, it then waits for one.
- **Alternative: kWh first, because Turkish bills quote kWh.** Rejected for this change. It would silently change the default of every new TR gas record, and that is the owner's call, not a side effect. It is a one-line swap if the owner wants it.

### 2. The basis is a required choice with no default

The read-only `StoredCalorificBasis` becomes `CalorificBasisChoice`, a two-option radio group (shadcn `radio-group`) titled with the existing `inputs.cvBasis.title`.

- It shows in the `natural_gas_energy` mode only, so only for TR gas in kWh/MWh.
- Neither option is selected unless the record stores one: a new record, a UK copy brought to TR, or a figure re-entered after a round trip outside TR.
- A short help line says where the bill states it: gross is the upper calorific value (TR: *üst ısıl değer*), net the lower (*alt ısıl değer*). It does not suggest that either is usual, so it never nudges the author.
- **Gating:**
  - `gasEnergyIssue(inputs, mode)` returns `basis_missing` when the mode is `natural_gas_energy` and `cvBasis` is null.
  - `hasValidInput` requires no issue. Without a basis there is then no preview call and the save buttons stay disabled.
  - The choice shows the field error `inputs.cvBasis.missing` (TR/EN), like the gas inputs' existing issue line. The API's `parameters_required` stays the backstop for direct callers.
- **A basis change keeps the quantity.** The figure is what the bill says; the basis only says how to read it. So correcting the basis is not re-entering the bill.
  - The API's re-entry rule (`activity_value_reentry_required`) is not met, because Data Entry always sends the quantity.
  - A unit change still clears the figure, and an energy↔volume move still clears the basis (existing rules).
- **Alternative: preselect gross, because bills are usually gross (v2.5 §1.3.3).** Rejected. A wrong default is a silent ~11% error in either direction. The engine design's risk analysis relies on the basis having no default.

### 3. The derived net figure comes from the factor's release, through `GET /factors/parameters`

**API:**
- `ReleaseParametersQuery` gains `unit?: string`, which the DTO validates `IsIn` the unit vocabulary.
- In `releaseParameters`, natural gas with `unit` kWh or MWh calls `lookupFactorPath(…, unit, 'net')`, the call the engine makes, and returns `path.factor.release`'s parameters.
- Every other gas unit, and no unit, keeps today's Sm³ lookup and the conversion's release. Refrigerants ignore `unit`.
- TR therms and GJ return no release, because the engine refuses them too.

**Web:**
- `api.releaseParameters` passes `unit`.
- The release effect no longer skips the energy mode: in it, the effect reads with `unit: activityUnit`. A kWh↔MWh change re-reads, which is harmless.
- `derivedNetQuantity(quantity, rows)` (`lib/record-inputs-view.ts`) returns `{ ratio, net }` when both `reference_ncv` and `reference_gcv` are present and the ratio lies in (0, 1), and `null` otherwise. It never falls back to a constant.
- The choice shows, under gross: "≈ 901.15 kWh net (× 0.901147 = 8,250 / 9,155, *publisher edition*)". The figure is in the record's own unit: 2 fraction digits for kWh, 4 for MWh, by the user's locale.
- A failed or empty read shows no derived line and never blocks the save. The preview, which prices from the same rows, stays authoritative and keeps its own `gross-to-net-note`.

**Why the endpoint rather than the preview's ratio:**
- v2.5 asks for the correction to be shown next to the choice, as part of the input.
- The preview panel answers only after a complete, debounced preview, in another section of the page.
- The endpoint answers as soon as gross is chosen, without pricing anything.
- The card (LP4-06) and `ng-kwh-engine`'s `architect` review already assign this read to `ng-kwh-form`.

**One lookup, so the two ratios cannot differ.** The endpoint and the engine call the same `lookupFactorPath` with the same arguments. A service spec puts the factor and the Sm³ conversion in different releases with different ratios, and asserts:
- that the kWh read returns the factor's release;
- that the engine's `grossToNetRatio` for the same lookup equals the endpoint's rows' ratio.

**Alternative: compute the ratio on the client from the Sm³ read.** Rejected. That is the conversion's release, which is exactly the release the engine design refused to read for this path.

### 4. Existing live requirements are restated, not worked around

- *A copy moved across the TR rules is narrowed like a new record* used a UK kWh copy as its example. kWh is now offered under TR, so the example becomes therms, which TR still does not offer. The kWh copy now keeps its unit and figure and asks for the basis.
- *Back to Türkiye after the figure was entered again*: "no basis is shown" becomes an empty, required choice. The guarantee that the figure is never priced as net is unchanged.
- *Data Entry carries a stored calorific basis*: the stored basis is preselected and editable.

The e2e spec's round-trip assertion (`natural-gas-energy-bill.spec.ts`, the `gas-energy-basis` absence check) moves with it. It now asserts that no option is selected and that nothing is saved before one is chosen.

### 5. Tests that can tell 0.901147 from 0.9

The e2e fixture's ratio is 0.9, so the release ratio is proven elsewhere:
- **Web spec:** `derivedNetQuantity` with rows 8,250 / 9,155 gives 901.147 for 1,000. Missing, zero, inverted (≥ 1) or absent rows give `null`.
- **Service spec:** the kWh read returns the factor's release (Decision 3). It is the only test that can tell the factor's release from the conversion's: on the TR package both are one release, so the int assertion that ties the endpoint's release to the priced one cannot (`qa-auditor` review).
- **`tr-factor-package.int.spec.ts`:** on the real TR release, the kWh read for 2025 returns `reference_ncv` 8,250 and `reference_gcv` 9,155.
- **Local live check:** on the real release, a form-entered 1,000 kWh gross shows 901.15 kWh net and saves at 182.17 kg. 1 MWh gross gives 182.17 kg, and 1,000 kWh net gives 202.16 kg (GV-NG-kWh-A/B; C is unchanged from the engine).
- **e2e (fixture ratio 0.9, factor 0.2):** 1,000 kWh gross shows 900 kWh net and saves at 180.00 kg. Net saves at 200.00 kg. 1 MWh gross gives 180.00 kg. Without a basis, the save stays disabled and nothing is sent.

## Risks / Trade-offs

- **[Risk] The author picks the wrong basis** → there is no default. The help line names both bill terms, gross shows its derived figure, and the review sheet shows the basis for the D01 check. The engine cannot tell the two apart; that is as `ng-kwh-engine` left it.
- **[Risk] The endpoint and the engine resolve different releases** → both use one lookup function with the same arguments, and a spec puts the factor and conversion in different releases. The preview's ratio note stays as a second display from the snapshot.
- **[Risk] The default unit moves** → the order is explicit, and `record-inputs-view.spec.ts` pins m³ first and the four units.
- **[Risk] A late release read overwrites a newer form** → the effect keeps its `active` guard (*A late answer never overwrites a newer form*), and the derived line is recomputed from the current quantity on every render.
- **[Trade-off] `kWh` reads the same in the gas and electricity lists** → the lists never mix (category filter, BUG-04), and the form's title names the category. The label is filed under Open Questions, not changed here (pre-pilot rule).

## Migration Plan

- No migration and no snapshot change. The image deploys through `QA deploy` on merge.
- The endpoint change is additive: an old web never sends `unit`, and a new web against an old API gets the Sm³ release. During a rollout the derived line may then be missing or wrong for a moment, while the preview stays correct. QA serves one image pair, so that window is the rollout only.
- Rollback: the previous revision (`ci74-1`) has the same migration chain, so both the automatic rollback and the on-demand `QA rollback` apply. A draft saved in kWh by the new form stays valid under the old image, which already prices it.

## Open Questions

- BUG-04 asked for "kWh (doğal gaz)" as its own label. Today both lists say `kWh`, kept apart by category. Whether the gas list should label it "kWh (natural gas)" is a copy question. It is filed for the owner and does not change this change's behaviour.
