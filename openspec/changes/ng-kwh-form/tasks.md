# Tasks

## 1. Shared types: the TR gas unit list and the parameters query

- [x] 1.1 `unitsForRecord` returns TR natural gas as m³, Sm³, kWh, MWh in that explicit order (design Decision 1), and its doc comment drops the "once `ng-kwh-form`" note. Verify: `record-inputs-view.spec.ts`'s "offers TR natural gas in Sm³ and m³ only" becomes a four-unit, order-pinned test (m³ first); a UK gas list and the TR Mobile/MGO lists are unchanged; `pnpm --filter @tonyai/shared-types test` and the web spec pass.
- [x] 1.2 `ReleaseParametersQuery` gains an optional `unit`. Verify: `pnpm typecheck` passes across api and web.

## 2. API: `GET /factors/parameters` resolves the energy path

- [x] 2.1 `ReleaseParametersQueryDto` takes an optional `unit`, `IsIn` the unit vocabulary. Verify: a controller/DTO spec refuses `kwh_gas` with 400 and accepts `kWh`, `MWh`, `standard_cubic_metres`, or no unit.
- [x] 2.2 `CalculationsService.releaseParameters`: natural gas in kWh or MWh resolves through `lookupFactorPath(…, unit, 'net')` and returns the factor's release. Every other gas unit, and no unit, behaves as before, and TR therms and GJ return no release. Verify in `calculations.service.spec.ts`:
  - a fixture with the factor and the Sm³ conversion in **different** releases with different ratios: kWh returns the factor's release, Sm³ and no unit the conversion's;
  - UK kWh returns `{ release: null, parameters: [] }`;
  - the engine's `grossToNetRatio` for the same lookup equals the ratio of the kWh read's rows.
- [x] 2.3 `tr-factor-package.int.spec.ts`: on the real TR release, the 2025 kWh read returns `reference_ncv` 8,250 and `reference_gcv` 9,155. Verify: the spec passes on a CI-shaped database (`RATE_*_PER_MINUTE` raised, `test:int` gated on `pgrep`).
- [x] 2.4 `docs/api/endpoints.md`, the `GET /factors/parameters` row: the `unit` query, the factor's release for a gas energy unit, and the unchanged default. Verify: the row matches the specs' *Release parameters for a gas energy bill*.

## 3. Web: the basis choice and the derived net figure

- [x] 3.1 `lib/record-inputs-view.ts`:
  - `gasEnergyIssue` returns `basis_missing` for the energy mode without a basis;
  - `derivedNetQuantity(quantity, rows)` returns `{ ratio, net }` only when both reference rows are present and the ratio lies in (0, 1).

  Verify in `record-inputs-view.spec.ts`: 1,000 with 8,250 / 9,155 gives 901.147; missing, zero, absent or ratio ≥ 1 rows give `null`; there is no 0.9 fallback.
- [x] 3.2 `lib/api.ts` `releaseParameters` passes `unit`. In `app/data-entry/page.tsx`, the release effect reads in the energy mode with `unit: activityUnit`, keeping its `active` guard. A failed read in that mode hides the derived line and never blocks the save. Verify: web spec or page-level test; typecheck.
- [x] 3.3 `components/data-entry/record-inputs.tsx`: `CalorificBasisChoice` (shadcn radio group) replaces `StoredCalorificBasis`. It has no default, preselects a stored basis, shows the help line, shows the `basis_missing` field error, and under gross shows the derived net in the record's unit with the ratio and the release cited. `hasValidInput` requires no `gasEnergyIssue`, and a basis change keeps the quantity. The `gas-energy-basis` test ids are kept or renamed in the e2e spec in the same change. Verify: web unit tests; keyboard selection (arrow keys, Space) works; the existing unit-change, own-basis, copy-tuple and leave-TR specs still pass.
- [x] 3.4 TR/EN catalogues (`dataEntry.json`, via the `localise-ui` skill): `inputs.cvBasis.help`, `inputs.cvBasis.missing` and `inputs.cvBasis.derivedNet`; `inputs.cvBasis.stored` is removed if unused. Verify: `messages.spec.ts` parity passes; no Turkish outside the `tr` catalogue.
- [ ] 3.5 Browser check against the local stack on the **real** TR release, at 1280 and 375 px, EN and TR:
  - a new TR gas record offers m³, Sm³, kWh and MWh and starts on m³;
  - kWh without a basis disables save and shows the missing line;
  - 1,000 kWh gross shows ≈ 901.15 kWh net × 0.901147 and saves at 182.17 kg;
  - 1 MWh gross saves at 182.17 kg;
  - 1,000 kWh net saves at 202.16 kg (GV-NG-kWh-A/B, within ±0.5%);
  - no horizontal scroll.

## 4. e2e

- [x] 4.1 `e2e/natural-gas-energy-bill.spec.ts` (via the `e2e-flow` skill; locks checked per the lane rule). Form-created cases on the TR fixture (ratio 0.9, factor 0.2):
  - kWh with no basis: save disabled, no POST sent;
  - gross 1,000 kWh: shows 900 kWh net and saves at 180.00 kg with `cvBasis` `gross`;
  - net 1,000 kWh: saves at 200.00 kg;
  - 1 MWh gross: 180.00 kg;
  - a basis switch keeps the quantity.

  The round-trip case now asserts an empty choice and no save before a basis is chosen. Verify: the spec and its neighbours (`data-entry-tr-inputs`, `uat2-team-decisions`, `void-record`) pass locally on capped built servers with CI's `RATE_*_PER_MINUTE` overrides.

## 5. Verification, review and status

- [x] 5.1 Full local gate: `pnpm typecheck`, lint (0 errors), `pnpm build`, `pnpm test` (api, shared-types, db, web). Verify: all green, with counts recorded for the status entry.
- [ ] 5.2 Fresh-eyes review before the PR: `security-rls`, `qa-auditor` and `architect` in parallel, each on its own `git archive` copy, only one seat running `test:int`. Probes:
  - can a kWh record reach the API without a basis from the form;
  - can the shown ratio differ from the applied one;
  - did the default unit move;
  - does any live requirement still contradict the new choice;
  - are the DTO and contract surface consistent.

  Verify: every blocker is fixed and re-reviewed. Non-blocking findings go under Open questions.
- [ ] 5.3 `docs/roadmap_docs/project_status_roadmap_phases.md`: a Current status entry (moving the oldest to Archive if an eleventh), Next up item 4, and the LP4-06 card (`ng-kwh-form` ticked; the done-when met) and ledger row. The BUG-04 label question goes under Open questions. Verify: no other status file was touched, and the entry links the PR.

## Workflow follow-up

- Open the PR (`feat/ng-kwh-form`) with green CI; the owner merges.
- Confirm the QA deploy run and its revision after the merge, then record them.
- Archive the change with `/opsx:archive` (syncing `activity-data-entry` and `emission-factor-library`), and mark LP4-06 done in the same archive PR.
- Next: LP4-07 (`self-gen-model`).
