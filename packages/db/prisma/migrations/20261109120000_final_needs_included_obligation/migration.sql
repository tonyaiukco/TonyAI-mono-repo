-- A final needs at least one included obligation (Decisions 2026-11-09 (4)): an
-- all-excluded boundary has no figure to certify, so it issues as partial and
-- names `no_included_obligation`. The trigger fires at insert, so an all-excluded
-- final issued before this stays retained, unchanged. No dataset or fingerprint
-- changes. A restore, in replica mode, passes this guard, so a dump holding such a
-- final loads and its issued_at survives. CREATE OR REPLACE keeps the function's owner, SECURITY DEFINER setting
-- and grants, and the trigger stays attached.

CREATE OR REPLACE FUNCTION "public"."report_issuances_guard"() RETURNS trigger
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
  -- A data-only restore writes what the dump holds (session_replication_role =
  -- replica, a setting only a privileged role may change), so a retained row,
  -- an all-excluded final from before this rule included, and its issued_at stay
  -- as they were (infra/runbooks/04-verify.md).
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
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
                               'non_authoritative_calculation', 'gwp_set_mismatch',
                               'no_included_obligation')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA017',
      MESSAGE = format('report issuance %s: a gap names no issuance gap code', NEW."id");
  END IF;
  -- A final: of an inventory, its boundary confirmed, at least one included
  -- obligation, its coverage without a gap — as the dataset stored them. The API derives and refuses the rest
  -- (approval, locks, provenance, GWP sets); this holds the floor for every
  -- writer.
  IF NEW."status" = 'final' THEN
    doc := (SELECT d."content"::jsonb FROM "public"."report_datasets" d WHERE d."id" = NEW."dataset_id");
    IF (dataset_selection = 'inventory'
        AND doc->'boundary'->>'decision' = 'confirmed'
        AND pg_catalog.jsonb_array_length(
              CASE WHEN pg_catalog.jsonb_typeof(doc->'coverage'->'obligations') = 'array' THEN doc->'coverage'->'obligations' END
            ) > 0
        AND pg_catalog.jsonb_array_length(
              CASE WHEN pg_catalog.jsonb_typeof(doc->'coverage'->'gaps') = 'array' THEN doc->'coverage'->'gaps' END
            ) = 0) IS NOT TRUE THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA017',
        MESSAGE = format('report issuance %s: a final issues a confirmed inventory with an included obligation and without a coverage gap only', NEW."id");
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
