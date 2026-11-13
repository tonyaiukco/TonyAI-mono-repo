/**
 * The anomaly probe's rule and SQL, separated from the IO around them.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The probe had no test: its SQL lived inside a script that connects and
 * prints, so nothing could run the drift query against rows built for the
 * purpose. A review then found a broken verdict it reported as clean
 * (`DRIFT_WHERE`). Everything here is a constant or a string, so the
 * integration suite can run the same query the script runs.
 *
 * The rule is still REIMPLEMENTED in SQL, deliberately — see the header of
 * `anomaly-probe.mjs`. This file imports nothing.
 */

/* ---- the rule, mirrored from `computeAnomalyVerdict` and `detectAnomaly` ---- */

/** VAR §4.2 — more than 50% from the rolling average. */
export const ANOMALY_THRESHOLD = 0.5;
/** VAR §4.1 — the rolling average is over the previous 3 comparable periods. */
export const BASELINE_MAX_PERIODS = 3;
/**
 * How many of those periods must actually carry a figure for the rule to run
 * (`ANOMALY_MIN_PRIORS`). One since 2026-11-11 (BUG-R2-07): one or two is a
 * limited-history verdict. It was three from 2026-08-27 until then. Kept as
 * its own constant because section 3 still reports the shortfall — "2 of 3"
 * is the finding, and a single constant could not express it.
 */
export const BASELINE_MIN_PERIODS = 1;
/** How far a stored average may sit from the recomputed one and still be the
 *  same figure. Relative; see `DRIFT_WHERE`. */
export const BASELINE_TOLERANCE = 1e-9;
/** COUNTED_STATUSES — the only statuses that seed a baseline. `voided` never does. */
export const BASELINE_STATUSES = ['submitted', 'under_review', 'approved', 'locked'];

/* ---- the first-period typo ceiling, mirrored from `firstPeriodCeiling` ----
 * (BUG-R2-07 tier 3, Decisions 2026-11-12.) Copies of the contract's
 * `FIRST_PERIOD_CEILINGS`, `MARINE_GAS_OIL_CEILING_KG`,
 * `REFRIGERANT_LINE_CEILING_KG` and `CEILING_UNIT_MULTIPLIERS`; the
 * integration suite asserts they are equal (`anomaly-probe.int.spec.ts`). */

/** In base units. `cubic_metres` repeats the Sm³ number: a guard, not a conversion. */
export const FIRST_PERIOD_CEILINGS = {
  Electricity: { kWh: 1_000_000 },
  'Natural Gas': { kWh: 2_500_000, standard_cubic_metres: 250_000, cubic_metres: 250_000 },
  'Mobile Combustion': { litres: 100_000, kg: 100_000 },
  'Fugitive Gas': { standard_cubic_metres: 200_000 },
  Fuel: { litres: 100_000, kg: 150_000 },
};
/** Marine gas oil's own ceiling, checked instead of the Mobile Combustion kg row. */
export const MARINE_GAS_OIL_CEILING_KG = 1_000_000;
/** The activity type that ceiling is keyed on (`MARINE_GAS_OIL_ACTIVITY_TYPE`). */
export const MARINE_GAS_OIL_ACTIVITY_TYPE = 'marine_gas_oil';
/** Installed capacity on any one refrigerant equipment line. */
export const REFRIGERANT_LINE_CEILING_KG = 500;
/** A line's refill above this share of its capacity (capped at the line
 *  ceiling; the ceiling alone for no capacity) is above its ceiling too. */
export const REFRIGERANT_REFILL_RATIO = 1.25;
/** `REFILL_CEILING_TOLERANCE`: exactly 125% of a decimal capacity is not above. */
export const REFILL_CEILING_TOLERANCE = 1e-9;
/** Exact definitional routes to each ceiling's base unit. */
export const CEILING_UNIT_MULTIPLIERS = {
  kWh: { base: 'kWh', multiplier: 1 },
  MWh: { base: 'kWh', multiplier: 1000 },
  therms: { base: 'kWh', multiplier: 105_505_585.257348 / 3_600_000 },
  gj: { base: 'kWh', multiplier: 1000 / 3.6 },
  standard_cubic_metres: { base: 'standard_cubic_metres', multiplier: 1 },
  cubic_metres: { base: 'cubic_metres', multiplier: 1 },
  litres: { base: 'litres', multiplier: 1 },
  uk_gallons: { base: 'litres', multiplier: 4.54609 },
  us_gallons: { base: 'litres', multiplier: 3.785411784 },
  kg: { base: 'kg', multiplier: 1 },
  tonnes: { base: 'kg', multiplier: 1000 },
};

const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;
// A JS double printed in full precision, so Postgres multiplies by the same
// IEEE value the contract does and a figure at the boundary lands alike.
const sqlNumber = (n) => `${JSON.stringify(n)}::float8`;

/**
 * `true` when the record's stored amount is above its first-period ceiling,
 * `false` when it is not, NULL when no ceiling applies (Scope 3, a unit with no
 * route, a refrigerant record with no equipment lines). Over the `r` columns.
 */
export const CEILING_ABOVE_SQL = (() => {
  const amountRows = [];
  for (const [category, byBase] of Object.entries(FIRST_PERIOD_CEILINGS)) {
    for (const [unit, { base, multiplier }] of Object.entries(CEILING_UNIT_MULTIPLIERS)) {
      const ceiling = byBase[base];
      if (ceiling === undefined) continue;
      amountRows.push(
        `WHEN category = ${sqlText(category)} AND activity_unit = ${sqlText(unit)} ` +
          `THEN activity_value * ${sqlNumber(multiplier)} > ${sqlNumber(ceiling)}`,
      );
    }
  }
  const mgoRows = Object.entries(CEILING_UNIT_MULTIPLIERS)
    .filter(([, { base }]) => base === 'kg')
    .map(
      ([unit, { multiplier }]) =>
        `WHEN activity_unit = ${sqlText(unit)} THEN activity_value * ${sqlNumber(multiplier)} > ${sqlNumber(MARINE_GAS_OIL_CEILING_KG)}`,
    );
  return `CASE
    WHEN category = 'Refrigerants' THEN (
      -- NULL with no lines (no ceiling); otherwise whether any line's capacity
      -- is above the line ceiling, or its refill above its refill ceiling. A
      -- value that is not a number counts as 0, as in the contract.
      SELECT bool_or(cap > ${sqlNumber(REFRIGERANT_LINE_CEILING_KG)}
                     OR refill > (CASE WHEN cap > 0
                                       THEN least(${sqlNumber(REFRIGERANT_REFILL_RATIO)} * cap, ${sqlNumber(REFRIGERANT_LINE_CEILING_KG)})
                                       ELSE ${sqlNumber(REFRIGERANT_LINE_CEILING_KG)} END) * ${sqlNumber(1 + REFILL_CEILING_TOLERANCE)})
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
        THEN activity_value * (parameters->>'volumeCorrectionFactor')::float8 > ${sqlNumber(FIRST_PERIOD_CEILINGS['Natural Gas'].standard_cubic_metres)}
      ELSE activity_value > ${sqlNumber(FIRST_PERIOD_CEILINGS['Natural Gas'].cubic_metres)} END
    WHEN category = 'Mobile Combustion' AND activity_type = ${sqlText(MARINE_GAS_OIL_ACTIVITY_TYPE)} THEN CASE
      ${mgoRows.join('\n      ')}
      ELSE NULL END
    ${amountRows.join('\n    ')}
    ELSE NULL END`;
})();

/**
 * The baseline, per record. No parameters are interpolated from input — the
 * only substitutions are the constants above — so `$queryRawUnsafe` here is a
 * static string, used because the three reports share this prefix and a tagged
 * template cannot be concatenated.
 */
export const BASE_SQL = `
WITH r AS (
  SELECT id, subsidiary_id, location_id, category, activity_type, reporting_period,
         reporting_year, period_value, status, anomaly_flag,
         ${CEILING_ABOVE_SQL} AS above_ceiling,
         anomaly_baseline_prior_count AS stored_priors,
         anomaly_baseline_tco2e AS stored_baseline,
         -- A count of 1-2 beside a NULL average, unflagged: scored before
         -- 2026-11-11, when such a window was not evaluated. Kept, never
         -- re-scored. COALESCE because a NULL count makes the BETWEEN NULL,
         -- and "NOT NULL" would drop that row from the drift report below.
         -- Unflagged only: the old rule never flagged a short window, so a
         -- flag here is a row no writer produced and must stay drift.
         COALESCE(anomaly_baseline_prior_count BETWEEN ${BASELINE_MIN_PERIODS} AND ${BASELINE_MAX_PERIODS - 1}
            AND anomaly_baseline_tco2e IS NULL AND NOT anomaly_flag, false) AS legacy,
         reporting_year * 100 + COALESCE(CASE reporting_period
           WHEN 'monthly'   THEN array_position(ARRAY['January','February','March','April','May','June','July','August','September','October','November','December'], period_value) - 1
           WHEN 'quarterly' THEN array_position(ARRAY['Q1','Q2','Q3','Q4'], period_value)
           ELSE 0 END, 0) AS key,
         CASE WHEN jsonb_typeof(calculation->'factorId') = 'string'
                   AND length(calculation->>'factorId') > 0
                   AND jsonb_typeof(calculation->'tCo2e') = 'number'
              THEN (calculation->>'tCo2e')::float8 END AS tco2e
  FROM activity_records
),
counted AS (
  SELECT * FROM r WHERE status = ANY(ARRAY[${BASELINE_STATUSES.map((s) => `'${s}'`).join(',')}]::"ActivityRecordStatus"[])
),
scored AS (
  SELECT c.*, s.legal_name AS sub, l.name AS loc, p.slots, p.priors, p.baseline
  FROM counted c
  JOIN subsidiaries s ON s.id = c.subsidiary_id
  LEFT JOIN locations l ON l.id = c.location_id
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS slots, count(t.tco2e)::int AS priors, avg(t.tco2e) AS baseline
    FROM (
      SELECT b.tco2e FROM counted b
      WHERE b.subsidiary_id = c.subsidiary_id
        AND b.location_id IS NOT DISTINCT FROM c.location_id
        AND b.category = c.category
        AND b.activity_type IS NOT DISTINCT FROM c.activity_type
        AND b.reporting_period = c.reporting_period
        AND b.key < c.key
        AND b.id <> c.id
      ORDER BY b.key DESC
      LIMIT ${BASELINE_MAX_PERIODS}
    ) t
  ) p ON TRUE
),
verdict AS (
  SELECT *, CASE
    WHEN tco2e IS NULL THEN false
    -- Where history cannot judge — a first period, or earlier periods averaging
    -- zero — the typo ceiling does (BUG-R2-07 tier 3; K1 of 2026-11-13).
    WHEN priors = 0 THEN COALESCE(above_ceiling, false)
    WHEN priors >= ${BASELINE_MIN_PERIODS} AND baseline = 0 THEN COALESCE(above_ceiling, false)
    WHEN priors < ${BASELINE_MIN_PERIODS} OR baseline IS NULL THEN false
    ELSE abs(tco2e - baseline) / baseline > ${ANOMALY_THRESHOLD} END AS computed,
    -- What the rule STORES beside the flag: no count for a record with no
    -- figure of its own, and an average once the window holds a figure.
    CASE WHEN tco2e IS NULL THEN NULL ELSE priors END AS expected_priors,
    CASE WHEN tco2e IS NULL OR priors < ${BASELINE_MIN_PERIODS} THEN NULL ELSE baseline END AS expected_baseline,
    -- A first period stored unflagged before the ceilings existed (2026-11-13)
    -- and above its ceiling today, still with no earlier period. Kept, not
    -- re-scored — every row here is committed — and not drift.
    -- Only when the stored count and average are the ones history gives today
    -- (no earlier period and NO average, or the same count and a zero
    -- average): a broken stored average stays drift (owner review, 2026-11-13).
    -- COALESCE: a NULL stored count or average turns every comparison NULL, and
    -- "NOT pre_ceiling" would then drop the row from the drift report as well
    -- (re-review, 2026-11-13) — the same trap the legacy column guards above.
    COALESCE(tco2e IS NOT NULL AND NOT anomaly_flag AND COALESCE(above_ceiling, false) AND (
       (priors = 0 AND stored_priors = 0 AND stored_baseline IS NULL)
       OR (priors >= ${BASELINE_MIN_PERIODS} AND baseline = 0 AND stored_priors = priors AND stored_baseline = 0)
    ), false) AS pre_ceiling
  FROM scored
)`;

/**
 * Has the stored VERDICT drifted — the flag, the count or the average?
 *
 * All three, not the flag alone. Comparing only the flag passed a row the rule
 * cannot have written: flagged on one prior with NO stored average, where the
 * rule also says "flagged" today. The flags agree and the verdict is still
 * broken — the screens print the average beside the warning, and there is none
 * (review of 2026-11-11). It also missed a pool that moved without flipping
 * the flag, which `anomaly:recompute` has always called stale.
 *
 * The average is compared with a tolerance: Postgres's avg() and the API's
 * left fold differ in the last ULP, and Prisma rounds a double on write (the
 * same tolerance as `BASELINE_TOLERANCE` in the re-score tool). A verdict
 * kept from before the short-history check is excused (`legacy`), as is a
 * first period kept from before the typo ceilings (`pre_ceiling`). A flag
 * beside no earlier period whose amount is NOT above its ceiling stays drift.
 */
export const DRIFT_WHERE = `NOT legacy AND NOT pre_ceiling AND (
      anomaly_flag <> computed
      OR stored_priors IS DISTINCT FROM expected_priors
      OR (stored_baseline IS NULL) <> (expected_baseline IS NULL)
      OR abs(stored_baseline - expected_baseline)
           > ${BASELINE_TOLERANCE} * greatest(abs(stored_baseline), abs(expected_baseline), 1)
    )`;

/** Kept verdicts: scored before the short-history check, not re-scored. */
export const LEGACY_WHERE = 'legacy';

/** Kept verdicts: a first period scored before the typo ceilings, not re-scored. */
export const PRE_CEILING_WHERE = 'pre_ceiling';


