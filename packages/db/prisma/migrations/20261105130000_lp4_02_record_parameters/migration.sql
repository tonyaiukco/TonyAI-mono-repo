-- LP4-02 PR2 task 2.5: per-record calculation parameters (D3).
-- Natural Gas takes calorific overrides and a volume correction; Refrigerants
-- take equipment type, refill and leak rate choice (their installed capacity is
-- the `kg` activity value, D7). Every other
-- category holds SQL NULL.
-- ---------------------------------------------------------------------------

ALTER TABLE "activity_records" ADD COLUMN "parameters" JSONB;

-- The DTOs' rule again at the storage layer, `recordParametersIssues` in the
-- API. The CASEs fix the evaluation order: AND does not guarantee one, and a
-- cast or a key removal on the wrong JSON type raises instead of refusing. The
-- COALESCE holds a missing or JSON-null field to a refusal: `NULL IN (...)` is
-- NULL, and a CHECK passes NULL. The bounds keep a figure JSON can hold but a
-- double cannot (1e400) from reaching the engine as Infinity.
ALTER TABLE "activity_records"
  ADD CONSTRAINT "activity_records_parameters_check" CHECK (
    "parameters" IS NULL
    OR CASE
      WHEN jsonb_typeof("parameters") <> 'object' THEN false
      WHEN "category" = 'Natural Gas' THEN (
        "parameters" - ARRAY['ncvKcalPerSm3', 'billedGcvKcalPerSm3', 'volumeCorrectionFactor'] = '{}'::jsonb
        AND NOT ("parameters"->>'ncvKcalPerSm3' IS NOT NULL AND "parameters"->>'billedGcvKcalPerSm3' IS NOT NULL)
        AND CASE COALESCE(jsonb_typeof("parameters"->'ncvKcalPerSm3'), 'null')
          WHEN 'number' THEN ("parameters"->>'ncvKcalPerSm3')::numeric BETWEEN 1e-300 AND 1e300
          WHEN 'null' THEN true
          ELSE false
        END
        AND CASE COALESCE(jsonb_typeof("parameters"->'billedGcvKcalPerSm3'), 'null')
          WHEN 'number' THEN ("parameters"->>'billedGcvKcalPerSm3')::numeric BETWEEN 1e-300 AND 1e300
          WHEN 'null' THEN true
          ELSE false
        END
        AND CASE COALESCE(jsonb_typeof("parameters"->'volumeCorrectionFactor'), 'null')
          WHEN 'number' THEN ("parameters"->>'volumeCorrectionFactor')::numeric BETWEEN 1e-300 AND 1e300
          WHEN 'null' THEN true
          ELSE false
        END
      )
      WHEN "category" = 'Refrigerants' THEN COALESCE((
        "parameters" - ARRAY['equipmentType', 'refillKg', 'leakRateChoice'] = '{}'::jsonb
        AND "parameters"->>'equipmentType' IN (
          'fire_suppression_system', 'fire_extinguisher', 'transformer_breaker',
          'split_air_conditioner', 'water_dispenser', 'refrigerator', 'chiller',
          'mobile_air_conditioner', 'portable_air_conditioner'
        )
        AND CASE jsonb_typeof("parameters"->'refillKg')
          WHEN 'number' THEN ("parameters"->>'refillKg')::numeric BETWEEN 0 AND 1e300
          ELSE false
        END
        AND "parameters"->>'leakRateChoice' IN ('default', 'alternative')
        AND ("parameters"->>'leakRateChoice' = 'default' OR "parameters"->>'equipmentType' IN ('split_air_conditioner', 'chiller'))
      ), false)
      ELSE false
    END
  );

-- The engine prices these (PR3), so they freeze with the record's other
-- inputs: nobody changes them once it is committed, and only the API changes
-- them before. Each function is otherwise as last defined.
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

CREATE OR REPLACE FUNCTION "public"."activity_records_lifecycle_writer"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'draft'
       AND pg_catalog.current_setting('session_replication_role') <> 'replica'
       AND session_user <> (SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA005',
        MESSAGE = format('activity record %s is created as a draft, not as %s: a committed status comes from the review lifecycle, not an insert', NEW."id", NEW."status");
    END IF;
    IF session_user <> 'tonyai_runtime'
       AND pg_catalog.current_setting('session_replication_role') <> 'replica'
       AND session_user <> (SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA006',
        MESSAGE = format('activity record %s is created by the API, which computes its figure from the inputs it was given, not by %s', NEW."id", session_user);
    END IF;
  ELSIF session_user <> 'tonyai_runtime'
        AND session_user <> (SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID) THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA005',
        MESSAGE = format('activity record %s moves from %s to %s only through the API, not as %s', OLD."id", OLD."status", NEW."status", session_user);
    END IF;
    IF NEW."input" IS DISTINCT FROM OLD."input"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR (OLD."status" IN ('draft', 'rejected') AND (
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
       )) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA006',
        MESSAGE = format('activity record %s keeps the figure the API computed, the inputs it computed it from and who wrote it: only the API changes them, not %s', OLD."id", session_user);
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
