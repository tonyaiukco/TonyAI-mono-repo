-- What the anomaly verdict was decided against, stored beside the verdict.
--
-- `anomaly_flag` is a bare boolean, so `false` said three different things at
-- once -- "clean against three priors", "clean against fewer", and "never
-- evaluated" -- and no surface could tell them apart. VAR §4.1 requires the
-- rolling average of the previous THREE comparable periods; the implementation
-- accepted as few as one, which the spec does not sanction. Measured with
-- `pnpm anomaly:probe` on 2026-08-27, before this migration: 30 of 96 committed
-- records sat below three (10 with no prior at all, 10 with one, 10 with two).
--
-- `anomaly_baseline_prior_count` IS NULLABLE, AND THE NULL IS LOAD-BEARING
-- ----------------------------------------------------------------------
--   NULL  -- the pool was never queried, because this record carries no figure
--            of its own (an invoice-tracked category with no seeded factor).
--            It may still sit on a full year of neighbours.
--   0..2  -- a short window: the rule did not run.
--   3     -- evaluated; `anomaly_baseline_tco2e` is the average it used.
-- A `0` for both the first two cases would have forced every reader outside
-- TypeScript to re-implement `isCalculated()` to separate them -- this file and
-- `scripts/anomaly-probe.mjs` already carry two copies of that predicate.
--
-- These two columns are mutable, unlike `calculation`, and deliberately so: a
-- verdict is a judgement about a moving pool of neighbours, not a frozen
-- measurement. Nothing here touches the immutable snapshot.
--
-- THE BACKFILL RECONSTRUCTS FROM TODAY'S POOL, WHICH IS NOT THE SAME CLAIM
-- ------------------------------------------------------------------------
-- The pool a historic verdict was taken against is unrecoverable -- the flag
-- was written at create/update/submit and never revisited, while `submit`,
-- `void`, `remove` and re-attribution keep moving the neighbours underneath it.
-- So this recomputes each row against the pool as it stands NOW.
--
-- That is sound here and the probe is why: on 2026-08-27 it recomputed every
-- committed record and found ZERO disagreements with the stored flags, so
-- today's pool reproduces every stored verdict exactly and "then" and "now"
-- coincide on this database. Run `pnpm anomaly:probe` before applying this
-- anywhere else. If it reports drift, STOP -- do not apply. The backfill would
-- then be describing today rather than then, and the reconciliation tool that
-- would fix it (`pnpm anomaly:recompute`) is WP21 PR 3 and does not exist yet.
--
-- IT MIRRORS detectAnomaly()'s SELECTION EXACTLY, AND ITS ARITHMETIC ONLY TO
-- WITHIN A ULP. The ordinal key, the window, the counted statuses that seed a
-- pool, self-exclusion, and a figureless prior consuming a slot before being
-- dropped are all identical -- verified row by row against a faithful
-- reimplementation of the service (0 mismatches over 102 rows). The AVERAGE is
-- not bitwise identical: Postgres's `avg()` and the service's left fold round
-- differently, measured at up to 3.6e-16 relative on 32 of 66 full-window rows.
-- It cannot flip a verdict (the ratio would have to sit within ~4e-16 of the
-- threshold), but anything comparing this column against a freshly computed one
-- must use a relative tolerance, not equality.
--
-- ONE LATENT DIVERGENCE, DELIBERATELY NOT PAPERED OVER: `periodOrdinal()` in
-- the service canonicalises `period_value` case- and whitespace-insensitively;
-- `array_position` below matches literally. A row stored as 'march' would key
-- to ordinal 0 here and 2 in the app. Every row is canonical today -- 20260821
-- 120000_canonical_period_value repaired them and every API write canonicalises
-- since -- but nothing enforces it at the database level, so a pre-#63 database
-- is where this would bite. Check before re-applying elsewhere.
--
-- IT NEVER WRITES `anomaly_flag`
-- ------------------------------
-- The strict rule takes 20 more records out of the gate, and re-flagging them
-- here would silently re-mean closed periods that have already been printed
-- into issued reports -- exactly what decision 2 (2026-08-27) forbids. Measured,
-- it would change nothing anyway: no record with one or two priors is flagged.
-- The migration does not rely on that. It simply never writes the column -- and
-- the third guard below refuses rather than leaving the contradiction behind.

-- AlterTable
ALTER TABLE "activity_records" ADD COLUMN     "anomaly_baseline_prior_count" INTEGER,
ADD COLUMN     "anomaly_baseline_tco2e" DOUBLE PRECISION;

-- Backfill: key = year*100 + ordinal (months 0-based, quarters 1-based), pool
-- restricted to the same reporting entity and granularity in a counted status,
-- strictly earlier, self excluded, newest three SLOTS taken and only then the
-- figureless ones dropped. A row whose own calculation carries no figure was
-- never evaluated and gets NULL / NULL -- the same answer the guard in the
-- service gives.
WITH ordinals AS (
  SELECT id, subsidiary_id, location_id, category, reporting_period,
         reporting_year * 100 + COALESCE(CASE reporting_period
           WHEN 'monthly'   THEN array_position(ARRAY['January','February','March','April','May','June','July','August','September','October','November','December'], period_value) - 1
           WHEN 'quarterly' THEN array_position(ARRAY['Q1','Q2','Q3','Q4'], period_value)
           ELSE 0 END, 0) AS key,
         status,
         CASE WHEN jsonb_typeof(calculation->'factorId') = 'string'
                   AND length(calculation->>'factorId') > 0
                   AND jsonb_typeof(calculation->'tCo2e') = 'number'
              THEN (calculation->>'tCo2e')::float8 END AS tco2e
  FROM activity_records
),
computed AS (
  SELECT o.id, o.tco2e IS NOT NULL AS evaluable, p.priors, p.baseline
  FROM ordinals o
  LEFT JOIN LATERAL (
    SELECT count(t.tco2e)::int AS priors, avg(t.tco2e) AS baseline
    FROM (
      SELECT b.tco2e FROM ordinals b
      WHERE b.subsidiary_id = o.subsidiary_id
        AND b.location_id IS NOT DISTINCT FROM o.location_id
        AND b.category = o.category
        AND b.reporting_period = o.reporting_period
        AND b.status IN ('submitted', 'under_review', 'approved', 'locked')
        AND b.key < o.key
        AND b.id <> o.id
      ORDER BY b.key DESC
      LIMIT 3
    ) t
  ) p ON TRUE
)
UPDATE activity_records a
SET anomaly_baseline_prior_count = CASE WHEN c.evaluable THEN COALESCE(c.priors, 0) END,
    anomaly_baseline_tco2e       = CASE WHEN c.evaluable AND COALESCE(c.priors, 0) >= 3 THEN c.baseline END
FROM computed c
WHERE c.id = a.id;

DO $$
DECLARE offenders int;
BEGIN
  -- Guard 1 is a tripwire on the LIMIT above, not on the data: `priors` is a
  -- count over a 3-row subquery, so it is arithmetically bounded already. It
  -- fires only if someone edits the window without editing this block.
  SELECT count(*) INTO offenders FROM activity_records WHERE anomaly_baseline_prior_count > 3;
  IF offenders > 0 THEN
    RAISE EXCEPTION 'anomaly_baseline_prior_count exceeds the 3-period window on % row(s)', offenders;
  END IF;

  -- Guard 2, likewise: both columns are set from one CTE row under the same
  -- predicate, so they cannot disagree unless the SET above is edited apart.
  SELECT count(*) INTO offenders FROM activity_records
   WHERE anomaly_baseline_tco2e IS NOT NULL AND COALESCE(anomaly_baseline_prior_count, 0) < 3;
  IF offenders > 0 THEN
    RAISE EXCEPTION 'a baseline average survived on % row(s) the rule never evaluated', offenders;
  END IF;

  -- Guard 3 is the one that can fire on real data, and the reason it exists.
  -- This migration deliberately does not touch `anomaly_flag`, so on a database
  -- where the OLD lenient rule flagged a record against one or two priors, the
  -- result would be a row claiming it was flagged against a window the same row
  -- declares absent -- a state no code path can produce, and precisely what the
  -- seed's own invariant throws on. Refuse rather than persist it; the fix is a
  -- decision about that record, not something a migration may guess at.
  SELECT count(*) INTO offenders FROM activity_records
   WHERE anomaly_flag AND COALESCE(anomaly_baseline_prior_count, 0) < 3;
  IF offenders > 0 THEN
    RAISE EXCEPTION
      '% record(s) are flagged against fewer than 3 priors. They were flagged under the pre-2026-08-27 lenient rule; decide each one before applying this migration.', offenders;
  END IF;
END $$;
