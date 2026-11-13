# Design

## Context

See `proposal.md` for the motivation and `specs/anomaly-check/spec.md` for the required behaviour. The facts below were read from the code on 2026-11-13.

- **The history rule.** It lives in `packages/shared-types/src/index.ts`, around lines 4586–4768:
  - `computeAnomalyVerdict(currentTCo2e, priors)` returns `{ anomalous: false, priorCount: 0, baseline: null }` when the window holds no figure. That is the first-period state.
  - `anomalyBasis` returns `'full' | 'limited' | null`.
  - `isAnomalyEvaluated` is true for a count of 1–3 with an average that is neither null nor zero.
  - The rule compares tCO2e, not the activity amount.
- **The API.** `ActivityRecordsService.detectAnomalyFor` / `detectAnomaly` (`activity-records.service.ts:853`, `:877`) receive the figure and the series key, but not the amount, unit, activity type or parameters.
  - The verdict is written on create (via `previewCreate`, which bulk import also uses), on update and on submit.
  - Submit refuses at `:1578` with `VarianceReasonRequiredError`. It has no params, and its message is `VARIANCE_REFUSAL`, "deviates significantly from the historical average".
- **The stored verdict.** It is three columns: `anomalyFlag`, `anomalyBaselinePriorCount` and `anomalyBaselineTCo2e`. No version of the rule has ever written a flag beside a count of 0.
- **Amounts.** `activityValue` is stored in the canonical `activityUnit`.
  - The definitional conversions (MWh, GJ, therms, gallons, tonnes) live in the API's `calculations/normalization.ts`, not in the contract.
  - Refrigerant records under TR carry `parameters.equipment[]`, each with a `capacityKg` and a `refillKg`. `activityValue` is the sum of the capacities. The emission per line is capacity × leak rate + refill (`tr-rules.ts`), so the refill weighs more than the capacity does.
  - Marine gas oil is Mobile Combustion, `activityType = 'marine_gas_oil'`, in kg or tonnes.
- **Who reads the verdict.** The web statement (`apps/web/lib/anomaly-view.ts`), the review queue mark, the report anomaly column (`reports/report-data.ts:116` `anomalyColumnState`, `report-columns.ts` `anomalyCell`, `report-vocabulary.ts`), the tracking matrix (`emissions.service.ts`: flag → amber; `isAnomalyEvaluated` → the not-checked count), the dashboard alert, and the two operator tools (`anomaly:probe`, an SQL mirror that imports nothing; `anomaly:recompute`, which uses the contract).
- **The earlier design's constraint (D9 of `uat2-anomaly-short-history`).** A count of 0 stays "not checked" until plausibility limits take that state over. A stored basis column was left for the third tier, if it needed one.

## Goals / Non-Goals

**Goals:**

- One implementation of the ceiling rule, shared by the gate, the seed, the re-score tool and the screens. The SQL probe is the only copy, and a parity test pins it.
- No migration, no new error code, no new endpoint.
- Existing committed records keep their verdict, and the consistency tools stay quiet about them.

**Non-Goals:**

- Re-scoring anything on deploy.
- A way to revise the ceilings at runtime. They are code constants, changed by a PR.
- Showing the ceiling on a record that is not above it. The first-period notice stays as change 1 shipped it.
- Moving the API's unit normalisation into the contract.

## Decisions

### D1. A ceiling flag is stored as flag true, count 0, average null, and its basis is derived

The ceiling applies where history cannot judge (`isCeilingEligible`): no figure in the window (count 0), or figures averaging zero (count ≥ 1, average 0). The latter was added by the owner on 2026-11-13 (K1 of the owner's review): a January of 0 must not let a February typo through. The count and the average are stored as history gave them. A flag beside a count of 0, or beside an average of 0, is a state no earlier rule wrote, so it identifies a ceiling flag without ambiguity. `AnomalyBasis` gains `'ceiling'`, and `anomalyBasis` returns it for `isCeilingFlag` (the flag and either state). `isAnomalyEvaluated` returns true for that state, so the matrix's not-checked count and the report's `anomalyEvaluated` leave it out without their own change.

Alternative considered: the stored basis column that D9 kept room for. It needs a migration and a backfill, and it would tell nothing the count and the flag do not. A manual flag (K4-3b) would have needed it, but the team chose reject-with-comment instead.

### D2. The ceiling table and its unit equivalences live in the contract

`packages/shared-types` gains:

- **`FIRST_PERIOD_CEILINGS`**, in base units, keyed by category and then base unit. Marine gas oil is an override keyed by activity type and is checked first. Refrigerants are the per-line rule. The values are the owner's (Decisions 2026-11-12):

  | Category | Base unit | Ceiling |
  |---|---|---|
  | Electricity | kWh | 1,000,000 |
  | Natural Gas | kWh | 2,500,000 |
  | Natural Gas | standard_cubic_metres | 250,000 |
  | Natural Gas | cubic_metres | 250,000 Sm³ for m³ × the record's own volume correction factor when it carries one (the TR rules), and otherwise the Sm³ number as a guard (K2, owner 2026-11-13) |
  | Mobile Combustion | litres | 100,000 |
  | Mobile Combustion | kg | 100,000 |
  | Mobile Combustion, `marine_gas_oil` | kg | 1,000,000 |
  | Fugitive Gas | standard_cubic_metres | 200,000 |
  | Fuel | litres | 100,000 |
  | Fuel | kg | 150,000 |
  | Refrigerants | kg per equipment line | 500 |
  | Refrigerants, refill | kg per equipment line | 125% of that line's capacity, capped at 500; 500 for a line with no capacity |

- **`REFRIGERANT_REFILL_RATIO = 1.25`** (owner, 2026-11-13, after the `security-rls` review). The refill on a line is held to `min(1.25 × capacityKg, 500)`, or to 500 when the capacity is 0. The DB allows that state when the refill is above 0, and "125% of nothing" would flag every refill.
  - The ratio is taken from US EPA 40 CFR 82.157: an owner must report to EPA when an appliance leaks 125% or more of its full charge in a calendar year. In other words, losing more than the whole charge in a year is the regulator's mark of an exceptional event.
  - That rule (US, appliances with ozone-depleting refrigerants) does not apply here. The number is the owner's decision; EPA's rule is its yardstick.
  - A normal year's loss is a fraction of the charge. EPA's repair triggers are an annual leak rate of 10–30%.
  - **Strictly above, within a relative tolerance of 1e-9** (`REFILL_CEILING_TOLERANCE`, qa-auditor re-review). 1.25 × a decimal capacity is rounded in binary (1.25 × 1.44 = 1.7999999999999998), and a refill of exactly 125% must not be flagged for the last bit of a double. The SQL copy applies the same factor.
  - Without the check, a first-period line of 10 kg capacity with a refill of 50,000 kg (an extra zero or three) went through without a reason, at about 10⁵ tCO₂e.
- **`CEILING_UNIT_MULTIPLIERS`**: the definitional multipliers to base units. They are MWh 1,000; GJ 1,000/3.6; therms 29.30710701593; uk_gallons 4.54609; us_gallons 3.785411784; tonnes 1,000. A unit that is not in the table and is not a base unit has no ceiling. For a category's allowed units that cannot happen, and a spec pins it.
- **`firstPeriodCeiling({ category, activityType, activityValue, activityUnit, parameters })`**, a pure function. It returns `null` when no ceiling applies. Otherwise it returns `{ above, amount, ceiling, unit, kind: 'amount' | 'equipment_line' | 'equipment_refill', lineIndex?, capacityKg? }`, with `amount` and `ceiling` in the entered unit, for display. The comparison is done in base units with a strict `>`.
  - For refrigerants it reports the first line that breaches, and a capacity breach (`equipment_line`) takes precedence over a refill breach (`equipment_refill`, which carries the line's `capacityKg`).
  - When no line breaches, it reports the line with the largest capacity, `above: false`.

The multipliers repeat the API's `normalization.ts`. Moving the normaliser into the contract would touch the calculation path for no behavioural gain. Instead, an API spec asserts that each `CEILING_UNIT_MULTIPLIERS` entry equals the normaliser's multiplier for that unit.

Alternative considered: compare against the normalised quantity in the calculation snapshot. It ties a plausibility guard to the factor path, it is absent from the inputs the web holds, and refrigerants need the lines anyway.

### D3. The ceiling composes with the history verdict, in one place

A contract helper, `withFirstPeriodCeiling(historyVerdict, ceilingInput)`, returns the history verdict unchanged unless history cannot judge it (`isCeilingEligible`: count 0, which implies a figure, or a zero average). In that case it returns the same count and average with `anomalous: ceiling?.above ?? false`. `computeAnomalyVerdict` stays history-only, so its many specs keep their meaning.

The API's `AnomalyParams` gains `activityValue`, `activityUnit` and `parameters` (it already has `category` and `activityType`). Create, update, submit and `previewCreate` pass them from the record that will be stored, not from the request: on update, the merged values. The seed's `seedVerdict` and `anomaly-recompute.lib.mjs`'s `freshVerdict` call the same helper.

A record with no figure never reaches the ceiling (count null). A zero average does (K1).

### D4. The refusal carries its basis

- `VarianceReasonRequiredError(basis: 'history' | 'ceiling')` sends `params: { basis }`.
- The message is `VARIANCE_REFUSAL` for history and a new `CEILING_VARIANCE_REFUSAL` for the ceiling. The ceiling message is "This is a first-period figure above the plausibility ceiling for its category — check the evidence and the unit, and add a variance comment before submitting."
- The param registry gets `variance_reason_required: ['basis']`.
- The web's `errors.codes.variance_reason_required` keeps today's history sentence. A new `errors.variants.variance_reason_required.ceiling` holds the ceiling sentence, and `describeApiError` picks it when `params.basis` is `ceiling` (`SENTENCE_SELECTORS` in `lib/i18n/errors.ts`). The catalogue rule allows only simple `{name}` arguments, so ICU `select` was not an option (found during implementation, 2026-11-13). A selector param is named in no sentence, and the message spec excludes it. A response without params (an older API) falls back to the status's generic sentence, as for every code with params.
- Data Entry's own pre-submit toast (`anomalousBeforeSubmit`) picks a ceiling variant from `anomalyBasis(record)`.
- Bulk submit forwards the error's message. Its `BulkSubmitIssue` has no params, and the label "Needs a variance reason" is true for both bases.
- The bulk import warning's message names the ceiling when the preview's verdict basis is `ceiling`.

Alternative considered: a single neutral text. The owner chose the basis param on 2026-11-13.

### D5. Wording per surface

`anomaly-view.ts` gains a `flaggedCeiling` branch keyed on `anomalyBasis === 'ceiling'`. It takes its figures from `firstPeriodCeiling` on the record's own fields. The tone stays `flagged`, so the amber card and the variance field on Data Entry and the review sheet need no logic change.

| State | Headline (EN / TR) | Detail says |
|---|---|---|
| Ceiling, amount | "Above the first-period ceiling" / "İlk dönem tavanının üstünde" | first period, no earlier period to compare. The amount is above the ceiling for the category (both in the entered unit). Check the evidence and the unit, e.g. an extra zero |
| Ceiling, equipment line | same | an equipment line of {capacity} kg is above the 500 kg ceiling; check the nameplate or inventory and the unit |
| Ceiling, equipment refill | same | an equipment line's refill of {refill} kg is above its limit of {ceiling} kg: either 125% of its {capacity} kg capacity, or the 500 kg per-line limit (one sentence per case); check the service form or invoice and the unit |
| Ceiling, verdict stored but the current table says not above | same headline | the generic "above the first-period ceiling" sentence without figures (see Risks) |

- Numbers are formatted by the user's locale (the `localise-ui` skill).
- A ceiling in a non-base unit is shown as base ÷ multiplier, rounded to whole units. Only the display is rounded, never the comparison.
- Report column. `anomalyColumnState` gains `flagged_ceiling` and `flagged_ceiling_zero_average`, read through `isCeilingFlag`, never by hand.
  - `flagged_ceiling`: CSV and EN `yes (above the first-period ceiling)`, TR `evet (ilk dönem tavanının üstünde)`.
  - `flagged_ceiling_zero_average`: EN `yes (above the plausibility ceiling; earlier periods average zero)`, TR `evet (makul üst sınırın üstünde; önceki dönemlerin ortalaması sıfır)`.
- **Over a zero average (K1):** the headline is "Above the plausibility ceiling" / "Makul üst sınırın üstünde". The detail opens "The earlier periods of this series average zero…" instead of the first-period sentence; every other part is the same.
- **Metered gas with a factor (K2):** "{m³} × the volume correction factor {f} = {Sm³}, above the plausibility ceiling of 250,000 Sm³ — check the evidence, the unit and the factor".
- **The refusal and the toasts** say "no usable history to compare with", which is true for a first period and for a zero average alike.
- The review queue row and the emissions table already read the raw flag, so they show the flag mark unchanged.
- The first-period mark (`isFirstPeriodRecord`, `!flag && count === 0`) stays as it is, so the two marks remain distinct.

### D6. Verdicts scored before the ceiling are a known difference

- **The state.** A committed record (submitted, under review, approved, locked), stored unflagged, whose ceiling says above. Its stored count and average must be the ones history gives today and must make it ceiling-eligible: count 0 with NO average, or the same count with an average of 0.
  - A count of 0 beside any other stored average is a broken verdict, and it stays drift (owner review, 2026-11-13: an average of 99 beside count 0 was excused).
  - After this deploy no writer produces the kept state: submit re-scores, recall keeps the verdict, and the next save re-scores. So it is pre-ceiling.
- **`isLegacyPreCeilingVerdict(record)`** in the contract names it.
- **`anomaly:recompute`** leaves it alone on a committed record and does not count it as unrepaired. On a draft or a rejected record it re-scores, as the next save would. The existing `unexplained_flag` refusal already stops it from flagging a record in review that has no reason.
- **`anomaly:probe`** gains the ceiling in SQL: a `CASE` over category, activity type and unit, the multipliers, and `jsonb_array_elements(parameters->'equipment')`, for any line whose `capacityKg` is above 500 or whose `refillKg` is above its refill ceiling (`REFRIGERANT_REFILL_RATIO`, copied and pinned like the other constants). That gives `expected_flag` for count 0. The probe lists the pre-ceiling state in its own known-difference section, which does not affect its exit code.
- **A flag with count 0 whose amount is not above the ceiling stays drift.**
- **Parity.** The probe lib exports its ceiling table and multipliers as plain data. An integration spec asserts they equal the contract's, and runs the probe's SQL on rows built for each case.
- **Screens.** A pre-ceiling record reads as a first-period record, not checked, the same as today. No separate sentence is added: unlike the short-history case, nothing the screen says about it is wrong.

### D7. Scope of application

The ceiling applies wherever the category and unit have one, in every geography. The units are physical, and the pilot is TR. Records with no calculated figure are never first-period (count null), so Water and other uncalculated categories are untouched. Approve still has no anomaly gate.

## Risks / Trade-offs

- **[A legitimate refill above 125% of a line's capacity]** (a total loss and a second fill in one year) → One sentence of variance reason. It is the event EPA asks owners to report.
- **[A large real site exceeds a ceiling]** → The author writes one variance sentence and the reviewer sees it. The ceilings are the team's (Enerya V8-2 maxima with a margin) and the owner's, and the owner may revise them.
- **[The ceilings are revised later]** → A stored ceiling flag was judged against the old table, while the screens derive figures from the new one. D5's third row covers the display. The probe would report committed flags the new table no longer produces as drift. A revision PR must state its own known-difference rule. It is filed as an open question.
- **[The m³ row is read as an Sm³ conversion]** → The table comment and the spec say it is the same number as a guard. The calculation path never reads this table.
- **[The multipliers drift from the normaliser, or the probe drifts from the contract]** → The parity specs in D2 and D6 fail CI.
- **[Hosted QA drafts are newly blocked at submit]** → This is the behaviour QA retests. The probe only scans committed records, so a read-only SQL query (task 7.1) counts first-period drafts and rejected records above a ceiling before the deploy. The owner runs it.
- **[A post-deploy defect leaves a committed first-period record unflagged above its ceiling]** → The probe excuses that state as pre-ceiling, so it cannot tell the two apart. This is the same trade-off D7 of the short-history change accepted. The API's own unit and integration specs on the gate cover it.
- **[A bulk submit of a new series]** → Every period is first-period until one is committed, and bulk submit commits in period order. So January is judged by the ceiling and February by history once January is accepted. A spec covers it.
- **[An assertion pins "a first-period record is never flagged"]** → It is flipped deliberately in the shared-types, API and web specs, never deleted.

## Migration Plan

- No schema change and no data change. Deploy is the normal image deploy.
- **Before merge:** the owner runs the read-only query from task 7.1 on hosted QA, and the counts go into the PR body.

**The hosted query (task 7.1).** The owner runs it in the SQL editor; it is read-only. It counts first-period records above their ceiling, by organisation, category and kind:
  - `open`: draft or rejected; needs a variance reason at its next submit.
  - `committed`: kept as a known difference, which `anomaly:probe` section 2c lists.

  The ceiling expression is the probe's own `CEILING_ABOVE_SQL`, regenerated after the owner's review: it includes the refill tolerance, K1 and K2. "History cannot judge" is approximated as "no earlier committed period of the series with a figure above zero", which covers a first period and a zero average (figures are never negative). It differs from the rule only when the three most recent earlier periods all lack a figure, which never happens for Scope 1–2. Locally (seeded database, 2026-11-13) it returns 0 rows, in line with the probe's section 2c (0).

```sql
-- Read-only. Records above their typo ceiling where history cannot judge them
-- (no earlier committed period with a figure above zero), by organisation,
-- category and kind: 'open' (draft/rejected: needs a variance reason at its
-- next submit) or 'committed' (kept as a known difference, not re-scored).
WITH r AS (
  SELECT id, subsidiary_id, location_id, category, activity_type, reporting_period, status,
         reporting_year * 100 + COALESCE(CASE reporting_period
           WHEN 'monthly'   THEN array_position(ARRAY['January','February','March','April','May','June','July','August','September','October','November','December'], period_value) - 1
           WHEN 'quarterly' THEN array_position(ARRAY['Q1','Q2','Q3','Q4'], period_value)
           ELSE 0 END, 0) AS key,
         (jsonb_typeof(calculation->'factorId') = 'string' AND length(calculation->>'factorId') > 0
           AND jsonb_typeof(calculation->'tCo2e') = 'number') AS has_figure,
         CASE WHEN jsonb_typeof(calculation->'tCo2e') = 'number' THEN (calculation->>'tCo2e')::float8 END AS tco2e,
         CASE
    WHEN category = 'Refrigerants' THEN (
      -- NULL with no lines (no ceiling); otherwise whether any line's capacity
      -- is above the line ceiling, or its refill above its refill ceiling. A
      -- value that is not a number counts as 0, as in the contract.
      SELECT bool_or(cap > 500::float8
                     OR refill > (CASE WHEN cap > 0
                                       THEN least(1.25::float8 * cap, 500::float8)
                                       ELSE 500::float8 END) * 1.000000001::float8)
      FROM (
        SELECT CASE WHEN jsonb_typeof(e->'capacityKg') = 'number' THEN (e->>'capacityKg')::float8 ELSE 0 END AS cap,
               CASE WHEN jsonb_typeof(e->'refillKg') = 'number' THEN (e->>'refillKg')::float8 ELSE 0 END AS refill
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(parameters->'equipment') = 'array'
                                       THEN parameters->'equipment' ELSE '[]'::jsonb END) e
      ) line
    )
    -- Metered natural gas with its own volume correction factor: m³ × factor
    -- against the Sm³ ceiling (K2 of 2026-11-13). A nested CASE, so the cast
    -- runs only on a number.
    WHEN category = 'Natural Gas' AND activity_unit = 'cubic_metres'
         AND jsonb_typeof(parameters->'volumeCorrectionFactor') = 'number' THEN CASE
      WHEN (parameters->>'volumeCorrectionFactor')::float8 > 0
        THEN activity_value * (parameters->>'volumeCorrectionFactor')::float8 > 250000::float8
      ELSE activity_value > 250000::float8 END
    WHEN category = 'Mobile Combustion' AND activity_type = 'marine_gas_oil' THEN CASE
      WHEN activity_unit = 'kg' THEN activity_value * 1::float8 > 1000000::float8
      WHEN activity_unit = 'tonnes' THEN activity_value * 1000::float8 > 1000000::float8
      ELSE NULL END
    WHEN category = 'Electricity' AND activity_unit = 'kWh' THEN activity_value * 1::float8 > 1000000::float8
    WHEN category = 'Electricity' AND activity_unit = 'MWh' THEN activity_value * 1000::float8 > 1000000::float8
    WHEN category = 'Electricity' AND activity_unit = 'therms' THEN activity_value * 29.30710701593::float8 > 1000000::float8
    WHEN category = 'Electricity' AND activity_unit = 'gj' THEN activity_value * 277.77777777777777::float8 > 1000000::float8
    WHEN category = 'Natural Gas' AND activity_unit = 'kWh' THEN activity_value * 1::float8 > 2500000::float8
    WHEN category = 'Natural Gas' AND activity_unit = 'MWh' THEN activity_value * 1000::float8 > 2500000::float8
    WHEN category = 'Natural Gas' AND activity_unit = 'therms' THEN activity_value * 29.30710701593::float8 > 2500000::float8
    WHEN category = 'Natural Gas' AND activity_unit = 'gj' THEN activity_value * 277.77777777777777::float8 > 2500000::float8
    WHEN category = 'Natural Gas' AND activity_unit = 'standard_cubic_metres' THEN activity_value * 1::float8 > 250000::float8
    WHEN category = 'Natural Gas' AND activity_unit = 'cubic_metres' THEN activity_value * 1::float8 > 250000::float8
    WHEN category = 'Mobile Combustion' AND activity_unit = 'litres' THEN activity_value * 1::float8 > 100000::float8
    WHEN category = 'Mobile Combustion' AND activity_unit = 'uk_gallons' THEN activity_value * 4.54609::float8 > 100000::float8
    WHEN category = 'Mobile Combustion' AND activity_unit = 'us_gallons' THEN activity_value * 3.785411784::float8 > 100000::float8
    WHEN category = 'Mobile Combustion' AND activity_unit = 'kg' THEN activity_value * 1::float8 > 100000::float8
    WHEN category = 'Mobile Combustion' AND activity_unit = 'tonnes' THEN activity_value * 1000::float8 > 100000::float8
    WHEN category = 'Fugitive Gas' AND activity_unit = 'standard_cubic_metres' THEN activity_value * 1::float8 > 200000::float8
    WHEN category = 'Fuel' AND activity_unit = 'litres' THEN activity_value * 1::float8 > 100000::float8
    WHEN category = 'Fuel' AND activity_unit = 'uk_gallons' THEN activity_value * 4.54609::float8 > 100000::float8
    WHEN category = 'Fuel' AND activity_unit = 'us_gallons' THEN activity_value * 3.785411784::float8 > 100000::float8
    WHEN category = 'Fuel' AND activity_unit = 'kg' THEN activity_value * 1::float8 > 150000::float8
    WHEN category = 'Fuel' AND activity_unit = 'tonnes' THEN activity_value * 1000::float8 > 150000::float8
    ELSE NULL END AS above_ceiling
  FROM activity_records
  WHERE status <> 'voided'
)
SELECT o.legal_name AS organisation, r.category,
       CASE WHEN r.status IN ('draft', 'rejected') THEN 'open' ELSE 'committed' END AS kind,
       count(*) AS records
FROM r
JOIN subsidiaries s ON s.id = r.subsidiary_id
JOIN organisations o ON o.id = s.organisation_id
WHERE r.has_figure AND r.above_ceiling
  AND NOT EXISTS (
    SELECT 1 FROM r c
    WHERE c.status IN ('submitted', 'under_review', 'approved', 'locked') AND c.has_figure AND c.tco2e > 0
      AND c.subsidiary_id = r.subsidiary_id
      AND c.location_id IS NOT DISTINCT FROM r.location_id
      AND c.category = r.category
      AND c.activity_type IS NOT DISTINCT FROM r.activity_type
      AND c.reporting_period = r.reporting_period
      AND c.key < r.key AND c.id <> r.id
  )
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
```
- **Rollback:** the previous image. It reads a stored ceiling flag (flag true, count 0) as flagged with no baseline, and prints "deviates significantly from the historical average" (`detailNoBaseline`). The submit gate still holds, because it re-scores, and under the old rule the record is no longer flagged. A draft saved by the new image is re-scored at its next save.
  - **Operator tools after a rollback:** do not run `anomaly:recompute --apply` under the old image. It would clear the ceiling flags of records in review; their variance reasons would stay.
  - The old `anomaly:probe` reports every ceiling flag (count 0, or an average of 0) as drift; that drift is expected after a rollback.

## Open Questions

- How should a later revision of the ceilings treat flags stored under the old table: re-score open records, keep committed ones as a known difference? It can be decided when a revision is proposed. It does not change this change.
