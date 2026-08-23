-- Canonicalise `period_value` on rows written before the API started doing it.
--
-- `isValidPeriodValue` has always compared case-insensitively and trimmed, while
-- every write stored the caller's string verbatim -- and every reader compares
-- RAW strings. So `january`, `January` and ` January ` were three different
-- periods. Two live rows for one month both counted towards the emissions
-- inventory, and a period lock recorded under one spelling neither blocked,
-- counted, nor flipped records recorded under another: a period a super_admin
-- believed closed went on accepting writes.
--
-- `initcap(regexp_replace(v, '[^[:alnum:]]', '', 'g'))` IS the canonical form
-- for all three granularities -- `january` -> `January`, `q1` -> `Q1`,
-- `annual` -> `Annual` -- so one expression covers the whole vocabulary without
-- restating it in SQL.
--
-- Stripping every non-alphanumeric character rather than `btrim()` is
-- deliberate and load-bearing: Postgres `btrim()` removes ASCII SPACE only,
-- while the JS `.trim()` the old validator used removes the whole whitespace
-- set. A row stored as E'\tJanuary' or with a non-breaking space therefore
-- passed validation, is exactly the kind of row this migration exists to
-- repair, and `btrim()` would silently walk past it -- completing "successfully"
-- while leaving the duplicate month in place. None of the seventeen canonical
-- tokens contains an interior non-alphanumeric character, so nothing legitimate
-- is altered.
--
-- Touches NO index and NO constraint, deliberately: the `activity_records`
-- uniqueness lives in a raw `NULLS NOT DISTINCT ... WHERE status <> 'voided'`
-- index that Prisma cannot express and keeps proposing to drop (see CLAUDE.md,
-- and the 2026-08-19 migration that added the predicate). A data-only migration
-- cannot disturb it.
--
-- A no-op on a database that is already canonical, which every environment is
-- today: measured 2026-08-21 on the dev database, 102 activity records with 12
-- distinct spellings, 0 candidates, and 0 period-lock rows. There is no cloud
-- environment yet, so this is the cheapest this repair will ever be.

-- Refuse rather than guess. If two live rows collapse onto one period once the
-- spelling is normalised, they are the duplicate month this change exists to
-- prevent -- and which of them is the real figure is a data decision no
-- migration may take. Failing here is louder and safer than a bare unique-index
-- violation halfway through the UPDATE below.
DO $$
DECLARE
  clashes integer;
BEGIN
  SELECT count(*) INTO clashes FROM (
    SELECT 1
    FROM "activity_records"
    WHERE "status" <> 'voided'::"ActivityRecordStatus"
    GROUP BY
      "subsidiary_id", "location_id", "reporting_year", "reporting_period",
      initcap(regexp_replace("period_value", '[^[:alnum:]]', '', 'g')), "category"
    HAVING count(*) > 1
  ) AS duplicated;

  IF clashes > 0 THEN
    RAISE EXCEPTION
      'Cannot canonicalise period_value: % reporting-entity/period/category group(s) hold more than one live record once the spelling is normalised. These are duplicate months, counted twice in the inventory. Withdraw the wrong one (POST /activity-records/:id/void) and re-run.', clashes;
  END IF;

  SELECT count(*) INTO clashes FROM (
    SELECT 1
    FROM "period_locks"
    GROUP BY
      "subsidiary_id", "reporting_year", "reporting_period",
      initcap(regexp_replace("period_value", '[^[:alnum:]]', '', 'g'))
    HAVING count(*) > 1
  ) AS duplicated;

  IF clashes > 0 THEN
    RAISE EXCEPTION
      'Cannot canonicalise period_value: % period(s) hold more than one lock row once the spelling is normalised. Delete the redundant lock before re-running.', clashes;
  END IF;
END $$;

UPDATE "activity_records"
SET "period_value" = initcap(regexp_replace("period_value", '[^[:alnum:]]', '', 'g'))
WHERE "period_value" <> initcap(regexp_replace("period_value", '[^[:alnum:]]', '', 'g'));

UPDATE "period_locks"
SET "period_value" = initcap(regexp_replace("period_value", '[^[:alnum:]]', '', 'g'))
WHERE "period_value" <> initcap(regexp_replace("period_value", '[^[:alnum:]]', '', 'g'));
