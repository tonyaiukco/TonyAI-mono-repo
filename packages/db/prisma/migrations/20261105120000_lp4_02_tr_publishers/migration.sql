-- LP4-02 PR2 task 2.1: Add IPCC and ETKB to the publisher registry.
-- The two real publishers of the TR factor package (decisions L6 of 2026-10-11
-- and 2026-11-05):
--   IPCC  — fuels, gases, GWPs, leak-rate parameters, reference calorific value.
--   ETKB  — Turkish grid electricity (T.C. Enerji ve Tabii Kaynaklar Bakanligi).
-- Their sources and licences are recorded in docs/md_docs/Revision MD.md §2.

-- Drop and re-add the publisher registry CHECK with the new values.
ALTER TABLE "factor_releases"
  DROP CONSTRAINT "factor_releases_publisher_check";

ALTER TABLE "factor_releases"
  ADD CONSTRAINT "factor_releases_publisher_check"
    CHECK ("publisher" IN ('TonyAI prototype', 'TonyAI test fixture', 'IPCC', 'ETKB'));

-- ---------------------------------------------------------------------------
-- LP4-02 PR2 task 2.3: Update CHECK constraints with new categories and types.
-- ---------------------------------------------------------------------------

-- activity_records_scope_check: add Fugitive Gas (Scope 1)
ALTER TABLE "activity_records"
  DROP CONSTRAINT "activity_records_scope_check";

ALTER TABLE "activity_records"
  ADD CONSTRAINT "activity_records_scope_check" CHECK (
    CASE "category"
      WHEN 'Electricity' THEN "scope" = 2
      WHEN 'Natural Gas' THEN "scope" = 1
      WHEN 'Fuel' THEN "scope" = 1
      WHEN 'Mobile Combustion' THEN "scope" = 1
      WHEN 'Refrigerants' THEN "scope" = 1
      WHEN 'Fugitive Gas' THEN "scope" = 1
      WHEN 'Purchased Goods' THEN "scope" = 3
      WHEN 'Waste' THEN "scope" = 3
      WHEN 'Water' THEN "scope" = 3
      WHEN 'Business Travel' THEN "scope" = 3
      WHEN 'Commuting' THEN "scope" = 3
      WHEN 'Logistics' THEN "scope" = 3
      ELSE false
    END
  );

-- inventory_attribution_policies_category_check: add Fugitive Gas
ALTER TABLE "inventory_attribution_policies"
  DROP CONSTRAINT "inventory_attribution_policies_category_check";

ALTER TABLE "inventory_attribution_policies"
  ADD CONSTRAINT "inventory_attribution_policies_category_check"
    CHECK ("category" IN ('Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants', 'Fugitive Gas'));

-- inventory_applicability_cells_category_check: add Fugitive Gas
ALTER TABLE "inventory_applicability_cells"
  DROP CONSTRAINT "inventory_applicability_cells_category_check";

ALTER TABLE "inventory_applicability_cells"
  ADD CONSTRAINT "inventory_applicability_cells_category_check"
    CHECK ("category" IN ('Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants', 'Fugitive Gas'));

-- inventory_sources_mapping_check: add Fugitive Gas and new activity types
ALTER TABLE "inventory_sources"
  DROP CONSTRAINT "inventory_sources_mapping_check";

ALTER TABLE "inventory_sources"
  ADD CONSTRAINT "inventory_sources_mapping_check" CHECK (
    ("mapping" = 'mapped'
      -- Said, not left to IN: a NULL category makes this branch NULL, and a
      -- CHECK admits NULL (review round 2).
      AND "category" IS NOT NULL
      AND "category" IN ('Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants', 'Fugitive Gas')
      AND "unsupported_reason" IS NULL
      AND "scope" = CASE "category" WHEN 'Electricity' THEN 2 ELSE 1 END
      AND CASE "category"
            WHEN 'Fuel' THEN "activity_type" IS NOT NULL
              AND "activity_type" IN ('diesel', 'petrol', 'gas_oil', 'fuel_oil', 'burning_oil', 'lpg', 'lng', 'coal')
            WHEN 'Mobile Combustion' THEN "activity_type" IS NOT NULL
              AND "activity_type" IN ('diesel', 'petrol', 'lpg', 'cng',
                'on_road_petrol', 'on_road_diesel', 'on_road_lpg', 'off_road_petrol', 'off_road_diesel')
            WHEN 'Refrigerants' THEN "activity_type" IS NOT NULL
              AND "activity_type" IN ('R-22', 'R-32', 'R-134a', 'R-404A', 'R-407C', 'R-407F', 'R-410A', 'R-448A', 'R-449A', 'R-1234yf', 'HFC-227ea', 'SF6')
            ELSE "activity_type" IS NULL
          END)
    OR ("mapping" = 'unsupported'
      AND "category" IS NULL
      AND "activity_type" IS NULL
      AND "scope" IN (1, 2)
      AND "unsupported_reason" IS NOT NULL
      AND ("unsupported_reason" IS NFC NORMALIZED AND char_length("unsupported_reason") BETWEEN 1 AND 500
        AND "unsupported_reason" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻\U000E0000-\U000E0FFF]'))
  );

-- ---------------------------------------------------------------------------
-- LP4-02 PR2 task 2.4: Add the factor_parameters table (D2).
-- Calculation parameters sourced from a factor release: leak rates per
-- equipment type, the reference GCV, or any constant a calculation reads.
-- Sealed and withdrawn with the release; follows the unit_conversions pattern.
-- ---------------------------------------------------------------------------

CREATE TABLE "factor_parameters" (
    "id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "subject" TEXT,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "methodology" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "factor_parameters_pkey" PRIMARY KEY ("id")
);

-- Identity: release + key + subject + isDefault
CREATE UNIQUE INDEX "factor_parameters_identity_key"
  ON "factor_parameters"("release_id", "key", "subject", "is_default");

-- A subjectless parameter (the reference GCV): NULLs are distinct in the index
-- above, so this is what holds it to one row per release, key and role.
CREATE UNIQUE INDEX "factor_parameters_no_subject_identity_key"
  ON "factor_parameters"("release_id", "key", "is_default") WHERE "subject" IS NULL;

CREATE INDEX "factor_parameters_key_subject_idx"
  ON "factor_parameters"("key", "subject");

-- FK to factor_releases (RESTRICT: a release with parameters cannot be deleted)
ALTER TABLE "factor_parameters"
  ADD CONSTRAINT "factor_parameters_release_id_fkey"
    FOREIGN KEY ("release_id")
    REFERENCES "factor_releases"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Text constraints: same rules as other factor library fields.
ALTER TABLE "factor_parameters"
  ADD CONSTRAINT "factor_parameters_text_check" CHECK (
    "key" IS NFC NORMALIZED AND char_length("key") BETWEEN 1 AND 100
      AND "key" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻\U000E0000-\U000E0FFF]'
    AND ("subject" IS NULL OR (
      "subject" IS NFC NORMALIZED AND char_length("subject") BETWEEN 1 AND 100
        AND "subject" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻\U000E0000-\U000E0FFF]'))
    AND "unit" IS NFC NORMALIZED AND char_length("unit") BETWEEN 1 AND 32
      AND "unit" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻\U000E0000-\U000E0FFF]'
    AND "source" IS NFC NORMALIZED AND char_length("source") BETWEEN 1 AND 1000
      AND "source" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻\U000E0000-\U000E0FFF]'
    AND ("methodology" IS NULL OR (
      "methodology" IS NFC NORMALIZED AND char_length("methodology") BETWEEN 1 AND 1000
        AND "methodology" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻\U000E0000-\U000E0FFF]'))
  );

-- The import contract's rules again (PARAMETER_KEYS, PARAMETER_UNITS): a positive
-- finite value, each key's one unit, a rate of at most 1, and a subject only on a
-- rate. ELSE false refuses a key it does not name: a NULL CHECK passes.
ALTER TABLE "factor_parameters"
  ADD CONSTRAINT "factor_parameters_value_check" CHECK (
    "value" > 0 AND "value" < 'infinity'::double precision
    AND CASE "key"
      WHEN 'leak_rate' THEN "unit" = 'fraction' AND "value" <= 1 AND "subject" IS NOT NULL
      WHEN 'reference_gcv' THEN "unit" = 'kcal/Sm3' AND "subject" IS NULL
      WHEN 'reference_ncv' THEN "unit" = 'kcal/Sm3' AND "subject" IS NULL
      ELSE false
    END
  );

-- Enable RLS (never FORCE).
ALTER TABLE "factor_parameters" ENABLE ROW LEVEL SECURITY;

-- Authenticated users can SELECT (same as emission_factors and unit_conversions).
CREATE POLICY "factor_parameters_select_authenticated"
  ON "factor_parameters" FOR SELECT TO "authenticated" USING ( true );

-- Loader SELECT and INSERT (no UPDATE, no DELETE).
CREATE POLICY "factor_parameters_loader_select"
  ON "factor_parameters" FOR SELECT TO "tonyai_factor_loader" USING ( true );
CREATE POLICY "factor_parameters_loader_insert"
  ON "factor_parameters" FOR INSERT TO "tonyai_factor_loader" WITH CHECK ( true );

-- Runtime SELECT grant (via tonyai_runtime; reads parameters for calculations).
GRANT SELECT ON "factor_parameters" TO "tonyai_runtime";

-- Loader SELECT and INSERT grant (added to existing grant — but the existing
-- grant is a single statement, so we add a new one for factor_parameters).
GRANT SELECT, INSERT ON "factor_parameters" TO "tonyai_factor_loader";

-- Triggers: same guards as emission_factors and unit_conversions.
-- Before insert: refuse if release is sealed.
CREATE TRIGGER "factor_parameters_before_insert" BEFORE INSERT ON "factor_parameters"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_rows_before_insert"();
-- Before update: refuse always (immutable once inserted).
CREATE TRIGGER "factor_parameters_before_update" BEFORE UPDATE ON "factor_parameters"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_rows_before_update"();
-- Before delete: refuse unless release is fixture.
CREATE TRIGGER "factor_parameters_before_delete" BEFORE DELETE ON "factor_parameters"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_rows_before_delete"();
-- Before truncate: refuse always.
CREATE TRIGGER "factor_parameters_before_truncate" BEFORE TRUNCATE ON "factor_parameters"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."factor_tables_before_truncate"();

-- The row guards and the row events accept factor_parameters. Each function is
-- otherwise as last defined.
CREATE OR REPLACE FUNCTION "public"."factor_rows_before_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  release_status text;
  release_edition text;
  release_sealed_at timestamptz;
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
  END IF;
  -- The status read below must see a withdrawal committed while this
  -- statement waited on the lock; a REPEATABLE READ or SERIALIZABLE snapshot
  -- would not.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA012',
      MESSAGE = 'load factor-library rows under READ COMMITTED: a stricter isolation level cannot see a concurrent withdrawal';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtext('tonyai.factor_release'), pg_catalog.hashtext(NEW."release_id"::text));
  SELECT r."status", r."edition", r."sealed_at" INTO release_status, release_edition, release_sealed_at
    FROM "public"."factor_releases" r WHERE r."id" = NEW."release_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA012',
      MESSAGE = format('release %s does not exist', NEW."release_id");
  END IF;
  -- When the row joined the library: the database's clock, never the loader's.
  NEW."created_at" := pg_catalog.now();
  -- Nested, not `AND`: PL/pgSQL evaluates an expression whole, and a
  -- conversion row has no `version` column to read.
  IF TG_TABLE_NAME = 'emission_factors' THEN
    IF NEW."version" IS DISTINCT FROM release_edition THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA012',
        MESSAGE = format('a factor''s version must be its release''s edition (%s)', release_edition);
    END IF;
  END IF;
  IF release_status = 'withdrawn' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA012',
      MESSAGE = format('release %s is withdrawn: nothing can be added to it', NEW."release_id");
  END IF;
  IF release_sealed_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA012',
      MESSAGE = format('release %s is sealed: nothing can be added to it — an erratum is a new release', NEW."release_id");
  END IF;
  -- Nested for the same reason: a parameter row has no `activity_type`.
  IF TG_TABLE_NAME <> 'factor_parameters' THEN
    IF release_status = 'authoritative' AND NEW."activity_type" = 'unspecified' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA012',
        MESSAGE = format('an authoritative release cannot carry an unspecified activity type (%s, %s)', TG_TABLE_NAME, NEW."category");
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION "public"."factor_rows_record_event"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  touched int;
  recorded int;
BEGIN
  -- It writes as the owner, so it answers for the three row tables only.
  IF TG_RELID NOT IN ('public.emission_factors'::pg_catalog.regclass, 'public.unit_conversions'::pg_catalog.regclass, 'public.factor_parameters'::pg_catalog.regclass) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA010',
      MESSAGE = 'factor_rows_record_event records public.emission_factors, public.unit_conversions and public.factor_parameters only';
  END IF;
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT pg_catalog.count(DISTINCT "release_id")::int INTO touched FROM new_rows;
  ELSE
    SELECT pg_catalog.count(DISTINCT "release_id")::int INTO touched FROM old_rows;
  END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "public"."factor_release_events"
      ("id", "release_id", "publisher", "edition", "release_status", "event", "table_name", "row_count", "db_role", "actor", "occurred_at")
    SELECT gen_random_uuid(), r."id", r."publisher", r."edition", r."status", 'rows_added', TG_TABLE_NAME, n."rows",
           "public"."factor_release_events_actor_role"(), NULLIF(pg_catalog.current_setting('tonyai.actor', true), ''),
           pg_catalog.clock_timestamp()
      FROM (SELECT "release_id", pg_catalog.count(*)::int AS "rows" FROM new_rows GROUP BY "release_id") n
      JOIN "public"."factor_releases" r ON r."id" = n."release_id";
  ELSE
    INSERT INTO "public"."factor_release_events"
      ("id", "release_id", "publisher", "edition", "release_status", "event", "table_name", "row_count", "db_role", "actor", "occurred_at")
    SELECT gen_random_uuid(), r."id", r."publisher", r."edition", r."status", 'rows_deleted', TG_TABLE_NAME, o."rows",
           "public"."factor_release_events_actor_role"(), NULLIF(pg_catalog.current_setting('tonyai.actor', true), ''),
           pg_catalog.clock_timestamp()
      FROM (SELECT "release_id", pg_catalog.count(*)::int AS "rows" FROM old_rows GROUP BY "release_id") o
      JOIN "public"."factor_releases" r ON r."id" = o."release_id";
  END IF;
  -- Every release the statement touched has its event, or the statement
  -- fails: a release deleted in the same statement (a data-modifying CTE)
  -- would otherwise drop its rows' event silently.
  GET DIAGNOSTICS recorded = ROW_COUNT;
  IF recorded <> touched THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA010',
      MESSAGE = format('%s rows of %s release(s) changed but %s could be recorded: delete a release''s rows before the release', TG_TABLE_NAME, touched, recorded);
  END IF;
  RETURN NULL;
END
$fn$;

-- After triggers for event recording.
CREATE TRIGGER "factor_parameters_record_insert" AFTER INSERT ON "factor_parameters"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "public"."factor_rows_record_event"();
CREATE TRIGGER "factor_parameters_record_delete" AFTER DELETE ON "factor_parameters"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION "public"."factor_rows_record_event"();

-- Enable triggers ALWAYS (survive pg_dump --no-triggers restore, replication).
ALTER TABLE "factor_parameters" ENABLE ALWAYS TRIGGER "factor_parameters_before_insert";
ALTER TABLE "factor_parameters" ENABLE ALWAYS TRIGGER "factor_parameters_before_update";
ALTER TABLE "factor_parameters" ENABLE ALWAYS TRIGGER "factor_parameters_before_delete";
ALTER TABLE "factor_parameters" ENABLE ALWAYS TRIGGER "factor_parameters_before_truncate";
ALTER TABLE "factor_parameters" ENABLE ALWAYS TRIGGER "factor_parameters_record_insert";
ALTER TABLE "factor_parameters" ENABLE ALWAYS TRIGGER "factor_parameters_record_delete";

-- Client grants as emission_factors and unit_conversions hold them: from nothing,
-- then read-only for the signed-in client and the service role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping client grants for factor_parameters';
    RETURN;
  END IF;
  REVOKE ALL ON "factor_parameters" FROM anon, authenticated, service_role;
  GRANT SELECT ON "factor_parameters" TO authenticated, service_role;
END
$$;

-- Revoke function execute from client roles.
REVOKE EXECUTE ON FUNCTION
  "public"."factor_rows_before_insert"(),
  "public"."factor_rows_before_update"(),
  "public"."factor_rows_before_delete"(),
  "public"."factor_tables_before_truncate"(),
  "public"."factor_rows_record_event"()
FROM anon, authenticated, service_role;
