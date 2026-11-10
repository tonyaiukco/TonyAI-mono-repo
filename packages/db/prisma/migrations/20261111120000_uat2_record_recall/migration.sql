-- UAT round 2, BUG-R2-03 (OpenSpec `uat2-record-edit`, design D2): the author
-- may RECALL a submitted record to draft before review starts. The lifecycle
-- trigger is re-created exactly as 20261105130000_lp4_02_record_parameters left
-- it, with one more allowed step, 'submitted>draft'. Nothing else changes:
--   - the input freeze tests OLD.status, which is 'submitted' on this step, so a
--     write that recalls AND changes an input is still refused (TA001);
--   - only the API's runtime role moves a status (activity_records_lifecycle_writer,
--     unchanged), and the API lets only the author recall, only from submitted;
--   - every other way back to draft (under_review, approved, locked, voided)
--     stays refused.
-- No table or column changes and no stored row is rewritten: the new
-- definition only admits one more transition.

CREATE OR REPLACE FUNCTION "public"."activity_records_snapshot_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA001',
      MESSAGE = format('activity record %s cannot change its id', OLD."id");
  END IF;
  IF OLD."status" NOT IN ('draft', 'rejected') AND (
       NEW."calculation" IS DISTINCT FROM OLD."calculation"
    OR NEW."activity_type" IS DISTINCT FROM OLD."activity_type"
    OR NEW."category" IS DISTINCT FROM OLD."category"
    OR NEW."activity_value" IS DISTINCT FROM OLD."activity_value"
    OR NEW."activity_unit" IS DISTINCT FROM OLD."activity_unit"
    OR NEW."parameters" IS DISTINCT FROM OLD."parameters"
    OR NEW."scope" IS DISTINCT FROM OLD."scope"
    OR NEW."reporting_year" IS DISTINCT FROM OLD."reporting_year"
    OR NEW."reporting_period" IS DISTINCT FROM OLD."reporting_period"
    OR NEW."period_value" IS DISTINCT FROM OLD."period_value"
    OR NEW."subsidiary_id" IS DISTINCT FROM OLD."subsidiary_id"
    OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA001',
      MESSAGE = format('activity record %s is %s: its calculation and the inputs it was computed from cannot change', OLD."id", OLD."status");
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT ((OLD."status"::text || '>' || NEW."status"::text) = ANY (ARRAY[
       'draft>submitted', 'rejected>submitted',
       'submitted>draft',
       'submitted>under_review',
       'submitted>approved', 'under_review>approved',
       'submitted>rejected', 'under_review>rejected',
       'approved>voided', 'approved>locked', 'locked>approved'
     ])) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA001',
      MESSAGE = format('activity record %s cannot move from %s to %s: not a step of the review lifecycle', OLD."id", OLD."status", NEW."status");
  END IF;
  RETURN NEW;
END
$fn$;
