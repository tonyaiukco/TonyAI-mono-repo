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
    WHEN priors < ${BASELINE_MIN_PERIODS} OR baseline IS NULL OR baseline = 0 THEN false
    ELSE abs(tco2e - baseline) / baseline > ${ANOMALY_THRESHOLD} END AS computed,
    -- What the rule STORES beside the flag: no count for a record with no
    -- figure of its own, and an average once the window holds a figure.
    CASE WHEN tco2e IS NULL THEN NULL ELSE priors END AS expected_priors,
    CASE WHEN tco2e IS NULL OR priors < ${BASELINE_MIN_PERIODS} THEN NULL ELSE baseline END AS expected_baseline
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
 * kept from before the short-history check is excused (`legacy`).
 */
export const DRIFT_WHERE = `NOT legacy AND (
      anomaly_flag <> computed
      OR stored_priors IS DISTINCT FROM expected_priors
      OR (stored_baseline IS NULL) <> (expected_baseline IS NULL)
      OR abs(stored_baseline - expected_baseline)
           > ${BASELINE_TOLERANCE} * greatest(abs(stored_baseline), abs(expected_baseline), 1)
    )`;

/** Kept verdicts: scored before the short-history check, not re-scored. */
export const LEGACY_WHERE = 'legacy';


