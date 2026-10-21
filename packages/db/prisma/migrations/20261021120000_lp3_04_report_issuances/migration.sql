-- LP3-04 PR D — the report issuance (README "The issuance"; Decisions
-- 2026-10-21).
--
--  * `report_issuances`: one row per issuance — a retained dataset issued as
--    a PDF whose exact bytes are kept in the `report-artifacts` bucket (one
--    object, one row: `<organisation>/<artifact>.pdf`), with their SHA-256 and
--    size, the status and gaps the API derived from the dataset, the
--    language, template and options, the renderer, the issuer and the
--    dataset's referenced set (a reader needs every one in their current
--    access, as for the dataset). One per dataset, language, template and
--    options (the unique key): another language or template is another
--    issuance of the same dataset.
--  * `report_issuances_guard` (TA017): an insert issues a retained dataset of
--    its own organisation — its year, canonicalization, fingerprint and
--    referenced set the dataset's; its gap codes the contract's; a final only
--    of an inventory whose boundary was confirmed and whose coverage holds no
--    gap (the dataset's own assessment, as stored — the API derives every
--    other gap). `issued_at` is the database's clock, whatever the insert
--    says. Then the row is retained: no update, and no delete but the
--    organisation's own (as W10), for every writer, the owner included; no
--    TRUNCATE.
--  * RLS on, never FORCE, with no client policy and no client grant, the
--    service role included: the API is the issuance's only reader (as
--    `report_datasets`). The runtime role inserts and reads.
--
-- A new table only; its foreign keys take SHARE ROW EXCLUSIVE on
-- `organisations` and `report_datasets`, so a lock wait gives up after 5 s
-- rather than stall writes behind a long transaction. Then Prisma records the
-- migration as failed and rolls it back whole:
-- `prisma migrate resolve --rolled-back 20261021120000_lp3_04_report_issuances`
-- before deploying again, in a quieter window.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "report_issuances" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "reporting_year" INTEGER NOT NULL,
    "canonicalization" TEXT NOT NULL,
    "dataset_fingerprint_hex" CHAR(64) NOT NULL,
    "status" TEXT NOT NULL,
    "gaps" JSONB NOT NULL,
    "language" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "include_methodology_notes" BOOLEAN NOT NULL,
    "include_evidence_summary" BOOLEAN NOT NULL,
    "renderer_version" TEXT NOT NULL,
    "artifact_id" UUID NOT NULL,
    "storage_path" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "referenced_subsidiary_ids" UUID[],
    "issued_by" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_issuances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_issuances_artifact_id_key" ON "report_issuances"("artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_issuances_storage_path_key" ON "report_issuances"("storage_path");

-- CreateIndex
CREATE INDEX "report_issuances_organisation_id_reporting_year_issued_at_idx" ON "report_issuances"("organisation_id", "reporting_year", "issued_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "report_issuances_dataset_id_language_template_include_metho_key" ON "report_issuances"("dataset_id", "language", "template", "include_methodology_notes", "include_evidence_summary");

-- AddForeignKey
ALTER TABLE "report_issuances" ADD CONSTRAINT "report_issuances_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "report_issuances" ADD CONSTRAINT "report_issuances_dataset_id_organisation_id_fkey" FOREIGN KEY ("dataset_id", "organisation_id") REFERENCES "report_datasets"("id", "organisation_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- What a row is, held for every writer. Prisma models none of these. Each is
-- one flat condition, so `pg_dump` restores the text `runtime-role.mjs` pins
-- (PR C follow-up (10)).
ALTER TABLE "report_issuances"
  ADD CONSTRAINT "report_issuances_status_check"
    CHECK ("status" IN ('final', 'partial')),
  ADD CONSTRAINT "report_issuances_gaps_array_check"
    CHECK (pg_catalog.jsonb_typeof("gaps") = 'array'),
  -- A final has no gap; a partial at least one (the contract's two shapes).
  ADD CONSTRAINT "report_issuances_gaps_status_check"
    CHECK (("status" = 'final') = ("gaps" = '[]'::jsonb)),
  ADD CONSTRAINT "report_issuances_language_check"
    CHECK ("language" IN ('en', 'tr')),
  ADD CONSTRAINT "report_issuances_template_check"
    CHECK ("template" IN ('executive_summary', 'ghg_protocol_detail')),
  ADD CONSTRAINT "report_issuances_canonicalization_check"
    CHECK ("canonicalization" = 'tonyai-report-dataset-v1'),
  ADD CONSTRAINT "report_issuances_dataset_fingerprint_check"
    CHECK ("dataset_fingerprint_hex" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "report_issuances_sha256_check"
    CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "report_issuances_size_check"
    CHECK ("size_bytes" > 0),
  ADD CONSTRAINT "report_issuances_renderer_check"
    CHECK ("renderer_version" <> ''),
  -- The object's key is the row's own: its organisation's prefix, its
  -- artifact — never a path the API was handed.
  ADD CONSTRAINT "report_issuances_storage_path_check"
    CHECK ("storage_path" = ((("organisation_id")::text || '/') || ("artifact_id")::text) || '.pdf'),
  -- As the dataset's: non-empty and without a null.
  ADD CONSTRAINT "report_issuances_referenced_check"
    CHECK ("referenced_subsidiary_ids" IS NOT NULL
           AND pg_catalog.cardinality("referenced_subsidiary_ids") > 0
           AND pg_catalog.array_position("referenced_subsidiary_ids", NULL) IS NULL);

-- ---------------------------------------------------------------------------
-- 2. The guard (TA017)
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER: it reads the dataset whoever inserts — and its path names
-- pg_catalog first and the session's temporary schema last, as every
-- function in `public` (PR C, section 5). The dataset row is retained as
-- captured (TA016), so what it holds here is what it held at capture.
CREATE FUNCTION "public"."report_issuances_guard"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  dataset_year integer;
  dataset_canonicalization text;
  dataset_fingerprint text;
  dataset_referenced uuid[];
  dataset_selection text;
  doc jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "public"."organisations" o WHERE o."id" = OLD."organisation_id") THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA017',
        MESSAGE = format('report issuance %s is retained: it is deleted only with its organisation', OLD."id");
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA017',
      MESSAGE = format('report issuance %s is retained as issued: a correction is a new capture or issuance', OLD."id");
  END IF;
  -- The database's clock, whatever the insert says.
  NEW."issued_at" := pg_catalog.now();
  SELECT d."reporting_year", d."canonicalization", d."fingerprint_hex", d."referenced_subsidiary_ids", d."selection"
    INTO dataset_year, dataset_canonicalization, dataset_fingerprint, dataset_referenced, dataset_selection
  FROM "public"."report_datasets" d
  WHERE d."id" = NEW."dataset_id"
    AND d."organisation_id" = NEW."organisation_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA017',
      MESSAGE = format('report issuance %s issues a retained dataset of its own organisation only', NEW."id");
  END IF;
  -- The dataset's own identity and read rule; NULL on either side fails closed.
  IF (NEW."reporting_year" = dataset_year
      AND NEW."canonicalization" = dataset_canonicalization
      AND NEW."dataset_fingerprint_hex" = dataset_fingerprint
      AND pg_catalog.cardinality(NEW."referenced_subsidiary_ids") = pg_catalog.cardinality(dataset_referenced)
      AND NEW."referenced_subsidiary_ids" OPERATOR(pg_catalog.@>) dataset_referenced
      AND NEW."referenced_subsidiary_ids" OPERATOR(pg_catalog.<@) dataset_referenced) IS NOT TRUE THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA017',
      MESSAGE = format('report issuance %s: its columns and its dataset disagree', NEW."id");
  END IF;
  -- Every gap an object naming one of the contract's codes (a non-array is
  -- the CHECK's to refuse, after this trigger).
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(
      CASE WHEN pg_catalog.jsonb_typeof(NEW."gaps") = 'array' THEN NEW."gaps" END
    ) AS g
    WHERE pg_catalog.jsonb_typeof(g) IS DISTINCT FROM 'object'
       OR (g->>'code') IS NULL
       OR (g->>'code') NOT IN ('filtered_extract', 'coverage_gap', 'unapproved_record', 'unlocked_period',
                               'non_authoritative_calculation', 'gwp_set_mismatch')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA017',
      MESSAGE = format('report issuance %s: a gap names no issuance gap code', NEW."id");
  END IF;
  -- A final: of an inventory, its boundary confirmed, its coverage without a
  -- gap — as the dataset stored them. The API derives and refuses the rest
  -- (approval, locks, provenance, GWP sets); this holds the floor for every
  -- writer.
  IF NEW."status" = 'final' THEN
    doc := (SELECT d."content"::jsonb FROM "public"."report_datasets" d WHERE d."id" = NEW."dataset_id");
    IF (dataset_selection = 'inventory'
        AND doc->'boundary'->>'decision' = 'confirmed'
        AND pg_catalog.jsonb_array_length(
              CASE WHEN pg_catalog.jsonb_typeof(doc->'coverage'->'gaps') = 'array' THEN doc->'coverage'->'gaps' END
            ) = 0) IS NOT TRUE THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA017',
        MESSAGE = format('report issuance %s: a final issues a confirmed inventory without a coverage gap only', NEW."id");
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE FUNCTION "public"."report_issuances_before_truncate"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'TA017',
    MESSAGE = format('%s holds retained report issuances: it cannot be truncated', TG_TABLE_NAME);
END
$fn$;

-- ALWAYS: they fire in replica mode too.
CREATE TRIGGER "report_issuances_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "report_issuances"
  FOR EACH ROW EXECUTE FUNCTION "public"."report_issuances_guard"();
ALTER TABLE "report_issuances" ENABLE ALWAYS TRIGGER "report_issuances_guard";
CREATE TRIGGER "report_issuances_before_truncate"
  BEFORE TRUNCATE ON "report_issuances"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."report_issuances_before_truncate"();
ALTER TABLE "report_issuances" ENABLE ALWAYS TRIGGER "report_issuances_before_truncate";

REVOKE ALL ON FUNCTION "public"."report_issuances_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."report_issuances_before_truncate"() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 3. RLS and the client roles
-- ---------------------------------------------------------------------------
--
-- No client policy: an authenticated client reads no row, and holds no
-- privilege to try. The runtime role's policy keeps the table working should
-- its BYPASSRLS ever go (as `report_datasets_runtime_all`).
ALTER TABLE "report_issuances" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "report_issuances_runtime_all" ON "report_issuances"
  AS PERMISSIVE FOR ALL TO "tonyai_runtime"
  USING (true) WITH CHECK (true);

-- Supabase grants every new table to its client roles by default privilege;
-- the service role among them bypasses RLS. Taken back, all of it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping the report issuance client revokes';
    RETURN;
  END IF;
  REVOKE ALL ON "report_issuances" FROM anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION "public"."report_issuances_guard"() FROM anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION "public"."report_issuances_before_truncate"() FROM anon, authenticated, service_role;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. The runtime role (LP1-03) — `runtime-role.mjs` lists the same
-- ---------------------------------------------------------------------------
--
-- An issuance inserts; the issuance routes and the Storage sweeper read.
-- Never UPDATE or DELETE.
GRANT SELECT, INSERT ON "report_issuances" TO "tonyai_runtime";
