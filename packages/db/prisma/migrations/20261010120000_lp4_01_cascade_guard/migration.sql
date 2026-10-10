-- LP4-01 (Open questions, "LP3-03 PR B" (11); owner, 2026-10-06): no foreign
-- key's action reaches an activity record any more, and an organisation is
-- deleted by the owner's session alone.
--
-- Before this, a direct database delete of an organisation, a subsidiary or a
-- location — the service role through PostgREST, or the runtime role with SQL
-- access — removed that tenant's committed records, or re-filed a site's at
-- company level, through the foreign key's action: PostgreSQL runs a
-- referential action as the referencing table's owner, and K5's triggers let
-- the owner through. A removed record could then be re-inserted altered. The
-- API does neither: it refuses to delete a subsidiary or a location that holds
-- any record, and it never deletes an organisation. Nothing here changes what
-- the API does.
--
-- 1. `activity_records_location_id_fkey` ON DELETE RESTRICT (was SET NULL), and
--    K5 no longer lets a committed record's location become NULL — the
--    exemption existed only for that SET NULL.
-- 2. `activity_records_subsidiary_id_fkey` ON DELETE RESTRICT (was CASCADE).
--    (1) alone does not stop a subsidiary's delete (independent re-check,
--    2026-10-06, rolled back): PostgreSQL fires foreign-key actions in rounds
--    at the end of the statement — the record key's cascade and the sites'
--    cascade run in the same round, and the site key's RESTRICT check, queued
--    by the latter, runs a round later, when the records are already gone.
--    With (2) no referential action writes `activity_records` at all, so a
--    record is deleted only by a statement on the table itself, where
--    `activity_records_committed_delete` lets the owner alone remove a
--    committed one. A subsidiary, a site or an organisation that holds records
--    is deleted by nobody — the owner included — until its records are.
--    (ON UPDATE CASCADE stays: K5 refuses a committed record's new subsidiary
--    or site whoever writes it, and ids never change.)
-- 3. `organisations_delete_owner_only`: an organisation is created and removed
--    by the operator (D18; D21's offboarding), never by a client. It compares
--    `session_user` — the login, which neither SET ROLE, nor a SECURITY
--    DEFINER function, nor a referential action changes — with the table's
--    owner; `current_user` would not do, since inside a referential action it
--    IS the owner. The runtime role holds no DELETE on `organisations`; the
--    service role did. (TRUNCATE skips row triggers; no client holds it on any
--    table since LP3-03, and `runtime-role.mjs check` reports one that does.)
--
-- `runtime-role.mjs check` (`checkIntegrityTriggers`) holds all three: every
-- foreign key of `activity_records` RESTRICT or NO ACTION on delete, K5's body
-- as defined below, and the organisation guard present, ENABLE ALWAYS and
-- unaltered.

-- Each statement locks `activity_records`, `locations`, `subsidiaries` or
-- `organisations`, which the API reads on every request; queued behind a long
-- transaction, give up rather than stall every request behind it, and let the
-- deploy be retried.
SET LOCAL lock_timeout = '5s';

-- 1 and 2. Same names, same columns, same ON UPDATE.
ALTER TABLE "activity_records" DROP CONSTRAINT "activity_records_location_id_fkey";
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "activity_records" DROP CONSTRAINT "activity_records_subsidiary_id_fkey";
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_subsidiary_id_fkey"
  FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 1. K5 without the location exemption: a committed record's site is frozen
--    like every other input it was computed from. Otherwise LP3-03's body, word
--    for word; CREATE OR REPLACE keeps the function's owner, its ACL (owner
--    only, LP3-03 and OQ 14) and its trigger.
CREATE OR REPLACE FUNCTION "public"."activity_records_snapshot_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
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

-- 3. The guard fires before LP1-03's `organisations_remove_access_before_delete`
--    (BEFORE triggers fire in name order), so a refused delete removes nothing
--    first — and a refusal undoes the whole statement anyway. SQLSTATE TA004
--    (class `TA`, unused by PostgreSQL; no API path deletes an organisation).
CREATE FUNCTION "public"."organisations_delete_owner_only"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF session_user <> (SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA004',
      MESSAGE = format('organisation %s is deleted by the database owner alone (the operator), not by %s', OLD."id", session_user);
  END IF;
  RETURN OLD;
END
$fn$;

CREATE TRIGGER "organisations_delete_owner_only"
  BEFORE DELETE ON "organisations"
  FOR EACH ROW EXECUTE FUNCTION "public"."organisations_delete_owner_only"();
-- Fires in replica mode too: a restore's session cannot slip past it.
ALTER TABLE "organisations" ENABLE ALWAYS TRIGGER "organisations_delete_owner_only";

-- Born owner-only since OQ 14 (this role's defaults); said explicitly, so the
-- function is owner-only on a database whose defaults differ. A trigger fires
-- without its function's EXECUTE.
REVOKE ALL ON FUNCTION "public"."organisations_delete_owner_only"() FROM PUBLIC;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping their EXECUTE';
    RETURN;
  END IF;
  REVOKE ALL ON FUNCTION "public"."organisations_delete_owner_only"() FROM anon, authenticated, service_role;
END
$$;
