-- LP3-04 PR B — the declared inventory boundary (D11, D12, D05; README
-- "Inventory coverage and report datasets"; Decisions 2026-10-15 (second),
-- W1–W13).
--
--  * Six tables: a version header per organisation, reporting year and
--    version; the subsidiaries it declares (each also its company entity) and
--    their sites, with the months each operates (W6); one attribution policy
--    per subsidiary × Scope 1/2 category (D11); one applicability decision per
--    entity × category cell (D12); every named source, an unsupported one too
--    (D05). Obligations, evidence periods, an included cell's sources and every
--    gap are derived from these, never stored.
--  * `inventory_boundary_frozen` (TA014): a version is immutable once frozen —
--    by its confirmation, or by a dataset's capture (W8) — every writer
--    refused, the owner included; the one delete it admits is the
--    organisation's own (W10). Freezing copies the names and geography codes
--    into the version (W7), at the database's clock. While a version stands,
--    a subsidiary or site it names is not deleted (W9).
--  * RLS on, never FORCE: SELECT-only policies for `authenticated`; the
--    client roles hold SELECT and nothing else, the service role included; the
--    runtime role SELECT only — the API reads these tables and writes none
--    yet (W1).
--
-- No index here is partial or NULLS NOT DISTINCT: the company entity's site
-- key is the nil uuid, and a source's claim key is null unless it is included
-- and mapped, so every key is one Prisma models (the CI migration-diff gate
-- accepts no other raw index).
-- New tables only — nothing existing is rewritten — but the foreign keys take
-- SHARE ROW EXCLUSIVE on `organisations`, `subsidiaries` and `locations`, so a
-- lock wait gives up after 5 s rather than stall writes behind a long
-- transaction. Then Prisma records the migration as failed and rolls it back
-- whole: `prisma migrate resolve --rolled-back 20261016120000_lp3_04_inventory_boundary`
-- before deploying again, in a quieter window.
SET LOCAL lock_timeout = '5s';

-- Shadow-DB shim (rls-for-table): Prisma validates migrations on a database
-- without Supabase's `auth` schema. A no-op on real Supabase. Not CREATE OR
-- REPLACE, which would clobber the real `auth.uid()`.
CREATE SCHEMA IF NOT EXISTS "auth";
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth'
      AND p.proname = 'uid'
  ) THEN
    EXECUTE $shim$
      CREATE FUNCTION "auth"."uid"() RETURNS uuid
      LANGUAGE sql STABLE
      AS $body$
        SELECT NULLIF(
          current_setting('request.jwt.claim.sub', true),
          ''
        )::uuid
      $body$
    $shim$;
  END IF;
END
$$;

-- CreateTable
CREATE TABLE "inventory_boundaries" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "reporting_year" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'unconfirmed',
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "frozen_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "inventory_boundaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_boundary_subsidiaries" (
    "boundary_id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "first_month" INTEGER NOT NULL,
    "last_month" INTEGER NOT NULL,
    "subsidiary_name" TEXT,
    "geography_code" TEXT,

    CONSTRAINT "inventory_boundary_subsidiaries_pkey" PRIMARY KEY ("boundary_id","subsidiary_id")
);

-- CreateTable
CREATE TABLE "inventory_boundary_sites" (
    "boundary_id" UUID NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "first_month" INTEGER NOT NULL,
    "last_month" INTEGER NOT NULL,
    "location_name" TEXT,
    "geography_code" TEXT,

    CONSTRAINT "inventory_boundary_sites_pkey" PRIMARY KEY ("boundary_id","location_id")
);

-- CreateTable
CREATE TABLE "inventory_attribution_policies" (
    "boundary_id" UUID NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "reporting_period" TEXT NOT NULL,

    CONSTRAINT "inventory_attribution_policies_pkey" PRIMARY KEY ("boundary_id","subsidiary_id","category")
);

-- CreateTable
CREATE TABLE "inventory_applicability_cells" (
    "boundary_id" UUID NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "location_id" UUID,
    "location_key" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "applicability" TEXT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "inventory_applicability_cells_pkey" PRIMARY KEY ("boundary_id","subsidiary_id","location_key","category")
);

-- CreateTable
CREATE TABLE "inventory_sources" (
    "id" UUID NOT NULL,
    "boundary_id" UUID NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "location_id" UUID,
    "location_key" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "scope" INTEGER NOT NULL,
    "mapping" TEXT NOT NULL,
    "category" TEXT,
    "activity_type" TEXT,
    "included_activity_key" TEXT,
    "unsupported_reason" TEXT,
    "applicability" TEXT NOT NULL,
    "reason" TEXT,
    "reporting_period" TEXT,
    "evidence_reporting_period" TEXT,

    CONSTRAINT "inventory_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_boundaries_organisation_id_reporting_year_version_key" ON "inventory_boundaries"("organisation_id", "reporting_year", "version");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_boundaries_id_organisation_id_key" ON "inventory_boundaries"("id", "organisation_id");

-- CreateIndex
CREATE INDEX "inventory_boundary_subsidiaries_subsidiary_id_organisation__idx" ON "inventory_boundary_subsidiaries"("subsidiary_id", "organisation_id");

-- CreateIndex
CREATE INDEX "inventory_boundary_sites_location_id_subsidiary_id_idx" ON "inventory_boundary_sites"("location_id", "subsidiary_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_boundary_sites_boundary_id_location_id_subsidiary_key" ON "inventory_boundary_sites"("boundary_id", "location_id", "subsidiary_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_attribution_policies_boundary_id_subsidiary_id_ca_key" ON "inventory_attribution_policies"("boundary_id", "subsidiary_id", "category", "reporting_period");

-- CreateIndex
CREATE INDEX "inventory_sources_boundary_id_subsidiary_id_category_report_idx" ON "inventory_sources"("boundary_id", "subsidiary_id", "category", "reporting_period");

-- CreateIndex
CREATE INDEX "inventory_sources_boundary_id_location_id_subsidiary_id_idx" ON "inventory_sources"("boundary_id", "location_id", "subsidiary_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_sources_boundary_id_subsidiary_id_location_key_ca_key" ON "inventory_sources"("boundary_id", "subsidiary_id", "location_key", "category", "included_activity_key");

-- AddForeignKey
ALTER TABLE "inventory_boundaries" ADD CONSTRAINT "inventory_boundaries_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_boundary_subsidiaries" ADD CONSTRAINT "inventory_boundary_subsidiaries_boundary_id_organisation_i_fkey" FOREIGN KEY ("boundary_id", "organisation_id") REFERENCES "inventory_boundaries"("id", "organisation_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_boundary_subsidiaries" ADD CONSTRAINT "inventory_boundary_subsidiaries_subsidiary_id_organisation_fkey" FOREIGN KEY ("subsidiary_id", "organisation_id") REFERENCES "subsidiaries"("id", "organisation_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_boundary_sites" ADD CONSTRAINT "inventory_boundary_sites_boundary_id_subsidiary_id_fkey" FOREIGN KEY ("boundary_id", "subsidiary_id") REFERENCES "inventory_boundary_subsidiaries"("boundary_id", "subsidiary_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_boundary_sites" ADD CONSTRAINT "inventory_boundary_sites_location_id_subsidiary_id_fkey" FOREIGN KEY ("location_id", "subsidiary_id") REFERENCES "locations"("id", "subsidiary_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_attribution_policies" ADD CONSTRAINT "inventory_attribution_policies_boundary_id_subsidiary_id_fkey" FOREIGN KEY ("boundary_id", "subsidiary_id") REFERENCES "inventory_boundary_subsidiaries"("boundary_id", "subsidiary_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_applicability_cells" ADD CONSTRAINT "inventory_applicability_cells_boundary_id_subsidiary_id_fkey" FOREIGN KEY ("boundary_id", "subsidiary_id") REFERENCES "inventory_boundary_subsidiaries"("boundary_id", "subsidiary_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_applicability_cells" ADD CONSTRAINT "inventory_applicability_cells_boundary_id_location_id_subs_fkey" FOREIGN KEY ("boundary_id", "location_id", "subsidiary_id") REFERENCES "inventory_boundary_sites"("boundary_id", "location_id", "subsidiary_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_sources" ADD CONSTRAINT "inventory_sources_boundary_id_subsidiary_id_fkey" FOREIGN KEY ("boundary_id", "subsidiary_id") REFERENCES "inventory_boundary_subsidiaries"("boundary_id", "subsidiary_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_sources" ADD CONSTRAINT "inventory_sources_boundary_id_location_id_subsidiary_id_fkey" FOREIGN KEY ("boundary_id", "location_id", "subsidiary_id") REFERENCES "inventory_boundary_sites"("boundary_id", "location_id", "subsidiary_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_sources" ADD CONSTRAINT "inventory_sources_boundary_id_subsidiary_id_category_repor_fkey" FOREIGN KEY ("boundary_id", "subsidiary_id", "category", "reporting_period") REFERENCES "inventory_attribution_policies"("boundary_id", "subsidiary_id", "category", "reporting_period") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 1. What a row may hold, whoever writes it. Prisma models no CHECK, so it
--    reports no drift for these; `runtime-role.mjs` pins each one's definition
--    (INTEGRITY_CHECKS). The category and period lists are shared-types'
--    Scope 1/2 categories (CATEGORY_SCOPE_MAP), the typed ones
--    (`recordActivityTypesFor`) and REPORTING_PERIODS — a parity spec reads
--    this file. Free text is the factor library's rule: NFC, no edge space, no
--    control, format or bidi character.
--    The copied names are the subsidiaries' and sites' own, unchecked: a
--    freeze never fails on what an older row holds.
-- ---------------------------------------------------------------------------

ALTER TABLE "inventory_boundaries"
  ADD CONSTRAINT "inventory_boundaries_year_check" CHECK ("reporting_year" BETWEEN 2000 AND 2100),
  ADD CONSTRAINT "inventory_boundaries_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "inventory_boundaries_decision_check" CHECK (
        "decision" IN ('unconfirmed', 'confirmed')
    AND ("decision" = 'confirmed') = ("decided_by" IS NOT NULL)
    AND ("decided_by" IS NULL) = ("decided_at" IS NULL)
    -- A confirmed version is frozen: it is confirmed and frozen at once.
    AND ("decision" <> 'confirmed' OR "frozen_at" IS NOT NULL)
  );

ALTER TABLE "inventory_boundary_subsidiaries"
  ADD CONSTRAINT "inventory_boundary_subsidiaries_months_check" CHECK (
    "first_month" BETWEEN 1 AND 12 AND "last_month" BETWEEN "first_month" AND 12
  ),
  ADD CONSTRAINT "inventory_boundary_subsidiaries_frozen_copy_check" CHECK (
        ("subsidiary_name" IS NULL) = ("geography_code" IS NULL)
  );

ALTER TABLE "inventory_boundary_sites"
  -- The nil uuid is the company entity's key in cells and sources, never a site.
  ADD CONSTRAINT "inventory_boundary_sites_location_check" CHECK ("location_id" <> '00000000-0000-0000-0000-000000000000'::uuid),
  ADD CONSTRAINT "inventory_boundary_sites_months_check" CHECK (
    "first_month" BETWEEN 1 AND 12 AND "last_month" BETWEEN "first_month" AND 12
  ),
  ADD CONSTRAINT "inventory_boundary_sites_frozen_copy_check" CHECK (
        ("location_name" IS NULL) = ("geography_code" IS NULL)
  );

ALTER TABLE "inventory_attribution_policies"
  ADD CONSTRAINT "inventory_attribution_policies_category_check" CHECK ("category" IN ('Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants')),
  ADD CONSTRAINT "inventory_attribution_policies_level_check" CHECK ("level" IN ('company', 'sites')),
  ADD CONSTRAINT "inventory_attribution_policies_period_check" CHECK ("reporting_period" IN ('monthly', 'quarterly', 'annual'));

-- The company entity's site key is the nil uuid, which no site may be.
ALTER TABLE "inventory_applicability_cells"
  ADD CONSTRAINT "inventory_applicability_cells_location_key_check" CHECK (
    "location_key" = COALESCE("location_id", '00000000-0000-0000-0000-000000000000'::uuid) AND "location_id" IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid
  ),
  ADD CONSTRAINT "inventory_applicability_cells_category_check" CHECK ("category" IN ('Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants')),
  ADD CONSTRAINT "inventory_applicability_cells_decision_check" CHECK (
        "applicability" IN ('included', 'excluded', 'undetermined')
    AND ("applicability" = 'included') = ("reason" IS NULL)
    AND ("reason" IS NULL OR ("reason" IS NFC NORMALIZED AND char_length("reason") BETWEEN 1 AND 500
        AND "reason" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻\U000E0000-\U000E0FFF]'))
  );

ALTER TABLE "inventory_sources"
  ADD CONSTRAINT "inventory_sources_location_key_check" CHECK (
    "location_key" = COALESCE("location_id", '00000000-0000-0000-0000-000000000000'::uuid) AND "location_id" IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid
  ),
  ADD CONSTRAINT "inventory_sources_name_check" CHECK ("name" IS NFC NORMALIZED AND char_length("name") BETWEEN 1 AND 200
        AND "name" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻\U000E0000-\U000E0FFF]'),
  -- Only an included mapped source claims its key (its activity type, '' for
  -- an untyped category); every other source's is null, so a named exclusion
  -- may share an included meter's entity, category and type (D05).
  ADD CONSTRAINT "inventory_sources_included_key_check" CHECK (
    "included_activity_key" IS NOT DISTINCT FROM
      CASE WHEN "applicability" = 'included' AND "mapping" = 'mapped' THEN COALESCE("activity_type", '') END
  ),
  -- A mapped source: a Scope 1/2 category, the scope CATEGORY_SCOPE_MAP gives
  -- it, and — for a typed category alone — one of its activity types
  -- (`recordActivityTypesFor`; follow-up (21)). An unsupported one: no category
  -- or type, a reason, a declared scope.
  ADD CONSTRAINT "inventory_sources_mapping_check" CHECK (
    ("mapping" = 'mapped'
      AND "category" IN ('Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants')
      AND "unsupported_reason" IS NULL
      AND "scope" = CASE "category" WHEN 'Electricity' THEN 2 ELSE 1 END
      AND CASE "category"
            WHEN 'Fuel' THEN "activity_type" IS NOT NULL AND "activity_type" IN ('diesel', 'gas_oil', 'fuel_oil', 'burning_oil', 'lpg')
            WHEN 'Mobile Combustion' THEN "activity_type" IS NOT NULL AND "activity_type" IN ('diesel', 'petrol', 'lpg', 'cng')
            WHEN 'Refrigerants' THEN "activity_type" IS NOT NULL AND "activity_type" IN ('R-32', 'R-134a', 'R-404A', 'R-407C', 'R-407F', 'R-410A', 'R-448A', 'R-449A', 'R-1234yf')
            ELSE "activity_type" IS NULL
          END)
    OR ("mapping" = 'unsupported'
      AND "category" IS NULL
      AND "activity_type" IS NULL
      AND "scope" IN (1, 2)
      AND "unsupported_reason" IS NOT NULL
      AND ("unsupported_reason" IS NFC NORMALIZED AND char_length("unsupported_reason") BETWEEN 1 AND 500
        AND "unsupported_reason" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻\U000E0000-\U000E0FFF]'))
  ),
  ADD CONSTRAINT "inventory_sources_decision_check" CHECK (
        "applicability" IN ('included', 'excluded', 'undetermined')
    AND ("applicability" = 'included') = ("reason" IS NULL)
    AND ("reason" IS NULL OR ("reason" IS NFC NORMALIZED AND char_length("reason") BETWEEN 1 AND 500
        AND "reason" !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]|[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻\U000E0000-\U000E0FFF]'))
  ),
  -- Only an included source has a cadence; its evidence cadence may be none.
  ADD CONSTRAINT "inventory_sources_cadence_check" CHECK (
        ("applicability" = 'included') = ("reporting_period" IS NOT NULL)
    AND ("reporting_period" IS NULL OR "reporting_period" IN ('monthly', 'quarterly', 'annual'))
    AND ("evidence_reporting_period" IS NULL
      OR ("applicability" = 'included' AND "evidence_reporting_period" IN ('monthly', 'quarterly', 'annual')))
  );

-- ---------------------------------------------------------------------------
-- 2. A frozen version is immutable (TA014)
-- ---------------------------------------------------------------------------
--
-- Both guards are SECURITY DEFINER: the header's copies the names into the
-- version as it freezes, and a row's reads its version's header FOR SHARE —
-- which serialises it against the freeze (FOR SHARE conflicts with the
-- freeze's row lock), so a row written while a version freezes is refused
-- once it commits — and a role that only writes rows would otherwise need
-- UPDATE on the header to take that lock. Neither reads `session_user`: the
-- owner is refused alike (W10's one exception aside). Whole-row triggers,
-- never UPDATE OF: the integrity check refuses a narrowed one.

-- The header. Born unfrozen and unconfirmed (its CHECK ties a confirmation to
-- a freeze); nothing but its decision and its freeze ever changes; it freezes
-- once — in a READ COMMITTED transaction (W8), with every site inside its
-- subsidiary's months — at the database's clock as the freeze runs, and is
-- confirmed in the same update if at all, at the same instant; frozen, it
-- takes no update and no delete — but its organisation's: a cascade from
-- `organisations` reaches it after the organisation's row is gone, and only
-- the owner deletes an organisation (LP4-01, TA004).
CREATE FUNCTION "public"."inventory_boundaries_frozen"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  changing CONSTANT text[] := ARRAY['decision', 'decided_by', 'decided_at', 'frozen_at'];
  stamped timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."frozen_at" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA014',
        MESSAGE = format('inventory boundary %s is created unfrozen: a version freezes once its declarations are in', NEW."id");
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."frozen_at" IS NOT NULL
       AND EXISTS (SELECT 1 FROM "public"."organisations" o WHERE o."id" = OLD."organisation_id") THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA014',
        MESSAGE = format('inventory boundary %s is frozen: it is deleted only with its organisation', OLD."id");
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."frozen_at" IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA014',
      MESSAGE = format('inventory boundary %s is frozen: new facts make a new version', OLD."id");
  END IF;
  -- Every other column, a later migration's included, is the version's
  -- identity: compared as JSON minus the four that change (LP4-02's way).
  IF (pg_catalog.to_jsonb(NEW) - changing) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - changing) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA014',
      MESSAGE = format('inventory boundary %s keeps its organisation, year, version and author', OLD."id");
  END IF;
  IF NEW."frozen_at" IS NOT NULL THEN
    -- W8: in READ COMMITTED each statement below reads what is committed once
    -- this row's lock is held — every row writer's share lock released — so
    -- the copy names every row the version holds. A stricter snapshot, taken
    -- before that wait, misses a row committed meanwhile, with no
    -- serialization failure (its lock was a share lock), and freezes it
    -- unnamed (the review seats' finding, reproduced).
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA014',
        MESSAGE = format('inventory boundary %s freezes in a READ COMMITTED transaction of its own (W8), not at %s',
                         OLD."id", pg_catalog.current_setting('transaction_isolation'));
    END IF;
    -- A site operates inside its subsidiary's months. The rows' guard holds
    -- each write to that rule; this holds the whole version, which two
    -- writers could otherwise pass between them.
    IF EXISTS (
      SELECT 1
        FROM "public"."inventory_boundary_sites" bl
        JOIN "public"."inventory_boundary_subsidiaries" bs
          ON bs."boundary_id" = bl."boundary_id" AND bs."subsidiary_id" = bl."subsidiary_id"
       WHERE bl."boundary_id" = OLD."id"
         AND (bl."first_month" < bs."first_month" OR bl."last_month" > bs."last_month")
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA014',
        MESSAGE = format('inventory boundary %s declares a site operating outside its subsidiary''s months', OLD."id");
    END IF;
    -- The moment the freeze ran, not its transaction's start: the version
    -- may hold rows committed after that.
    stamped := pg_catalog.clock_timestamp();
    NEW."frozen_at" := stamped;
    IF NEW."decision" = 'confirmed' THEN
      NEW."decided_at" := stamped;
    END IF;
    -- W7: the names and geography the version is reported with, as they are
    -- now (the reports' own choice of name: trading, else legal).
    UPDATE "public"."inventory_boundary_subsidiaries" bs
       SET "subsidiary_name" = COALESCE(NULLIF(s."trading_name", ''), s."legal_name"),
           "geography_code" = s."geography_code"
      FROM "public"."subsidiaries" s
     WHERE bs."boundary_id" = OLD."id"
       AND s."id" = bs."subsidiary_id";
    UPDATE "public"."inventory_boundary_sites" bl
       SET "location_name" = l."name",
           "geography_code" = l."geography_code"
      FROM "public"."locations" l
     WHERE bl."boundary_id" = OLD."id"
       AND l."id" = bl."location_id";
  END IF;
  RETURN NEW;
END
$fn$;

-- Every row of a version. A row keeps its key — its version, entity and
-- category, a source its id and entity — so a change of one is a delete and an
-- add: a policy re-keyed under its sources would carry them along through the
-- cadence key's ON UPDATE CASCADE (the review seats' finding). Its version's
-- header, read FOR SHARE: not found, the version itself is being deleted (its
-- cascade, or its organisation's) and the row goes with it; frozen, nothing
-- changes. A site operates inside its subsidiary's months, both ways round.
-- While the version stands, its subsidiary or site is not deleted (W9): a
-- declared subsidiary's or site's row reached by a cascade from that parent is
-- refused — the API's delete paths count these rows first and answer 409.
-- Conditions naming a column only some tables have are nested under the
-- table's name: PL/pgSQL plans a condition whole.
CREATE FUNCTION "public"."inventory_boundary_rows_frozen"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  boundary uuid;
  frozen timestamptz;
  keys text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    keys := CASE TG_TABLE_NAME
      WHEN 'inventory_boundary_subsidiaries' THEN ARRAY['boundary_id', 'organisation_id', 'subsidiary_id']
      WHEN 'inventory_boundary_sites' THEN ARRAY['boundary_id', 'subsidiary_id', 'location_id']
      WHEN 'inventory_attribution_policies' THEN ARRAY['boundary_id', 'subsidiary_id', 'category']
      WHEN 'inventory_applicability_cells' THEN ARRAY['boundary_id', 'subsidiary_id', 'location_id', 'location_key', 'category']
      ELSE ARRAY['id', 'boundary_id', 'subsidiary_id', 'location_id', 'location_key']
    END;
    IF (SELECT pg_catalog.jsonb_object_agg(k, pg_catalog.to_jsonb(NEW) -> k) FROM pg_catalog.unnest(keys) AS k)
       IS DISTINCT FROM (SELECT pg_catalog.jsonb_object_agg(k, pg_catalog.to_jsonb(OLD) -> k) FROM pg_catalog.unnest(keys) AS k) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA014',
        MESSAGE = format('%s keeps its key in its inventory boundary version: delete the row and add another', TG_TABLE_NAME);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    boundary := OLD."boundary_id";
  ELSE
    boundary := NEW."boundary_id";
  END IF;
  SELECT b."frozen_at" INTO frozen
    FROM "public"."inventory_boundaries" b
   WHERE b."id" = boundary
     FOR SHARE;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF frozen IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA014',
      MESSAGE = format('inventory boundary %s is frozen: %s takes no change', boundary, TG_TABLE_NAME);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF TG_TABLE_NAME = 'inventory_boundary_sites' THEN
      IF EXISTS (
        SELECT 1 FROM "public"."inventory_boundary_subsidiaries" bs
         WHERE bs."boundary_id" = NEW."boundary_id" AND bs."subsidiary_id" = NEW."subsidiary_id"
           AND (NEW."first_month" < bs."first_month" OR NEW."last_month" > bs."last_month")
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'TA014',
          MESSAGE = format('site %s operates outside its subsidiary''s months in inventory boundary %s', NEW."location_id", boundary);
      END IF;
    ELSIF TG_TABLE_NAME = 'inventory_boundary_subsidiaries' AND TG_OP = 'UPDATE' THEN
      IF EXISTS (
        SELECT 1 FROM "public"."inventory_boundary_sites" bl
         WHERE bl."boundary_id" = NEW."boundary_id" AND bl."subsidiary_id" = NEW."subsidiary_id"
           AND (bl."first_month" < NEW."first_month" OR bl."last_month" > NEW."last_month")
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'TA014',
          MESSAGE = format('subsidiary %s has a site operating outside its months in inventory boundary %s', NEW."subsidiary_id", boundary);
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'inventory_boundary_subsidiaries' THEN
      IF NOT EXISTS (SELECT 1 FROM "public"."subsidiaries" s WHERE s."id" = OLD."subsidiary_id") THEN
        RAISE EXCEPTION USING
          ERRCODE = 'TA014',
          MESSAGE = format('subsidiary %s is declared in inventory boundary %s: remove it from the version first', OLD."subsidiary_id", boundary);
      END IF;
    ELSIF TG_TABLE_NAME = 'inventory_boundary_sites' THEN
      IF NOT EXISTS (SELECT 1 FROM "public"."locations" l WHERE l."id" = OLD."location_id") THEN
        RAISE EXCEPTION USING
          ERRCODE = 'TA014',
          MESSAGE = format('site %s is declared in inventory boundary %s: remove it from the version first', OLD."location_id", boundary);
      END IF;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE FUNCTION "public"."inventory_boundary_before_truncate"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'TA014',
    MESSAGE = format('%s holds inventory boundary versions: it cannot be truncated', TG_TABLE_NAME);
END
$fn$;

CREATE TRIGGER "inventory_boundaries_frozen"
  BEFORE INSERT OR UPDATE OR DELETE ON "inventory_boundaries"
  FOR EACH ROW EXECUTE FUNCTION "public"."inventory_boundaries_frozen"();
ALTER TABLE "inventory_boundaries" ENABLE ALWAYS TRIGGER "inventory_boundaries_frozen";
CREATE TRIGGER "inventory_boundaries_before_truncate"
  BEFORE TRUNCATE ON "inventory_boundaries"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."inventory_boundary_before_truncate"();
ALTER TABLE "inventory_boundaries" ENABLE ALWAYS TRIGGER "inventory_boundaries_before_truncate";

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'inventory_boundary_subsidiaries',
    'inventory_boundary_sites',
    'inventory_attribution_policies',
    'inventory_applicability_cells',
    'inventory_sources'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "public"."inventory_boundary_rows_frozen"()',
      t || '_frozen', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, t || '_frozen');
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "public"."inventory_boundary_before_truncate"()',
      t || '_before_truncate', t);
    EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER %I', t, t || '_before_truncate');
  END LOOP;
END
$$;

-- Born owner-only since OQ 14; said explicitly, so the functions stay
-- owner-only on a database whose defaults differ. A trigger fires without its
-- function's EXECUTE.
REVOKE ALL ON FUNCTION "public"."inventory_boundaries_frozen"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."inventory_boundary_rows_frozen"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."inventory_boundary_before_truncate"() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 3. Row Level Security (rls-for-table) and the client roles
-- ---------------------------------------------------------------------------
--
-- SELECT-only policies for `authenticated`, never FORCE, no write policy. A
-- row of a version is readable with its subsidiary (LP1-03's predicate: an
-- organisation-wide reader of its organisation, or a granted user whose
-- profile is in that organisation). The header carries no subsidiary: an
-- organisation-wide reader of its organisation, or a granted user one of whose
-- subsidiaries it declares (W3: a scoped user's view is per granted
-- subsidiary). Writes are the API's (none yet) and the owner's: the client
-- roles hold SELECT alone — the service role too (W1's default) — so PostgREST
-- writes nothing here and nobody but the owner truncates.

ALTER TABLE "inventory_boundaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_boundary_subsidiaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_boundary_sites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_attribution_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_applicability_cells" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_sources" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inventory_boundaries_select_scoped" ON "inventory_boundaries"
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM "profiles" p
      WHERE p."id" = (SELECT auth.uid())
        AND p."role" IN ('super_admin', 'consultant', 'executive_viewer')
        AND p."organisation_id" = "inventory_boundaries"."organisation_id"
    )
    OR EXISTS (
      SELECT 1
      FROM "inventory_boundary_subsidiaries" bs
      JOIN "user_subsidiary_access" usa ON usa."subsidiary_id" = bs."subsidiary_id"
      JOIN "profiles" p ON p."id" = usa."user_id"
      WHERE bs."boundary_id" = "inventory_boundaries"."id"
        AND usa."user_id" = (SELECT auth.uid())
        AND p."organisation_id" = "inventory_boundaries"."organisation_id"
    )
  );

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'inventory_boundary_subsidiaries',
    'inventory_boundary_sites',
    'inventory_attribution_policies',
    'inventory_applicability_cells',
    'inventory_sources'
  ] LOOP
    EXECUTE format($policy$
      CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (
        EXISTS (
          SELECT 1
          FROM "subsidiaries" s
          WHERE s."id" = %I."subsidiary_id"
            AND (
              EXISTS (
                SELECT 1
                FROM "user_subsidiary_access" usa
                JOIN "profiles" p ON p."id" = usa."user_id"
                WHERE usa."subsidiary_id" = s."id"
                  AND usa."user_id" = (SELECT auth.uid())
                  AND p."organisation_id" = s."organisation_id"
              )
              OR EXISTS (
                SELECT 1
                FROM "profiles" p
                WHERE p."id" = (SELECT auth.uid())
                  AND p."role" IN ('super_admin', 'consultant', 'executive_viewer')
                  AND p."organisation_id" = s."organisation_id"
              )
            )
        )
      )
    $policy$, t || '_select_scoped', t, t);
  END LOOP;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping the inventory boundary client grants';
    RETURN;
  END IF;
  REVOKE ALL ON "inventory_boundaries", "inventory_boundary_subsidiaries", "inventory_boundary_sites",
    "inventory_attribution_policies", "inventory_applicability_cells", "inventory_sources"
    FROM anon, authenticated, service_role;
  GRANT SELECT ON "inventory_boundaries", "inventory_boundary_subsidiaries", "inventory_boundary_sites",
    "inventory_attribution_policies", "inventory_applicability_cells", "inventory_sources"
    TO anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION "public"."inventory_boundaries_frozen"() FROM anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION "public"."inventory_boundary_rows_frozen"() FROM anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION "public"."inventory_boundary_before_truncate"() FROM anon, authenticated, service_role;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. The runtime role (LP1-03) — `runtime-role.mjs` lists the same
-- ---------------------------------------------------------------------------
--
-- SELECT only: PR B's reader, and the subsidiary and site delete paths'
-- counts (W9). The write path brings its own grants (W1).
GRANT SELECT ON "inventory_boundaries", "inventory_boundary_subsidiaries", "inventory_boundary_sites",
  "inventory_attribution_policies", "inventory_applicability_cells", "inventory_sources"
  TO "tonyai_runtime";
