# Tasks

## 1. Contract: the ceiling rule

- [x] 1.1 In `packages/shared-types/src/index.ts`, beside the anomaly constants, add `FIRST_PERIOD_CEILINGS`, `CEILING_UNIT_MULTIPLIERS` and `firstPeriodCeiling(...)` as in design D2.
  - Marine gas oil is checked before the Mobile Combustion kg row.
  - Refrigerants use the largest `parameters.equipment[].capacityKg`; with no lines, the result is `null`.
  - The comparison is a strict `>` in base units.
  - The JSDoc cites Decisions 2026-11-12, says "plausibility guard, not a factor", and states that the m³ row reuses the Sm³ number and is not a conversion.
  - Verify with `pnpm --filter @tonyai/shared-types typecheck`.
- [x] 1.2 Add `withFirstPeriodCeiling(historyVerdict, ceilingInput)` (design D3) and extend the derived helpers (design D1, D6).
  - `AnomalyBasis` gains `'ceiling'`, and `anomalyBasis` returns it for flag true with count 0.
  - `isAnomalyEvaluated` is true for that state.
  - Add `isLegacyPreCeilingVerdict(record)`: count 0, unflagged, ceiling above. It takes the record's amount fields.
  - Register `variance_reason_required: ['basis']` in the error param-key registry, with a JSDoc saying `basis` is `history` or `ceiling`.
  - Update the JSDoc of `AnomalyVerdict`, the record DTO's verdict fields and the three column comments in `packages/db/prisma/schema.prisma` (comments only, no migration), so that none says a count of 0 is never flagged.
  - Verify with `pnpm --filter @tonyai/shared-types typecheck`.
- [x] 1.3 Add cases to `packages/shared-types/src/index.spec.ts`. Flip the existing assertion that a first-period record is never flagged, deliberately; do not delete it.
  - Every spec scenario of the requirements "First-period ceilings", "Marine gas oil has its own ceiling", "Other units reach the same ceiling by definition" and "Refrigerants are checked per equipment line": 4,500,000 kWh flagged, 1,000,000 kWh not, 1,200 MWh flagged, 20,000 UK gal not, 260,000 m³ flagged, MGO 400,000 kg not and 1,200 t flagged, road 120,000 kg flagged, Fuel 120,000 kg not, lines 120 + 650 flagged, six × 100 not, no lines `null`, a Scope 3 category `null`.
  - Every unit in `CATEGORY_UNITS` of a ceiling category resolves to a ceiling.
  - `withFirstPeriodCeiling` never touches a verdict with count ≥ 1 or null; a zero average stays not checked.
  - `anomalyBasis`, `isAnomalyEvaluated` and `isLegacyPreCeilingVerdict` for each state.
  - Verify with `pnpm --filter @tonyai/shared-types test`, then rebuild `dist` with `pnpm --filter @tonyai/shared-types build`.
- [x] 1.4 Update the rule's documents:
  - `docs/md_docs/validation_anomaly_rules.md` §4.1: the ceiling table, units, MGO, refrigerant lines, first period only, and the "K4 undecided" paragraph replaced.
  - `docs/md_docs/calculation_logic.md` §7.
  - `docs/md_docs/functional_requirements.md` (the anomaly rule's line).
  - Verify that `grep -n "K4" docs/md_docs/validation_anomaly_rules.md` no longer calls the first-period case undecided.

## 2. API: the gate, bulk paths, matrix and reports

- [x] 2.1 Extend `AnomalyParams` with `activityValue`, `activityUnit` and `parameters` in `apps/api/src/activity-records/activity-records.service.ts`, and apply `withFirstPeriodCeiling` in `detectAnomalyFor` (design D3).
  - Pass the values that will be stored on create (`previewCreate`), on update (the merged record) and on submit.
  - Verify with `pnpm --filter @tonyai/api typecheck`.
- [x] 2.2 Give `VarianceReasonRequiredError` a `basis` and send `params: { basis }`. Add `CEILING_VARIANCE_REFUSAL` in `apps/api/src/activity-records/errors.ts`, and pass the basis at the submit gate (design D4).
  - Make bulk submit's mapping forward the error's message unchanged.
  - Make `warnIfUnsubmittable` in `bulk-upload.service.ts` name the ceiling when the preview's basis is `ceiling`.
  - Verify with `pnpm --filter @tonyai/api typecheck`.
- [x] 2.3 Add an API spec asserting that every `CEILING_UNIT_MULTIPLIERS` entry equals the multiplier for that unit in `apps/api/src/calculations/normalization.ts` (design D2). Verify with `pnpm --filter @tonyai/api test`.
- [x] 2.4 Update `apps/api/src/activity-records/activity-records.service.spec.ts`:
  - A first-period electricity record of 4,500,000 kWh is saved flagged, with count 0 and average null.
  - Its submit with no reason is refused with `variance_reason_required` and `params.basis` `ceiling`; no update and no audit row are written.
  - The same submit with a reason succeeds.
  - A history flag's refusal carries `basis` `history`.
  - An update that lowers the amount below the ceiling clears the flag.
  - A record with one earlier period is never judged by the ceiling.
  - A zero average above the ceiling is not flagged.
  - Approve of a ceiling-flagged record is not refused for the anomaly.
  - Verify with `pnpm --filter @tonyai/api test`.
- [x] 2.5 Update the bulk specs:
  - `bulk-upload.service.spec.ts`: a first-period row above its ceiling with no reason gets `would_block_submit`, and the message names the ceiling; with a reason it does not; an equipment-line row above 500 kg is warned.
  - `bulk-submit.service.spec.ts`: a ceiling-flagged January with no reason is refused with a message naming the ceiling; a new series' January and February are judged by the ceiling and by history in period order.
  - Verify with `pnpm --filter @tonyai/api test`.
  - Correction (owner review, 2026-11-13): the bulk spec mocks the verdict, so it proves the warning's wording, not the ceiling itself. The equipment-line ceiling is proven through the record service in 2.7 and 8.4; the bulk-submit test title was narrowed to what it shows.
- [x] 2.6 Add a `ceiling` state to `anomalyColumnState` in `apps/api/src/reports/report-data.ts`, so it is never re-derived as "limited". Give it the cells from design D5 in `report-columns.ts` (`anomalyCell`), `report-vocabulary.ts` and `apps/api/src/reports/i18n/{en,tr}.json`.
  - Update `report-vocabulary`, `reports.service` and `report-columns-inputs` specs, and `emissions.service.spec.ts`: a committed ceiling flag turns its cell amber and is not counted in `notEvaluatedRecordCount`.
  - Verify with `pnpm --filter @tonyai/api test`.
- [x] 2.7 Add integration cases to `apps/api/test/int/anomaly-short-history.int.spec.ts`, or to a new `anomaly-ceiling.int.spec.ts` in a series no other suite uses, on the real database:
  - A first-period record above a ceiling: submit is refused without a reason (with `params.basis`) and succeeds with one, storing flag true, count 0 and average null.
  - A refrigerant record with a 650 kg line is flagged.
  - An MGO record of 400,000 kg is not.
  - Verify with `pnpm --filter @tonyai/api test:int` (CI's `RATE_*_PER_MINUTE=10000` env set).
  - Full integration run (2026-11-13): 1,132 of 1,135 passed. The three failures were K11 freshness cases in `calculation-staleness.int.spec.ts` whose first periods (123,456.789 MWh and US gallons) are now above their ceilings. Those fixtures were given a variance reason, and the file passes 23/23.
- [x] 2.8 Update the docs:
  - `docs/api/endpoints.md`: the submit refusal's `basis` param, and that the anomaly fields can hold a first-period ceiling flag.
  - `docs/md_docs/data_entry_page.md`: the anomaly card on a first-period record above a ceiling.
  - `.claude/skills/workflow-gate/SKILL.md`: its anomaly-baseline line.
  - Verify that each names the ceiling and the `basis` param.

## 3. Database scripts and seed

- [x] 3.1 Make `seedVerdict` in `packages/db/prisma/seed.ts` apply `withFirstPeriodCeiling` with each seeded record's amount fields. Keep the seed's guards, so that a seeded first-period record above a ceiling fails the seed loudly unless it is staged with a reason. Verify with `pnpm --filter @tonyai/db typecheck`.
- [x] 3.2 Make `freshVerdict` in `packages/db/scripts/anomaly-recompute.lib.mjs` apply the ceiling: the shell reads `activity_value`, `activity_unit`, `activity_type` and `parameters`.
  - Add the pre-ceiling known difference (design D6): left alone on a committed record and not counted as unrepaired; re-scored on a draft or a rejected record.
  - Update `anomaly-recompute.lib.spec.mjs`, including that `unexplained_flag` still stops a ceiling flag on a record in review that has no reason.
  - Verify with `pnpm --filter @tonyai/db test` (or the lib spec's own runner).
- [x] 3.3 In `packages/db/scripts/anomaly-probe.lib.mjs`, add the ceiling table and multipliers as exported plain data, and add the SQL ceiling expression to `BASE_SQL`, with the refrigerant line via `jsonb_array_elements`.
  - Expected verdict for count 0: flag = above.
  - Add a known-difference class for pre-ceiling committed records that does not affect the exit code.
  - Keep "flag with count 0, not above" as drift.
  - Update the `.d.mts` and the script's printed sections in `anomaly-probe.mjs`.
  - Verify with `pnpm --filter @tonyai/db typecheck`.
- [x] 3.4 Extend `apps/api/test/int/anomaly-probe.int.spec.ts`:
  - The probe lib's ceiling table and multipliers equal the contract's.
  - Run the probe's own SQL over rows built for: a ceiling flag stored correctly (no drift), a pre-ceiling committed record (known difference), a flag with count 0 below the ceiling (drift), and a refrigerant line above 500 kg.
  - Verify with `pnpm --filter @tonyai/api test:int`.
- [x] 3.5 Run `pnpm db:seed` twice against the local database, then `pnpm anomaly:probe`, `pnpm anomaly:recompute` (dry run) and `pnpm rls:probe`. Verify that:
  - The seed succeeds both times with the same record counts.
  - The probe reports no drift.
  - The recompute dry run proposes no rewrite of a committed record.
  - Record how many seeded records the ceiling flags.
  - Result (2026-11-13): seed twice OK (96 records both runs); probe exit 0, no drift, 2c lists 0; recompute dry run 0 stale; rls:probe passed. The seed has no first period above a ceiling, so the ceiling flags 0 seeded records.
- [x] 3.6 Update `docs/development/commands.md` (`anomaly:probe` and `anomaly:recompute`: the ceiling and the pre-ceiling known difference). Verify that the documented sections match the script's output.

## 4. Web: the statement, the refusal and their copy

- [x] 4.1 In `apps/web/lib/anomaly-view.ts`, add the `flaggedCeiling` branch for the three rows of design D5. It uses tone `flagged`; its figures come from `firstPeriodCeiling` and are formatted by locale.
  - Keep `isFirstPeriodRecord` as it is.
  - Add the TR and EN keys to `apps/web/messages/{en,tr}/anomaly.json`.
  - Verify with `pnpm --filter @tonyai/web typecheck`.
- [x] 4.2 Give `variance_reason_required` a ceiling sentence in `apps/web/messages/{en,tr}/errors.json` (`errors.variants.variance_reason_required.ceiling`), chosen by `params.basis` in `lib/i18n/errors.ts`; the code's own sentence keeps today's history text (design D4; ICU `select` is not allowed by the catalogue rule).
  - In `apps/web/app/data-entry/page.tsx`, make the pre-submit toast use a ceiling variant of `anomalousBeforeSubmit` (`dataEntry.json`, TR and EN) when `anomalyBasis` is `ceiling`.
  - Follow the `localise-ui` skill.
  - Verify with `pnpm --filter @tonyai/web typecheck`.
- [x] 4.3 Update the web specs:
  - `apps/web/lib/anomaly-view.spec.ts` and `apps/web/lib/i18n/turkish-views.spec.ts`: one case per design D5 row, in EN and TR, with the amount and the ceiling in MWh for an MWh entry, and the line case.
  - `apps/web/lib/i18n/messages.spec.ts`: the `select` renders `ceiling`, `history` and no param.
  - A case showing that the review queue's first-period mark is not shown for a ceiling flag.
  - Verify with `pnpm --filter @tonyai/web test`.
- [x] 4.4 Read the call sites that render the statement or the flag (`data-entry/page.tsx`, `review/page.tsx`, `emissions/page.tsx`, `lib/dashboard-view.ts`), and confirm that none needs a logic change beyond 4.2. Verify by listing each call site and its verdict in the task notes.
  - Call sites (2026-11-13):
    - `review/page.tsx`: the sheet passes the whole `ActivityRecordDTO` to `anomalyStatement` (headline and detail in the amber block). The queue row reads `anomalyFlag` for the amber triangle, and `isFirstPeriodRecord` stays false for a ceiling flag. No change.
    - `emissions/page.tsx`: the drawer passes the whole DTO, and the history table reads the flag. No change.
    - `lib/dashboard-view.ts` and `app/page.tsx`: the alert follows the cell's `anomaly` flag. No change.
    - `data-entry/page.tsx`: the amber card prints the statement's detail plus `anomaly.verifyAndExplain`. `verdictOf` now also carries the saved amount fields (a data pick, no logic), and the pre-submit toast has the ceiling variant (task 4.2).
- [x] 4.5 On the running app (built, capped single-process servers, not full `pnpm dev`), enter a new site's first electricity month of 4,500,000 kWh in Turkish. Verify that:
  - Data Entry shows "İlk dönem tavanının üstünde" with 4.500.000 kWh and 1.000.000 kWh.
  - Submit without a reason is refused with the ceiling text.
  - Submit with a reason succeeds.
  - The review sheet and the emissions drawer show the same statement, the matrix cell is amber, and the CSV cell names the ceiling.

  - Verified (2026-11-13) on the running app (Playwright: the API built and started from `dist`, the web on `next dev`) through `e2e/anomaly-typo-ceiling.spec.ts`:
    - Data Entry (EN) states "4,500,000 kWh is above the plausibility ceiling of 1,000,000 kWh"; submit without a reason shows the ceiling toast, and submit with one goes through.
    - The review sheet in Turkish shows "İlk dönem tavanının üstünde" with 4.500.000 / 1.000.000 kWh and the reason.
    - The matrix cell is amber with `notEvaluatedRecordCount` 0, and the CSV cell reads `yes (above the first-period ceiling)`.
    - The emissions drawer was not opened live. It renders the same `anomalyStatement` from the whole DTO, which the web unit specs cover.

## 5. End-to-end and UAT

- [x] 5.1 Re-trace every e2e spec that creates a first-period record in a ceiling category with a large amount (`gates.spec.ts`, `review-gate.spec.ts`, `bulk-submit-refusals.spec.ts`, `anomaly-short-history.spec.ts`, `uat2-team-decisions.spec.ts`, `data-entry-happy.spec.ts` and any other spec found by grepping `e2e/` for amounts ≥ 100,000). Verify that each is either below its ceiling or expects the flag. List each spec and the outcome in the task notes.
  - Result (2026-11-13): every e2e amount of 100,000 or more is Electricity in kWh, below the 1,000,000 kWh ceiling. `drafts-bulk-submit` and `bulk-submit-refusals` use 120,000; `bulk-upload-panel` uses 145,000; `gates` uses 500,000, on a series with three priors (history, not the ceiling). The helpers default to 3–10. No spec needs a change.
- [x] 5.2 Add an e2e flow, `e2e/anomaly-typo-ceiling.spec.ts`, in a subsidiary, category and period lane no other spec uses or locks (check `lockPeriod` and the subsidiary across `e2e/` first):
  - A first period above the electricity ceiling shows the ceiling statement, is refused without a reason, and is submitted with one.
  - A first period below the ceiling shows "İlk dönem kaydı".
  - It cleans up after itself.
  - Verify with `pnpm e2e -- anomaly-typo-ceiling` (with the `TONYAI_TEST_PASSWORD` and `RATE_*` env).
- [x] 5.3 Update `docs/uat/uat_round2.md` (the ANOM cases: a new case for each ceiling family, and the refrigerant line case) and `.claude/skills/e2e-flow/SKILL.md` (safe first-period amounts below the ceilings). Verify that both list the ceilings as the spec states them.

## 6. Integration, review and records

- [x] 6.1 Run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` from the repository root. Verify that all four pass, and report any failure with its output.
- [x] 6.2 Run the fresh-eyes review pass in parallel, each seat with a self-contained prompt (branch, diff range, what changed and why), and fix or file what they find. Verify that each seat's report states what it verified.
  - `security-rls`: the submit gate cannot be passed without a reason on a ceiling flag, by single submit, bulk submit or update; the history query's tenant scoping is unchanged; the error params leak nothing across tenants.
  - `qa-auditor`: the ceiling and unit boundaries, MGO before Mobile kg, the refrigerant line, the zero-average and no-figure edges, the consistency tools' known difference, and the flipped assertions.
  - `architect`: the contract additions (`AnomalyBasis`, the param key, the ceiling table, the parity specs, no migration).
  - Results (2026-11-13): no seat found a P1.
    - **`architect`.** P2s fixed: `VarianceBasis`, `varianceBasisOf` and the sentence selectors (`API_ERROR_SENTENCE_SELECTORS`) moved into the contract, and `messages.spec` checks every basis has a sentence. The `localisation.md` and `localise-ui` doc gaps are fixed; the probe builds and pins the MGO type; the `isAnomalyEvaluated` asymmetry is documented.
    - **`security-rls`.** No P2 defect. Its P2-design point (the refill amount had no ceiling) was decided by the owner on 2026-11-13 and is carried by group 8. The MGO-by-volume reliance is now a comment in the contract.
    - **`qa-auditor`.** P2 fixed: the edit-save toast now has a ceiling variant (`editMode.savedAboveCeiling`). P3s fixed: the probe's listing label for a baseless flag, the UAT steps ANOM-11 and ANOM-14, the Turkish "sapma gerekçesi" wording, and tests for "a draft meets the ceiling at its next save" and "a record scored before the ceilings".
    - Every other P3 is under Open questions ("First-period typo ceiling follow-ups").
- [x] 6.3 Update `docs/roadmap_docs/project_status_roadmap_phases.md` in this PR, as the earlier UAT2 changes did:
  - a Decisions entry for 2026-11-13: the owner's answers (definitional units, with m³ held to the Sm³ number; no ceiling for refrigerant records without lines; the `basis` param) and the design choices;
  - Open questions: "First-period typo ceiling follow-ups" and the review P3s. The refill question is decided and leaves this list (task 8.5).
  
  Current status and Next up (change 5 done, BUG-R2-07 fully met, change 6 next) are written by the archive PR after merge and deploy, as for changes 1–4; it also moves the oldest Current status entries to Archive (12 today; the rule is 10). Verify with `openspec validate uat2-anomaly-typo-ceiling --strict`.

## 7. Hosted QA check (owner)

- [x] 7.1 Write a read-only SQL query in this change's design Migration Plan, to be run by the owner on hosted QA. It counts draft and rejected records that are the first of their series and above a ceiling (open records that will need a reason at their next submit), and committed ones (the pre-ceiling known difference), by organisation and category. Verify by running it locally against the seeded database and comparing with `anomaly:probe`'s known-difference count.

## 8. Refrigerant refill ceiling (owner decision 2026-11-13, after the review)

- [x] 8.1 In `packages/shared-types/src/index.ts`, add `REFRIGERANT_REFILL_RATIO = 1.25`, with its JSDoc (EPA 40 CFR 82.157 as the yardstick, the owner's decision). Extend `firstPeriodCeiling` and `CeilingResult` as in design D2.
  - Per line, the refill ceiling is `min(1.25 × capacityKg, 500)`, or 500 when the capacity is 0, with a strict `>`.
  - Kind `equipment_refill` carries `capacityKg`. A capacity breach takes precedence, and the first breaching line is reported.
  - Add `index.spec.ts` cases for every new scenario of "Refrigerants are checked per equipment line": 10/50,000 flagged; 40/50 not; 40/51 flagged; 0/400 not; 0/600 flagged; 400/501 flagged. Add a case where a capacity breach is reported ahead of a refill breach on a later line.
  - Verify with `pnpm --filter @tonyai/shared-types test`, then rebuild `dist`.
- [x] 8.2 Add the refill check to `CEILING_ABOVE_SQL` in `packages/db/scripts/anomaly-probe.lib.mjs`: any line whose numeric `refillKg` is above `least(1.25 × capacityKg, 500)`, or above 500 when the capacity is 0 or not a number. Export `REFRIGERANT_REFILL_RATIO` as plain data and update the `.d.mts`.
  - Extend `apps/api/test/int/anomaly-probe.int.spec.ts`: ratio parity with the contract, a correctly stored refill flag (no drift), and an unflagged refill breach on a committed record (pre-ceiling known difference).
  - Add one `anomaly-recompute.lib.spec.mjs` case: a draft refill breach is re-scored to a flag.
  - Verify with `pnpm --filter @tonyai/db test` and `pnpm --filter @tonyai/api test:int` on those specs.
- [x] 8.3 In `apps/web/lib/anomaly-view.ts`, add the `equipment_refill` sentence (design D5), one key for the ratio limit and one for the 500 kg limit, in `apps/web/messages/{en,tr}/anomaly.json`. Add `anomaly-view.spec.ts` cases in EN and TR. Verify with `pnpm --filter @tonyai/web test` (the messages spec included).
- [x] 8.4 Add a case to `apps/api/test/int/anomaly-ceiling.int.spec.ts`: a TR refrigerant record with a line of 10 kg capacity and a refill of 50,000 kg is stored flagged and refused at submit with `basis` `ceiling`, and a line of 40 kg with a refill of 50 kg is not flagged. Verify with `pnpm --filter @tonyai/api test:int`.
- [x] 8.5 Update the docs:
  - `docs/md_docs/validation_anomaly_rules.md` (the ceiling table and the refrigerant bullet), `docs/api/endpoints.md`, `docs/md_docs/data_entry_page.md`, `docs/uat/uat_round2.md` (ANOM-16: the refill cases), `.claude/skills/e2e-flow/SKILL.md` (safe refill amounts).
  - The hosted query in design's Migration Plan, regenerated from the new `CEILING_ABOVE_SQL`.
  - The status file: the Decisions 2026-11-13 entry gains (4) the refill ceiling, and the Open questions item "The refill amount has no ceiling" is removed.
  - Verify with `openspec validate uat2-anomaly-typo-ceiling --strict` and a grep that no doc calls refill unguarded.
- [x] 8.6 Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, the anomaly and probe integration specs, and `e2e/anomaly-typo-ceiling.spec.ts`. Verify that all pass, and report any failure with its output.
- [x] 8.7 Re-review the delta: the PR has grown a second design after the first review pass (CLAUDE.md). Run `security-rls` (no way past the refill check, the SQL is constant-only) and `qa-auditor` (boundaries, the capacity-0 case, contract/probe parity, copy), in parallel. Fix or file what they find. Verify that each report states what it verified.

  - Results (2026-11-13): neither seat found a P1.
    - `security-rls`: no P2. Its P3 test gap is fixed: the probe int spec now runs the SQL's 0/600 and 400/501 branches. Its float8-cast note is filed.
    - `qa-auditor`: P2 fixed. A refill of exactly 125% of a decimal capacity was flagged (1.25 × 1.44 = 1.7999999999999998); the comparison now has a 1e-9 relative tolerance (`REFILL_CEILING_TOLERANCE`), in the contract and in the SQL, with tests in both (1.44/1.8). Its P3s are fixed (the flagged-side SQL branches; the ANOM-16 row order; the task 8.5 text) or filed under Open questions ("125%" in the copy, refill display rounding, the limit/ceiling wording).

## 9. Owner review of the branch (2026-11-13)

- [x] 9.1 K1 (owner decision): a zero average falls back to the ceiling.
  - Contract: `isCeilingEligible`, and `isCeilingFlag` (renamed from `isFirstPeriodCeilingFlag`, now taking the average). `withFirstPeriodCeiling` keeps history's count and average; `varianceBasisOf` uses the eligibility.
  - Reports: a `flagged_ceiling_zero_average` state, and the column is read through `isCeilingFlag`.
  - Web: a zero-average lead sentence and headline. The refusal and toast copy is neutral ("no usable history").
  - Probe SQL and the re-score tool are updated to match.
  - Tests: contract, service (the old "does not fall back" case flipped deliberately), reports, recompute lib, probe int, and an API int test with January 0 kWh then February 50,000,000 kWh.
- [x] 9.2 K2 (owner decision): metered m³ with a volume correction factor is held to the Sm³ ceiling as m³ × factor (kind `corrected_volume`), in the contract and the probe SQL. Tests: contract, web (EN/TR), probe int, API int (240,000 m³ × 30 flagged, × 1 not).
- [x] 9.3 K3 (owner decision): the per-line rule stays. `validation_anomaly_rules.md` and UAT ANOM-14 say that a line is one equipment type, not one device.
- [x] 9.4 First review's P2s:
  - `isLegacyPreCeilingVerdict` and the probe's `pre_ceiling` require the stored count and average history gives (a count of 0 with no average, or an average of 0). The recompute tool also requires them to equal today's.
  - `anomaly:recompute` prints a ceiling flag as one (`describeVerdict`).
  - Tests: an average of 99 beside count 0 is drift, and the printout cases.
- [x] 9.5 Docs and tests from the second review:
  - Design: the hosted query is regenerated (refill tolerance, K1, K2); the rollback note covers the operator tools; the D5 report wording matches the code; the misplaced JSDoc is fixed.
  - Tests: exact-ceiling boundaries (9,000 GJ, 1,000 MWh, 2,500 MWh, 150,000 kg Fuel, 100 t Mobile, 200,000 Sm³).
  - e2e: the tautological headline assertion is replaced and the teardown delete is checked.
  - The rest is under Open questions.
  - Verify with `openspec validate uat2-anomaly-typo-ceiling --strict`.
- [x] 9.6 Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, the full integration suite and `e2e/anomaly-typo-ceiling.spec.ts`. Verify that all pass.

## Workflow follow-up

- Commit and push on the owner's word; the owner reviews the branch, then asks for the PR. The owner merges.
- Before merge, the owner runs task 7.1's query on hosted QA, and the counts go into the PR body.
- After merge and the QA deploy: QA retests BUG-R2-07 (ceiling cases); add the archive PR (sync the `anomaly-check` deltas, Current status and Next up → change 6 `uat2-refrigerant-multigas-design`).
