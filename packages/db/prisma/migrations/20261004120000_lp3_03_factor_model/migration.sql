-- LP3-03 PR B (F01; D05–D09; owner decisions K1–K6, 2026-10-04): the factor
-- model's schema and the record's activity identity.
--
-- 1. `factor_releases` and `unit_conversions`. A factor belongs to one release,
--    which carries its status (authoritative › placeholder › fixture;
--    withdrawn never resolves) and its provenance. A sourced conversion
--    (metered m³ → kWh) is a row of a release too, never a code constant.
-- 2. `emission_factors` gains the dimensions of `FACTOR_IDENTITY_FIELDS`
--    (@tonyai/shared-types), all NOT NULL — `not_applicable` is the sentinel —
--    so the database's unique key and the contract's `identityKey` agree.
-- 3. The pre-LP3-03 rows (local dev and CI databases only: staging and
--    production were never seeded) move under a `placeholder` release per
--    edition; nothing else is created here — placeholder rows come from the
--    seed alone.
-- 4. All three factor tables are append-only in the database: a release may
--    only be withdrawn, a factor or conversion never changes, and only a
--    `fixture` release's rows may be deleted. Vocabularies are CHECKs.
-- 5. `activity_records.activity_type` (K1 = A1) joins the record's uniqueness
--    slot as its seventh column, and a slot holds typed records or one untyped
--    record, never both.
-- 6. K5: a record's calculation snapshot, and every input it was computed
--    from, cannot change once the record has left draft/rejected.
--
-- Triggers raise their own SQLSTATEs (class `TA`, unused by PostgreSQL) so the
-- API can map them without parsing messages:
--   TA001  a non-editable record's snapshot or inputs changed (K5)    → 409
--   TA002  a slot would hold typed and untyped records together        → 409
--   TA010  a factor table's append-only rule was broken
--   TA011  a release was loaded out of order, or already withdrawn
--   TA012  a factor or conversion row does not fit its release
-- 7. `factor_release_events`: every load, withdrawal and fixture deletion of
--    the library, recorded by the database itself for every writer (PR A's
--    obligation 11; owner decision 2026-10-04 — a global, append-only record,
--    since `audit_log` is per tenant and releases are written by the seed and
--    loaders, never through the API).
-- Every trigger is ENABLE ALWAYS: it fires in replica mode too (a restore with
-- `session_replication_role = replica` skips ordinary triggers), and
-- `runtime-role.mjs check` verifies each exists in that state.

-- The statements below take ACCESS EXCLUSIVE locks on tables the API reads on
-- every request. Queued behind a long transaction, they would stall every
-- request; give up instead, and let the deploy be retried.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. New tables
-- ---------------------------------------------------------------------------

CREATE TABLE "factor_releases" (
    "id" UUID NOT NULL,
    "publisher" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "edition" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "source_url" TEXT,
    "licence" TEXT,
    "published_at" DATE,
    "gwp_set" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" DATE,
    "notes" TEXT,
    "withdrawn_at" TIMESTAMPTZ(6),
    "withdrawn_by" TEXT,
    "withdrawal_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "factor_releases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "unit_conversions" (
    "id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "activity_type" TEXT NOT NULL,
    "geography_code" TEXT NOT NULL,
    "reporting_year" INTEGER NOT NULL,
    "data_year" INTEGER NOT NULL,
    "from_unit" TEXT NOT NULL,
    "to_unit" TEXT NOT NULL,
    "multiplier" DOUBLE PRECISION NOT NULL,
    "calorific_basis" TEXT NOT NULL,
    "reference_conditions" TEXT,
    "basis" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_conversions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "factor_release_events" (
    "id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "publisher" TEXT NOT NULL,
    "edition" TEXT NOT NULL,
    "release_status" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "table_name" TEXT,
    "row_count" INTEGER,
    "detail" JSONB,
    "db_role" TEXT NOT NULL,
    "actor" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "factor_release_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "factor_release_events_release_id_occurred_at_idx" ON "factor_release_events"("release_id", "occurred_at");

CREATE UNIQUE INDEX "factor_releases_publisher_ordinal_key" ON "factor_releases"("publisher", "ordinal");
CREATE UNIQUE INDEX "factor_releases_publisher_edition_key" ON "factor_releases"("publisher", "edition");
CREATE INDEX "unit_conversions_category_geography_code_reporting_year_idx" ON "unit_conversions"("category", "geography_code", "reporting_year");
CREATE UNIQUE INDEX "unit_conversions_identity_key" ON "unit_conversions"("release_id", "category", "activity_type", "geography_code", "reporting_year", "from_unit", "to_unit", "calorific_basis");

ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "factor_releases"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- 2. emission_factors: the identity dimensions
-- ---------------------------------------------------------------------------

-- The old key (category, geography, year, version) is replaced by
-- FACTOR_IDENTITY_FIELDS: `version` is a label, and a release may quote one
-- fuel per kWh and per m³.
DROP INDEX "emission_factors_category_geography_code_reporting_year_ver_key";

-- Added nullable and backfilled below, then made NOT NULL: a DEFAULT left on
-- any of them would be drift the schema does not declare.
ALTER TABLE "emission_factors" ADD COLUMN "release_id" UUID,
ADD COLUMN "activity_type" TEXT,
ADD COLUMN "gas" TEXT,
ADD COLUMN "gas_coverage" TEXT,
ADD COLUMN "data_year" INTEGER,
ADD COLUMN "scope2_method" TEXT,
ADD COLUMN "calorific_basis" TEXT;

-- The pre-LP3-03 rows. Their versions are the seed's `YYYY.N` (prototype demo
-- values) or `0000-…` (an end-to-end run's fixture). Anything else is a hand
-- edit nobody can classify — stop rather than guess its status.
DO $$
DECLARE
  unknown_versions text;
BEGIN
  SELECT string_agg(DISTINCT "version", ', ')
    INTO unknown_versions
    FROM "emission_factors"
   WHERE "version" !~ '^[0-9]{4}\.[0-9]{1,2}$'
     AND "version" NOT LIKE '0000-%';
  IF unknown_versions IS NOT NULL THEN
    RAISE EXCEPTION 'LP3-03: emission_factors holds versions that are neither the seed''s demo editions nor e2e fixtures (%); reset this database (pnpm db:reset) or classify them by hand first', unknown_versions;
  END IF;
END
$$;

-- One placeholder release per demo edition. The ordinal is derived from the
-- edition (2026.1 → 202601) so that this migration and the seed — which
-- declares the same releases on a fresh database — always agree on it,
-- whichever editions a database happens to hold. Nothing is created where no
-- factor rows exist (staging, production).
INSERT INTO "factor_releases" ("id", "publisher", "title", "edition", "ordinal", "status", "notes")
SELECT gen_random_uuid(),
       'TonyAI prototype',
       'Prototype demo emission factors (calculation_logic.md §3) — NOT authoritative',
       v."version",
       split_part(v."version", '.', 1)::int * 100 + split_part(v."version", '.', 2)::int,
       'placeholder',
       'Unsourced prototype values. Calculated only where the API runs with ALLOW_PLACEHOLDER_FACTORS=true (local development, CI); refused everywhere else (LP3-03, owner decision K3). Their dimensions (gas coverage, data year, calorific basis) are assumed, not sourced.'
  FROM (SELECT DISTINCT "version" FROM "emission_factors" WHERE "version" NOT LIKE '0000-%') v;

INSERT INTO "factor_releases" ("id", "publisher", "title", "edition", "ordinal", "status", "notes")
SELECT gen_random_uuid(),
       'TonyAI test fixture',
       'End-to-end test fixture factors',
       v."version",
       row_number() OVER (ORDER BY v."version"),
       'fixture',
       'Written by a test run and deleted by its teardown.'
  FROM (SELECT DISTINCT "version" FROM "emission_factors" WHERE "version" LIKE '0000-%') v;

-- Backfill, as the contract reads a pre-LP3-03 row:
-- * activity type — the category's implicit one (`CATEGORY_ACTIVITY_TYPES`),
--   else `unspecified`: the legacy Fuel rows price legacy untyped Fuel records
--   (owner decision, 2026-10-04); a typed record needs a typed row.
-- * gas — the CO2e total (every legacy value is kgCO2e), covering all GHGs.
-- * calorific basis — gross for a fuel-combustion row quoted per kWh (the
--   11.36 m³ → kWh basis already pairs Natural Gas with gross), else none.
-- * Scope 2 method — location-based for every Scope 2 row (D08). The legacy EU
--   Electricity row's methodology text says "residual-mix"; it is kept
--   resolvable as location-based by owner decision (2026-10-04) — a
--   placeholder production refuses — and is relabelled when LP4-02 loads
--   sourced factors (Open questions, "LP3-03 PR B").
UPDATE "emission_factors" f
   SET "release_id" = r."id",
       "activity_type" = CASE f."category"
                           WHEN 'Electricity' THEN 'grid_electricity'
                           WHEN 'Natural Gas' THEN 'natural_gas'
                           WHEN 'Water' THEN 'water_supply'
                           ELSE 'unspecified'
                         END,
       "gas" = 'CO2e',
       "gas_coverage" = 'all_ghg',
       "data_year" = f."reporting_year",
       "scope2_method" = CASE WHEN f."scope" = 2 THEN 'location' ELSE 'not_applicable' END,
       "calorific_basis" = CASE
                             WHEN f."category" IN ('Natural Gas', 'Fuel', 'Mobile Combustion')
                              AND f."normalized_unit" = 'kWh' THEN 'gross'
                             ELSE 'not_applicable'
                           END
  FROM "factor_releases" r
 WHERE r."edition" = f."version"
   AND r."publisher" = CASE WHEN f."version" LIKE '0000-%' THEN 'TonyAI test fixture' ELSE 'TonyAI prototype' END;

ALTER TABLE "emission_factors" ALTER COLUMN "release_id" SET NOT NULL,
ALTER COLUMN "activity_type" SET NOT NULL,
ALTER COLUMN "gas" SET NOT NULL,
ALTER COLUMN "data_year" SET NOT NULL,
ALTER COLUMN "scope2_method" SET NOT NULL,
ALTER COLUMN "calorific_basis" SET NOT NULL;

CREATE UNIQUE INDEX "emission_factors_identity_key" ON "emission_factors"("release_id", "category", "activity_type", "gas", "geography_code", "reporting_year", "scope2_method", "calorific_basis", "normalized_unit");

ALTER TABLE "emission_factors" ADD CONSTRAINT "emission_factors_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "factor_releases"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- 3. Vocabularies and provenance (CHECK constraints — invisible to Prisma)
-- ---------------------------------------------------------------------------
-- Clean text mirrors shared-types' `textIssue` for the characters that matter:
-- non-empty, no leading/trailing white space, a length cap
-- (FACTOR_IMPORT_TEXT_LIMITS), no control characters, no invisible formatting
-- or default-ignorable characters (bidi overrides, zero-width marks, BOM,
-- variation selectors, fillers, tags), NFC. These columns are copied into
-- every snapshot that cites a release and printed in reports.

ALTER TABLE "factor_releases"
  ADD CONSTRAINT "factor_releases_status_check"
    CHECK ("status" IN ('authoritative', 'placeholder', 'fixture', 'withdrawn')),
  -- The closed publisher registry (PR A's review: a look-alike name must not
  -- become a second publisher, with its own ordinals and an "ambiguous" key).
  -- Only the two internal publishers exist until LP4-02's migration adds the
  -- real ones — so no authoritative release can be loaded before then.
  ADD CONSTRAINT "factor_releases_publisher_check"
    CHECK ("publisher" IN ('TonyAI prototype', 'TonyAI test fixture')),
  ADD CONSTRAINT "factor_releases_placeholder_publisher_check"
    CHECK (("status" = 'placeholder') <= ("publisher" = 'TonyAI prototype')
       AND ("publisher" = 'TonyAI prototype') <= ("status" IN ('placeholder', 'withdrawn'))),
  ADD CONSTRAINT "factor_releases_fixture_publisher_check"
    CHECK (("status" = 'fixture') <= ("publisher" = 'TonyAI test fixture')
       AND ("publisher" = 'TonyAI test fixture') <= ("status" IN ('fixture', 'withdrawn'))),
  ADD CONSTRAINT "factor_releases_ordinal_check" CHECK ("ordinal" > 0),
  ADD CONSTRAINT "factor_releases_gwp_set_check"
    CHECK ("gwp_set" IS NULL OR "gwp_set" IN ('AR4', 'AR5', 'AR6')),
  -- An authoritative release names its publication, licence and date, and was
  -- reviewed against it (D24) on or after that date.
  ADD CONSTRAINT "factor_releases_authoritative_provenance_check"
    CHECK ("status" <> 'authoritative' OR (
      "source_url" IS NOT NULL AND "licence" IS NOT NULL AND "published_at" IS NOT NULL
      AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)),
  ADD CONSTRAINT "factor_releases_review_after_publication_check"
    CHECK ("reviewed_at" IS NULL OR "published_at" IS NULL OR "reviewed_at" >= "published_at"),
  -- Who, when and why are set together, exactly when the release is withdrawn.
  ADD CONSTRAINT "factor_releases_withdrawal_check"
    CHECK (CASE WHEN "status" = 'withdrawn'
                THEN "withdrawn_at" IS NOT NULL AND "withdrawn_by" IS NOT NULL AND "withdrawal_reason" IS NOT NULL
                ELSE "withdrawn_at" IS NULL AND "withdrawn_by" IS NULL AND "withdrawal_reason" IS NULL
           END),
  -- An https URL with a host and no `user@` part or backslash (shared-types'
  -- PROVENANCE_URL).
  ADD CONSTRAINT "factor_releases_source_url_check"
    CHECK ("source_url" IS NULL OR (char_length("source_url") <= 2000
      AND "source_url" ~ '^https://[^\s/?#@\\]+([/?#][^\s\\]*)?$')),
  ADD CONSTRAINT "factor_releases_text_check" CHECK (
        "title" IS NFC NORMALIZED AND char_length("title") BETWEEN 1 AND 500
    AND "title" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\U000E0000-\U000E0FFF]'
    AND "edition" IS NFC NORMALIZED AND char_length("edition") BETWEEN 1 AND 100
    AND "edition" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\U000E0000-\U000E0FFF]'
    AND ("licence" IS NULL OR ("licence" IS NFC NORMALIZED AND char_length("licence") BETWEEN 1 AND 500
      AND "licence" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\U000E0000-\U000E0FFF]'))
    AND ("notes" IS NULL OR ("notes" IS NFC NORMALIZED AND char_length("notes") BETWEEN 1 AND 2000
      AND "notes" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\U000E0000-\U000E0FFF]'))
    AND ("reviewed_by" IS NULL OR ("reviewed_by" IS NFC NORMALIZED AND char_length("reviewed_by") BETWEEN 1 AND 200
      AND "reviewed_by" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\U000E0000-\U000E0FFF]'))
    AND ("withdrawn_by" IS NULL OR ("withdrawn_by" IS NFC NORMALIZED AND char_length("withdrawn_by") BETWEEN 1 AND 200
      AND "withdrawn_by" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\U000E0000-\U000E0FFF]'))
    AND ("withdrawal_reason" IS NULL OR ("withdrawal_reason" IS NFC NORMALIZED AND char_length("withdrawal_reason") BETWEEN 1 AND 2000
      AND "withdrawal_reason" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\U000E0000-\U000E0FFF]'))
  );

ALTER TABLE "emission_factors"
  ADD CONSTRAINT "emission_factors_activity_type_check"
    CHECK ("activity_type" ~ '^[A-Za-z0-9_-]{1,32}$'),
  ADD CONSTRAINT "emission_factors_gas_check"
    CHECK ("gas" IN ('CO2e', 'CO2', 'CH4', 'N2O', 'CO2_biogenic')),
  -- Coverage describes a CO2e total; a per-gas row carries none. `IS NOT
  -- NULL` is spelled out: `NULL IN (…)` is NULL, which a CHECK lets through.
  ADD CONSTRAINT "emission_factors_gas_coverage_check"
    CHECK (CASE WHEN "gas" = 'CO2e'
                THEN "gas_coverage" IS NOT NULL AND "gas_coverage" IN ('all_ghg', 'co2_only')
                ELSE "gas_coverage" IS NULL
           END),
  ADD CONSTRAINT "emission_factors_calorific_basis_check"
    CHECK ("calorific_basis" IN ('gross', 'net', 'not_applicable')),
  ADD CONSTRAINT "emission_factors_scope2_method_check"
    CHECK ("scope2_method" IN ('location', 'market', 'not_applicable')
       AND ("scope" = 2) = ("scope2_method" <> 'not_applicable')),
  ADD CONSTRAINT "emission_factors_scope_check" CHECK ("scope" IN (1, 2, 3)),
  -- Finite and non-negative: NaN compares above every number in PostgreSQL,
  -- so `< 'Infinity'` refuses it too.
  ADD CONSTRAINT "emission_factors_factor_value_check"
    CHECK ("factor_value" >= 0 AND "factor_value" < 'Infinity'::double precision);

ALTER TABLE "unit_conversions"
  ADD CONSTRAINT "unit_conversions_activity_type_check"
    CHECK ("activity_type" ~ '^[A-Za-z0-9_-]{1,32}$'),
  ADD CONSTRAINT "unit_conversions_calorific_basis_check"
    CHECK ("calorific_basis" IN ('gross', 'net', 'not_applicable')),
  ADD CONSTRAINT "unit_conversions_multiplier_check"
    CHECK ("multiplier" > 0 AND "multiplier" < 'Infinity'::double precision),
  ADD CONSTRAINT "unit_conversions_units_check" CHECK ("from_unit" <> "to_unit"),
  ADD CONSTRAINT "unit_conversions_text_check" CHECK (
        "basis" IS NFC NORMALIZED AND char_length("basis") BETWEEN 1 AND 2000
    AND "basis" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\U000E0000-\U000E0FFF]'
    AND ("reference_conditions" IS NULL OR ("reference_conditions" IS NFC NORMALIZED
      AND char_length("reference_conditions") BETWEEN 1 AND 200
      AND "reference_conditions" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\U000E0000-\U000E0FFF]'))
  );

-- ---------------------------------------------------------------------------
-- 4. activity_records: the activity type and the seven-column slot (K1, K2)
-- ---------------------------------------------------------------------------

-- Nullable, default collation: NULL for an implicit category and for every
-- record written before LP3-03. The token shape is the API DTO's.
ALTER TABLE "activity_records" ADD COLUMN "activity_type" TEXT;
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_activity_type_check"
  CHECK ("activity_type" IS NULL OR "activity_type" ~ '^[A-Za-z0-9_-]{1,32}$');

-- Same name, the activity type as its last column — the definition CI's
-- `migration-diff` index contract (#151) expects verbatim. NULLS NOT DISTINCT:
-- legacy untyped rows still collide with each other exactly as before.
DROP INDEX "activity_records_reporting_entity_period_category_key";
CREATE UNIQUE INDEX "activity_records_reporting_entity_period_category_key"
  ON "activity_records" ("subsidiary_id", "location_id", "reporting_year", "reporting_period", "period_value", "category", "activity_type")
  NULLS NOT DISTINCT
  WHERE "status" <> 'voided';

-- K5 — the snapshot is immutable outside draft and rejected. The API already
-- edits only those statuses (EDITABLE_STATUSES, with a compare-and-set on the
-- status); this holds for every writer — the runtime role, the owner, a
-- service-role client. It tests OLD's status, so a status-only transition
-- (submit, approve, the period lock's bulk lock/unlock, void) and the anomaly
-- fields pass, and a record cannot be moved back to draft and edited in one
-- statement. Nor in several: every status change must be one the API's
-- lifecycle makes (submit, start review, approve, reject, void, the period
-- lock's lock and unlock), so no writer can walk a committed record back
-- through review to rewrite it, and `draft` stays a create-time status.
-- `location_id` may only
-- become NULL, and only inside its foreign key's ON DELETE SET NULL (a nested
-- trigger, depth > 1), never by a direct edit. The status lists are pinned to
-- the API by parity tests. OLD/NEW only — no query, no SECURITY DEFINER.
CREATE FUNCTION "public"."activity_records_snapshot_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF OLD."status" NOT IN ('draft', 'rejected') AND (
       NEW."calculation" IS DISTINCT FROM OLD."calculation"
    OR NEW."activity_type" IS DISTINCT FROM OLD."activity_type"
    OR NEW."category" IS DISTINCT FROM OLD."category"
    OR NEW."activity_value" IS DISTINCT FROM OLD."activity_value"
    OR NEW."activity_unit" IS DISTINCT FROM OLD."activity_unit"
    OR NEW."scope" IS DISTINCT FROM OLD."scope"
    OR NEW."reporting_year" IS DISTINCT FROM OLD."reporting_year"
    OR NEW."reporting_period" IS DISTINCT FROM OLD."reporting_period"
    OR NEW."period_value" IS DISTINCT FROM OLD."period_value"
    OR NEW."subsidiary_id" IS DISTINCT FROM OLD."subsidiary_id"
    OR (NEW."location_id" IS DISTINCT FROM OLD."location_id"
        AND (NEW."location_id" IS NOT NULL OR pg_catalog.pg_trigger_depth() < 2))
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

CREATE TRIGGER "activity_records_snapshot_immutable"
  BEFORE UPDATE ON "activity_records"
  FOR EACH ROW EXECUTE FUNCTION "public"."activity_records_snapshot_immutable"();
ALTER TABLE "activity_records" ENABLE ALWAYS TRIGGER "activity_records_snapshot_immutable";

-- K5's other half: a committed record cannot be rewritten by deleting it and
-- inserting a forged copy under the same id. Only a draft or rejected record
-- is deleted by a statement (the API's own rule); a committed one goes only
-- with its subsidiary or organisation (a foreign-key cascade, which runs this
-- at depth > 1) or by the table's owner — the same trusted role that could
-- disable the trigger, used by test teardown on local and CI databases.
CREATE FUNCTION "public"."activity_records_committed_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF OLD."status" NOT IN ('draft', 'rejected')
     AND pg_catalog.pg_trigger_depth() < 2
     AND current_user <> (SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA001',
      MESSAGE = format('activity record %s is %s: a committed record is never deleted on its own', OLD."id", OLD."status");
  END IF;
  RETURN OLD;
END
$fn$;

CREATE TRIGGER "activity_records_committed_delete"
  BEFORE DELETE ON "activity_records"
  FOR EACH ROW EXECUTE FUNCTION "public"."activity_records_committed_delete"();
ALTER TABLE "activity_records" ENABLE ALWAYS TRIGGER "activity_records_committed_delete";

-- A slot (the first six key columns) holds typed records — one per activity
-- type — or ONE untyped record, never both: an untyped Fuel record beside a
-- diesel one would count the same fuel twice. The unique index cannot say it
-- (NULL ≠ 'diesel'), so this trigger does, for every writer. The advisory lock
-- serialises writers of one slot, so two concurrent inserts — one typed, one
-- not — cannot both pass the check; it is taken only when a row enters a slot
-- or changes kind, never on a status-only update (the period lock's bulk
-- update stays lock-free). Slot keys are hashed: a collision only serialises
-- two unrelated slots.
CREATE FUNCTION "public"."activity_records_slot_kind"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF NEW."status" = 'voided' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."status" <> 'voided'
     AND NEW."subsidiary_id" = OLD."subsidiary_id"
     AND NEW."location_id" IS NOT DISTINCT FROM OLD."location_id"
     AND NEW."reporting_year" = OLD."reporting_year"
     AND NEW."reporting_period" = OLD."reporting_period"
     AND NEW."period_value" = OLD."period_value"
     AND NEW."category" = OLD."category"
     AND (NEW."activity_type" IS NULL) = (OLD."activity_type" IS NULL) THEN
    RETURN NEW;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('tonyai.activity_record_slot'),
    pg_catalog.hashtext(pg_catalog.concat_ws(
      '|', NEW."subsidiary_id", NEW."location_id", NEW."reporting_year",
      NEW."reporting_period", NEW."period_value", NEW."category")));
  IF EXISTS (
    SELECT 1
      FROM "public"."activity_records" r
     WHERE r."subsidiary_id" = NEW."subsidiary_id"
       AND r."location_id" IS NOT DISTINCT FROM NEW."location_id"
       AND r."reporting_year" = NEW."reporting_year"
       AND r."reporting_period" = NEW."reporting_period"
       AND r."period_value" = NEW."period_value"
       AND r."category" = NEW."category"
       AND r."status" <> 'voided'
       AND r."id" <> NEW."id"
       AND (r."activity_type" IS NULL) <> (NEW."activity_type" IS NULL)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA002',
      MESSAGE = format('a %s record for this reporting entity and period already exists %s an activity type; a slot holds typed records or one untyped record, never both',
                       NEW."category",
                       CASE WHEN NEW."activity_type" IS NULL THEN 'with' ELSE 'without' END);
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "activity_records_slot_kind"
  BEFORE INSERT OR UPDATE ON "activity_records"
  FOR EACH ROW EXECUTE FUNCTION "public"."activity_records_slot_kind"();
ALTER TABLE "activity_records" ENABLE ALWAYS TRIGGER "activity_records_slot_kind";

-- ---------------------------------------------------------------------------
-- 5. The factor library is append-only
-- ---------------------------------------------------------------------------

-- A release is loaded with its status — never as `withdrawn` — and with an
-- ordinal above every ordinal its publisher already has, so an erratum always
-- outranks what it corrects and an old edition cannot be re-imported over a
-- newer one. The advisory lock serialises loads of one publisher.
CREATE FUNCTION "public"."factor_releases_before_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  -- A data-only restore (session_replication_role = replica, a setting only
  -- the owner can use — the same trust as disabling a trigger) re-inserts
  -- what was already accepted, withdrawn releases included: the load-time
  -- rules and the record's writers stand aside; every change-guard does not.
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
  END IF;
  IF NEW."status" = 'withdrawn' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA011',
      MESSAGE = 'a release cannot be loaded as withdrawn: withdrawal is the change a loaded release accepts';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('tonyai.factor_release_publisher'),
    pg_catalog.hashtext(NEW."publisher"));
  IF EXISTS (
    SELECT 1 FROM "public"."factor_releases" r
     WHERE r."publisher" = NEW."publisher" AND r."ordinal" >= NEW."ordinal"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA011',
      MESSAGE = format('release ordinal %s of %s does not exceed the publisher''s latest; an erratum is a new release with the next ordinal', NEW."ordinal", NEW."publisher");
  END IF;
  RETURN NEW;
END
$fn$;

-- The one change a release accepts: withdrawal — its status to `withdrawn`
-- with who and why (the CHECK above requires them), every other column
-- unchanged. Compared as JSON minus those four columns, so a column a later
-- migration adds is frozen too. `withdrawn_at` is the database's clock, never
-- the caller's: a withdrawal cannot be backdated.
CREATE FUNCTION "public"."factor_releases_before_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  -- Exclusive against the row triggers' shared lock: no row joins a release
  -- while it is being withdrawn.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('tonyai.factor_release'), pg_catalog.hashtext(OLD."id"::text));
  IF OLD."status" = 'withdrawn'
     OR NEW."status" <> 'withdrawn'
     OR (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'withdrawn_at', 'withdrawn_by', 'withdrawal_reason'])
        IS DISTINCT FROM
        (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'withdrawn_at', 'withdrawn_by', 'withdrawal_reason']) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA010',
      MESSAGE = format('factor release %s is append-only: the one change it accepts is its withdrawal', OLD."id");
  END IF;
  NEW."withdrawn_at" := pg_catalog.now();
  RETURN NEW;
END
$fn$;

-- Snapshots point at releases, so only a test run's fixture release may go.
-- Its factors and conversions go first (the foreign keys RESTRICT).
CREATE FUNCTION "public"."factor_releases_before_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF OLD."status" <> 'fixture' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA010',
      MESSAGE = format('factor release %s is %s: only a fixture release may be deleted', OLD."id", OLD."status");
  END IF;
  RETURN OLD;
END
$fn$;

-- A factor or conversion joins a live release only, and `unspecified` (the
-- legacy untyped record's lookup) never under an authoritative one — the
-- release's status cannot later become authoritative, so checking at insert
-- is enough. A shared advisory lock on the release — the withdrawal trigger
-- takes it exclusively — keeps a withdrawal from landing between this check
-- and the insert, without asking the loader for UPDATE on releases (which a
-- row lock would, and which would let it withdraw them). A factor's `version` is its release's
-- edition: the label `GET /factors` shows and the one a snapshot records.
CREATE FUNCTION "public"."factor_rows_before_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  release_status text;
  release_edition text;
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
  SELECT r."status", r."edition" INTO release_status, release_edition
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
  IF release_status = 'authoritative' AND NEW."activity_type" = 'unspecified' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA012',
      MESSAGE = format('an authoritative release cannot carry an unspecified activity type (%s, %s)', TG_TABLE_NAME, NEW."category");
  END IF;
  RETURN NEW;
END
$fn$;

CREATE FUNCTION "public"."factor_rows_before_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'TA010',
    MESSAGE = format('%s is append-only: a loaded row never changes; an erratum is a new release', TG_TABLE_NAME);
END
$fn$;

CREATE FUNCTION "public"."factor_rows_before_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."factor_releases" r
     WHERE r."id" = OLD."release_id" AND r."status" = 'fixture'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA010',
      MESSAGE = format('%s is append-only: only a fixture release''s rows may be deleted', TG_TABLE_NAME);
  END IF;
  RETURN OLD;
END
$fn$;

-- TRUNCATE is not subject to row triggers or RLS; refused outright.
CREATE FUNCTION "public"."factor_tables_before_truncate"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'TA010',
    MESSAGE = format('%s is append-only: it cannot be truncated', TG_TABLE_NAME);
END
$fn$;

CREATE TRIGGER "factor_releases_before_insert" BEFORE INSERT ON "factor_releases"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_releases_before_insert"();
CREATE TRIGGER "factor_releases_before_update" BEFORE UPDATE ON "factor_releases"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_releases_before_update"();
CREATE TRIGGER "factor_releases_before_delete" BEFORE DELETE ON "factor_releases"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_releases_before_delete"();
CREATE TRIGGER "factor_releases_before_truncate" BEFORE TRUNCATE ON "factor_releases"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."factor_tables_before_truncate"();

CREATE TRIGGER "emission_factors_before_insert" BEFORE INSERT ON "emission_factors"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_rows_before_insert"();
CREATE TRIGGER "emission_factors_before_update" BEFORE UPDATE ON "emission_factors"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_rows_before_update"();
CREATE TRIGGER "emission_factors_before_delete" BEFORE DELETE ON "emission_factors"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_rows_before_delete"();
CREATE TRIGGER "emission_factors_before_truncate" BEFORE TRUNCATE ON "emission_factors"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."factor_tables_before_truncate"();

CREATE TRIGGER "unit_conversions_before_insert" BEFORE INSERT ON "unit_conversions"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_rows_before_insert"();
CREATE TRIGGER "unit_conversions_before_update" BEFORE UPDATE ON "unit_conversions"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_rows_before_update"();
CREATE TRIGGER "unit_conversions_before_delete" BEFORE DELETE ON "unit_conversions"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_rows_before_delete"();
CREATE TRIGGER "unit_conversions_before_truncate" BEFORE TRUNCATE ON "unit_conversions"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."factor_tables_before_truncate"();

ALTER TABLE "factor_releases" ENABLE ALWAYS TRIGGER "factor_releases_before_insert";
ALTER TABLE "factor_releases" ENABLE ALWAYS TRIGGER "factor_releases_before_update";
ALTER TABLE "factor_releases" ENABLE ALWAYS TRIGGER "factor_releases_before_delete";
ALTER TABLE "factor_releases" ENABLE ALWAYS TRIGGER "factor_releases_before_truncate";
ALTER TABLE "emission_factors" ENABLE ALWAYS TRIGGER "emission_factors_before_insert";
ALTER TABLE "emission_factors" ENABLE ALWAYS TRIGGER "emission_factors_before_update";
ALTER TABLE "emission_factors" ENABLE ALWAYS TRIGGER "emission_factors_before_delete";
ALTER TABLE "emission_factors" ENABLE ALWAYS TRIGGER "emission_factors_before_truncate";
ALTER TABLE "unit_conversions" ENABLE ALWAYS TRIGGER "unit_conversions_before_insert";
ALTER TABLE "unit_conversions" ENABLE ALWAYS TRIGGER "unit_conversions_before_update";
ALTER TABLE "unit_conversions" ENABLE ALWAYS TRIGGER "unit_conversions_before_delete";
ALTER TABLE "unit_conversions" ENABLE ALWAYS TRIGGER "unit_conversions_before_truncate";

-- The trigger functions are not callable as functions (they return trigger),
-- but PostgreSQL grants EXECUTE to PUBLIC on creation; take it back so the
-- runtime-role check reads a clean list.
REVOKE ALL ON FUNCTION
  "public"."activity_records_snapshot_immutable"(),
  "public"."activity_records_committed_delete"(),
  "public"."activity_records_slot_kind"(),
  "public"."factor_releases_before_insert"(),
  "public"."factor_releases_before_update"(),
  "public"."factor_releases_before_delete"(),
  "public"."factor_rows_before_insert"(),
  "public"."factor_rows_before_update"(),
  "public"."factor_rows_before_delete"(),
  "public"."factor_tables_before_truncate"()
FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 5b. The library's own record: factor_release_events
-- ---------------------------------------------------------------------------
-- Every load (a release, then its rows), withdrawal and fixture deletion,
-- written by AFTER triggers for every writer — the seed, the e2e suite's
-- service-role client, LP4-02's loader, an operator's SQL. No release is ever
-- written through the API, so an API-side audit row could not see one.
--
-- Not `audit_log`: that is per tenant (organisation, actor profile, the trail
-- viewer's vocabulary), and the library is global.
--
-- Who: the database role (`SET ROLE` when there is one, else the login —
-- `service_role` for PostgREST, `postgres` for the seed) and, when the writer
-- states one, `tonyai.actor` (`SET LOCAL tonyai.actor = '<firm or role>'`; a
-- firm or role, never a person, as with `reviewed_by`). When: the database
-- clock. The functions are SECURITY DEFINER so the table needs no INSERT grant
-- for anyone: only these triggers write it, and nothing may change it.
ALTER TABLE "factor_release_events"
  ADD CONSTRAINT "factor_release_events_event_check"
    CHECK ("event" IN ('loaded', 'rows_added', 'withdrawn', 'rows_deleted', 'deleted')),
  -- `actor` is STATED by the writer, never verified: bounded clean text like
  -- the release's own reviewer field, so a reader can print it safely.
  ADD CONSTRAINT "factor_release_events_actor_check"
    CHECK ("actor" IS NULL OR ("actor" IS NFC NORMALIZED AND char_length("actor") BETWEEN 1 AND 200
      AND "actor" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\U000E0000-\U000E0FFF]')),
  ADD CONSTRAINT "factor_release_events_db_role_check" CHECK (char_length("db_role") BETWEEN 1 AND 63),
  ADD CONSTRAINT "factor_release_events_rows_check"
    CHECK (("event" IN ('rows_added', 'rows_deleted')) = ("table_name" IS NOT NULL AND "row_count" IS NOT NULL));

CREATE FUNCTION "public"."factor_release_events_actor_role"() RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $fn$
  SELECT CASE WHEN pg_catalog.current_setting('role') <> 'none'
              THEN pg_catalog.current_setting('role')
              ELSE session_user::text END
$fn$;

CREATE FUNCTION "public"."factor_releases_record_event"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  r record;
BEGIN
  -- A data-only restore carries its own record; writing it again would
  -- attribute every restored load to the restoring role.
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  -- An authoritative release names who loaded it (a firm or role), not only
  -- the database role.
  IF TG_OP = 'INSERT' AND r."status" = 'authoritative'
     AND NULLIF(pg_catalog.current_setting('tonyai.actor', true), '') IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA011',
      MESSAGE = 'load an authoritative release with tonyai.actor set (SET LOCAL tonyai.actor = ''<firm or role>'')';
  END IF;
  INSERT INTO "public"."factor_release_events"
    ("id", "release_id", "publisher", "edition", "release_status", "event", "detail", "db_role", "actor", "occurred_at")
  VALUES (
    gen_random_uuid(), r."id", r."publisher", r."edition", r."status",
    CASE TG_OP WHEN 'INSERT' THEN 'loaded' WHEN 'UPDATE' THEN 'withdrawn' ELSE 'deleted' END,
    CASE WHEN TG_OP = 'UPDATE' THEN pg_catalog.jsonb_build_object(
      'withdrawn_at', NEW."withdrawn_at", 'withdrawn_by', NEW."withdrawn_by", 'withdrawal_reason', NEW."withdrawal_reason") END,
    "public"."factor_release_events_actor_role"(),
    NULLIF(pg_catalog.current_setting('tonyai.actor', true), ''),
    -- The wall clock, not the transaction's start: a load's events order.
    pg_catalog.clock_timestamp()
  );
  RETURN NULL;
END
$fn$;

-- One row per release a statement touched, with the count: a load of 400
-- factors is one event, not 400.
CREATE FUNCTION "public"."factor_rows_record_event"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  touched int;
  recorded int;
BEGIN
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

-- The record is itself append-only, for every role: no UPDATE or DELETE, and
-- no INSERT but its writers' (a nested trigger, depth > 1) — not even the
-- owner's, short of disabling the guard (which the runtime-role check
-- reports). A data-only restore (replica) re-inserts it.
CREATE FUNCTION "public"."factor_release_events_before_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF pg_catalog.pg_trigger_depth() < 2
     AND pg_catalog.current_setting('session_replication_role') <> 'replica' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA010',
      MESSAGE = 'factor_release_events is written by the factor library''s own triggers only';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE FUNCTION "public"."factor_release_events_refuse"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'TA010',
    MESSAGE = 'factor_release_events is append-only: the library''s record never changes';
END
$fn$;

CREATE TRIGGER "factor_releases_record_event" AFTER INSERT OR UPDATE OR DELETE ON "factor_releases"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_releases_record_event"();
CREATE TRIGGER "emission_factors_record_insert" AFTER INSERT ON "emission_factors"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "public"."factor_rows_record_event"();
CREATE TRIGGER "emission_factors_record_delete" AFTER DELETE ON "emission_factors"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION "public"."factor_rows_record_event"();
CREATE TRIGGER "unit_conversions_record_insert" AFTER INSERT ON "unit_conversions"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "public"."factor_rows_record_event"();
CREATE TRIGGER "unit_conversions_record_delete" AFTER DELETE ON "unit_conversions"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION "public"."factor_rows_record_event"();
CREATE TRIGGER "factor_release_events_before_update" BEFORE UPDATE ON "factor_release_events"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_release_events_refuse"();
CREATE TRIGGER "factor_release_events_before_delete" BEFORE DELETE ON "factor_release_events"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_release_events_refuse"();
CREATE TRIGGER "factor_release_events_before_truncate" BEFORE TRUNCATE ON "factor_release_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."factor_tables_before_truncate"();

ALTER TABLE "factor_releases" ENABLE ALWAYS TRIGGER "factor_releases_record_event";
ALTER TABLE "emission_factors" ENABLE ALWAYS TRIGGER "emission_factors_record_insert";
ALTER TABLE "emission_factors" ENABLE ALWAYS TRIGGER "emission_factors_record_delete";
ALTER TABLE "unit_conversions" ENABLE ALWAYS TRIGGER "unit_conversions_record_insert";
ALTER TABLE "unit_conversions" ENABLE ALWAYS TRIGGER "unit_conversions_record_delete";
ALTER TABLE "factor_release_events" ENABLE ALWAYS TRIGGER "factor_release_events_before_update";
ALTER TABLE "factor_release_events" ENABLE ALWAYS TRIGGER "factor_release_events_before_delete";
ALTER TABLE "factor_release_events" ENABLE ALWAYS TRIGGER "factor_release_events_before_truncate";

REVOKE ALL ON FUNCTION
  "public"."factor_release_events_before_insert"(),
  "public"."factor_release_events_actor_role"(),
  "public"."factor_releases_record_event"(),
  "public"."factor_rows_record_event"(),
  "public"."factor_release_events_refuse"()
FROM PUBLIC;

-- The releases this migration moved the pre-LP3-03 rows under were created
-- before the record existed: record them now, as loaded by this migration.
INSERT INTO "factor_release_events"
  ("id", "release_id", "publisher", "edition", "release_status", "event", "table_name", "row_count", "db_role", "actor")
SELECT gen_random_uuid(), r."id", r."publisher", r."edition", r."status", e."event", e."table_name", e."row_count",
       current_user, 'LP3-03 migration (pre-release rows)'
  FROM "factor_releases" r
  CROSS JOIN LATERAL (
    VALUES ('loaded', NULL::text, NULL::int),
           ('rows_added', 'emission_factors', (SELECT count(*)::int FROM "emission_factors" f WHERE f."release_id" = r."id"))
  ) AS e("event", "table_name", "row_count");

CREATE TRIGGER "factor_release_events_before_insert" BEFORE INSERT ON "factor_release_events"
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_release_events_before_insert"();
ALTER TABLE "factor_release_events" ENABLE ALWAYS TRIGGER "factor_release_events_before_insert";

-- ---------------------------------------------------------------------------
-- 6. Row Level Security and grants
-- ---------------------------------------------------------------------------

-- Reference data, like `emission_factors` (rls_emission_factors): every
-- authenticated user may read every row; no tenant predicate by design. RLS on,
-- never FORCE. No anon policy. Writes stay on the owner and the service role
-- (seed, LP4-02's loader); no client role and not the API may write.
-- (If factors ever gain an organisation dimension — supplier-specific
-- market-based factors — those rows are tenant data and need tenant-scoped
-- policies and `accessibleSubsidiaryIds`, not this policy.)
ALTER TABLE "factor_releases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit_conversions" ENABLE ROW LEVEL SECURITY;
-- No policy at all: no client role reads or writes the library's record.
ALTER TABLE "factor_release_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "factor_releases_select_authenticated"
  ON "factor_releases" FOR SELECT TO "authenticated" USING ( true );
CREATE POLICY "unit_conversions_select_authenticated"
  ON "unit_conversions" FOR SELECT TO "authenticated" USING ( true );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping client grants for the factor tables';
    RETURN;
  END IF;
  -- From nothing: anon reads none of the factor library, and `authenticated`
  -- loses the write verbs it held on `emission_factors` since postgrest_grants
  -- (refused by RLS until now, and by privilege from here on).
  REVOKE ALL ON "factor_releases", "unit_conversions", "emission_factors", "factor_release_events" FROM anon, authenticated;
  GRANT SELECT ON "emission_factors", "unit_conversions" TO authenticated;
  -- `reviewed_by`, `withdrawn_by` and `notes` are withheld: every tenant can
  -- read this table, and those name the people and firms behind a release.
  GRANT SELECT (
    "id", "publisher", "title", "edition", "ordinal", "status", "source_url", "licence",
    "published_at", "gwp_set", "reviewed_at", "withdrawn_at", "withdrawal_reason", "created_at"
  ) ON "factor_releases" TO authenticated;
  -- The service role keeps the row verbs the seed's and e2e's loads use; the
  -- table-level ones it inherits by default privilege it has no use for here.
  -- (TRUNCATE is refused by trigger too; this is the second lock.)
  REVOKE TRUNCATE, TRIGGER, REFERENCES ON "factor_releases", "unit_conversions", "emission_factors" FROM service_role;
  -- The record is written by its triggers alone; the service role may read it.
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON "factor_release_events" FROM service_role;
  -- Nor may it attach a trigger to the records K5 guards, or truncate them or
  -- the audit trail (default privileges handed it every table verb).
  REVOKE TRUNCATE, TRIGGER, REFERENCES ON "activity_records", "audit_log" FROM service_role;
  -- MAINTAIN (PostgreSQL 17) would let it VACUUM FULL, CLUSTER or REINDEX
  -- them: maintenance under an exclusive lock, which is the owner's. (It keeps
  -- LOCK TABLE wherever it keeps UPDATE or DELETE; a lock blocks, never rewrites.)
  IF pg_catalog.current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON "factor_releases", "unit_conversions", "emission_factors", "factor_release_events", "activity_records", "audit_log" FROM service_role';
  END IF;
END
$$;

-- The API reads the library and never writes it (`runtime-role.mjs`'s
-- RUNTIME_TABLE_PRIVILEGES lists the same).
-- `factor_release_events` is not granted: nothing in the API reads it yet,
-- and the grant arrives with its first reader.
GRANT SELECT ON "factor_releases", "unit_conversions" TO "tonyai_runtime";
