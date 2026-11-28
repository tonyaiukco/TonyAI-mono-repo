-- Single entry, what is entered (INC-2.6 §4.2, §5.3; TA026): one party per
-- owning company, category and period. The first version compared periods
-- exactly, so a company user's month and a central reporter's quarter (or year)
-- covering it were both stored and counted twice. A record now meets the other
-- party's records of every period that overlaps its own: the same period, the
-- year with any of its periods, a month with its quarter. Only the function's
-- body changes (the trigger stays); no row is rewritten, and records already
-- stored are not judged again.

CREATE OR REPLACE FUNCTION "public"."activity_records_single_entry"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  party text;
  author_role text;
  other_id uuid;
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."subsidiary_id" IS NOT DISTINCT FROM OLD."subsidiary_id"
     AND NEW."category" IS NOT DISTINCT FROM OLD."category"
     AND NEW."reporting_year" IS NOT DISTINCT FROM OLD."reporting_year"
     AND NEW."reporting_period" IS NOT DISTINCT FROM OLD."reporting_period"
     AND NEW."period_value" IS NOT DISTINCT FROM OLD."period_value"
     AND NEW."created_by" IS NOT DISTINCT FROM OLD."created_by"
     AND NEW."reported_by_subsidiary_id" IS NOT DISTINCT FROM OLD."reported_by_subsidiary_id" THEN
    -- A status step changes no party and no period, and a voided record never
    -- comes back: records are judged when they are entered and when their
    -- identity moves, never again on a submit, a decision, a lock or a void.
    RETURN NEW;
  END IF;
  IF NEW."status"::text = 'voided' THEN
    RETURN NEW;
  END IF;
  IF NEW."reported_by_subsidiary_id" IS NOT NULL
     AND NEW."reported_by_subsidiary_id" <> NEW."subsidiary_id" THEN
    party := 'central_reporter';
  ELSE
    SELECT p."role"::text INTO author_role
      FROM "public"."profiles" p
     WHERE p."id" = NEW."created_by";
    IF author_role IS DISTINCT FROM 'standard_user' THEN
      RETURN NEW;
    END IF;
    party := 'company_user';
  END IF;

  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA026',
      MESSAGE = 'write activity records under READ COMMITTED: a stricter isolation level cannot see a record committed meanwhile';
  END IF;
  -- One lock per company, category and year: records of overlapping periods
  -- (a month and its quarter, any period and the year) take the same lock, so
  -- two parties racing in different granularities are decided one after the
  -- other.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('tonyai.single_entry_period'),
    pg_catalog.hashtext(pg_catalog.concat_ws('|', NEW."subsidiary_id", NEW."category",
      NEW."reporting_year")));

  -- A new statement under READ COMMITTED: it reads every record committed
  -- while this one waited for the lock.
  SELECT r."id" INTO other_id
    FROM "public"."activity_records" r
    LEFT JOIN "public"."profiles" p ON p."id" = r."created_by"
   WHERE r."subsidiary_id" = NEW."subsidiary_id"
     AND r."category" = NEW."category"
     AND r."reporting_year" = NEW."reporting_year"
     -- The same period, or one that overlaps it: the year overlaps every
     -- period of it, and a month its quarter (INC-2.6 §4.2: one party per
     -- company, category and period; review of WP10, 2026-11-28).
     AND (
           (r."reporting_period" = NEW."reporting_period" AND r."period_value" = NEW."period_value")
           OR r."reporting_period" = 'annual'
           OR NEW."reporting_period" = 'annual'
           OR (r."reporting_period" = 'monthly' AND NEW."reporting_period" = 'quarterly'
               AND CASE WHEN r."period_value" IN ('January', 'February', 'March') THEN 'Q1'
                   WHEN r."period_value" IN ('April', 'May', 'June') THEN 'Q2'
                   WHEN r."period_value" IN ('July', 'August', 'September') THEN 'Q3'
                   WHEN r."period_value" IN ('October', 'November', 'December') THEN 'Q4' END = NEW."period_value")
           OR (r."reporting_period" = 'quarterly' AND NEW."reporting_period" = 'monthly'
               AND CASE WHEN NEW."period_value" IN ('January', 'February', 'March') THEN 'Q1'
                   WHEN NEW."period_value" IN ('April', 'May', 'June') THEN 'Q2'
                   WHEN NEW."period_value" IN ('July', 'August', 'September') THEN 'Q3'
                   WHEN NEW."period_value" IN ('October', 'November', 'December') THEN 'Q4' END = r."period_value")
         )
     AND r."id" <> NEW."id"
     AND r."status"::text <> 'voided'
     AND CASE party
           WHEN 'central_reporter' THEN
             (r."reported_by_subsidiary_id" IS NULL OR r."reported_by_subsidiary_id" = r."subsidiary_id")
             AND p."role"::text = 'standard_user'
           ELSE
             r."reported_by_subsidiary_id" IS NOT NULL AND r."reported_by_subsidiary_id" <> r."subsidiary_id"
         END
   LIMIT 1;
  IF other_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA026',
      MESSAGE = format('single_entry_period_conflict: side=%s; subsidiary %s already holds record %s of %s for %s %s %s %s',
        CASE party WHEN 'central_reporter' THEN 'company_users' ELSE 'central_reporter' END,
        NEW."subsidiary_id", other_id,
        CASE party WHEN 'central_reporter' THEN 'its own standard users' ELSE 'a central reporter' END,
        NEW."category", NEW."reporting_year", NEW."reporting_period", NEW."period_value");
  END IF;
  RETURN NEW;
END
$fn$;
