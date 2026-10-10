-- LP4-01 (Open questions, "LP3-03 PR B" (11); owner, 2026-10-06; and the
-- owner's K10, 2026-10-10): an activity record is removed, moved or given a
-- committed status by no one but the owner and the API's login, through its
-- lifecycle. (What a draft says before it is submitted is the API's to check:
-- Open questions, "LP4-01 follow-ups" (6).)
--
-- Before this, a direct database write — the service role through PostgREST,
-- or the runtime role with SQL access — could:
--   * remove a tenant's committed records, or re-file a site's at company
--     level, by deleting an organisation, a subsidiary or a site: a foreign
--     key's action runs as the referencing table's owner, and
--     `activity_records_committed_delete` lets the owner delete a committed
--     record (K5's site exemption let the owner's SET NULL through);
--   * move them to another tenant by moving their parent — a subsidiary to
--     another organisation (the service role), a site to another subsidiary
--     (either; the runtime role holds UPDATE on `locations`);
--   * status one: insert a record as approved or locked (either), or walk a
--     draft up the lifecycle (the service role; the runtime login is the API's
--     and keeps K5's steps), with no review and no audit row.
-- The API does none of these: it refuses to delete a subsidiary or a site that
-- holds any record, never deletes an organisation, never moves a subsidiary or
-- a site, creates records as drafts and moves them through its own gates.
-- None of this changes what the API does (one write follows the new site key:
-- a record update sets `location_id` as a column, since Prisma's relation
-- connect/disconnect would set both columns of the key).
--
-- 1. No referential action writes `activity_records`: each of its keys
--    refuses both its parent's delete and a change of the parent's key
--    (RESTRICT, NO ACTION for the import batch's). The subsidiary key too:
--    with the site key alone, a subsidiary delete still removed its records
--    (independent re-check, 2026-10-06): PostgreSQL fires foreign-key actions
--    in rounds at the end of the statement — the record key's cascade and the
--    sites' cascade run in the same round, and the site key's RESTRICT check,
--    queued by the latter, a round later, when the records are already gone.
--    So a subsidiary, a site or an organisation that holds records is deleted
--    by nobody — the owner included, outside replica mode — until its records
--    are, and only the owner deletes a committed one.
-- 2. The site key becomes (location_id, subsidiary_id) → locations(id,
--    subsidiary_id): a site holding records cannot move to another
--    subsidiary, and a record's site belongs to the record's own subsidiary —
--    the API's rule, now the database's for every writer.
-- 3. K5 no longer exempts a committed record's site becoming NULL — the
--    exemption existed only for the old key's SET NULL.
-- 4. Reserved to the owner's session (the operator: D18 provisions, D21's
--    offboarding retires): deleting an organisation, and changing a
--    subsidiary's id or organisation (D17 held the runtime role to that by a
--    column grant; this holds every client). SQLSTATE TA004.
-- 5. A record is born a draft (TA005), and only the API's role or the owner
--    moves it through its lifecycle (TA005); K5 already holds every status
--    change to a step of that lifecycle.
-- The guards compare `session_user` — the login, which neither SET ROLE, a
-- SECURITY DEFINER function nor a referential action changes — with the
-- table's owner; `current_user` would not do, since inside a referential
-- action it IS the owner. The service role keeps its table privileges
-- (Supabase's defaults); the triggers are what refuse it. TRUNCATE skips row
-- triggers: no client holds it on any table since LP3-03, and
-- `runtime-role.mjs check` reports one that does.
--
-- `runtime-role.mjs check` (`checkIntegrityTriggers`) holds it all: each key of
-- `activity_records` as defined here (RESTRICT or NO ACTION both ways), K5's
-- body, and the three new triggers present, ENABLE ALWAYS and unaltered.

-- The migration holds ACCESS EXCLUSIVE on `activity_records`, `locations`,
-- `subsidiaries` and `import_batches` (and lighter locks on `organisations`)
-- until it commits — tables the API reads on every request. Each lock wait
-- gives up after 5 s rather than stall every request behind a long
-- transaction. Then, or if the precondition below refuses, Prisma records the
-- migration as failed and rolls it back whole: resolve it with
-- `prisma migrate resolve --rolled-back 20261010120000_lp4_01_cascade_guard`
-- before deploying again, in a quieter window.
SET LOCAL lock_timeout = '5s';

-- 2's precondition: no record sits at another subsidiary's site (the API has
-- refused that since WP16; a direct write may not have). Fail before changing
-- anything, with the count, rather than half-way through with a key error.
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n
    FROM "activity_records" r
    JOIN "locations" l ON l."id" = r."location_id"
   WHERE l."subsidiary_id" <> r."subsidiary_id";
  IF n > 0 THEN
    RAISE EXCEPTION 'LP4-01: % activity record(s) sit at a site of another subsidiary; fix the data before applying (a draft can be re-targeted; a committed record only removed, by the owner)', n;
  END IF;
END
$$;

-- 1 and 2. The keys, as Prisma names them.
CREATE UNIQUE INDEX "locations_id_subsidiary_id_key" ON "locations"("id", "subsidiary_id");

ALTER TABLE "activity_records" DROP CONSTRAINT "activity_records_location_id_fkey";
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_location_id_subsidiary_id_fkey"
  FOREIGN KEY ("location_id", "subsidiary_id") REFERENCES "locations"("id", "subsidiary_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "activity_records" DROP CONSTRAINT "activity_records_subsidiary_id_fkey";
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_subsidiary_id_fkey"
  FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "activity_records" DROP CONSTRAINT "activity_records_import_batch_id_fkey";
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_import_batch_id_fkey"
  FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 3. K5 without the site exemption: a committed record's site is frozen like
--    every other input it was computed from. Otherwise LP3-03's body, word for
--    word; CREATE OR REPLACE keeps the function's owner, its ACL (owner only,
--    LP3-03 and OQ 14) and its trigger.
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

-- 4. An organisation is deleted by the owner's session alone. It fires before
--    LP1-03's `organisations_remove_access_before_delete` (BEFORE triggers
--    fire in name order), so a refused delete removes nothing first — and a
--    refusal undoes the whole statement anyway. No API path deletes one.
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
ALTER TABLE "organisations" ENABLE ALWAYS TRIGGER "organisations_delete_owner_only";

-- 4. A subsidiary stays in its organisation, under its id (D17), whoever
--    writes it but the owner. The API's role cannot even try (no column
--    grant); the service role could. A whole-row trigger, not UPDATE OF: the
--    integrity check refuses a narrowed one.
CREATE FUNCTION "public"."subsidiaries_stay_in_organisation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF (NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organisation_id" IS DISTINCT FROM OLD."organisation_id")
     AND session_user <> (SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA004',
      MESSAGE = format('subsidiary %s stays in its organisation under its id: only the database owner (the operator) moves one, not %s', OLD."id", session_user);
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "subsidiaries_stay_in_organisation"
  BEFORE UPDATE ON "subsidiaries"
  FOR EACH ROW EXECUTE FUNCTION "public"."subsidiaries_stay_in_organisation"();
ALTER TABLE "subsidiaries" ENABLE ALWAYS TRIGGER "subsidiaries_stay_in_organisation";

-- 5. Who writes a record's lifecycle. A record is inserted as a draft — the
--    only status the API creates — except by the owner (fixtures, a restore)
--    or in replica mode (a data-only restore, which only the owner may set:
--    the slot rule's own exemption). A status changes only in the API's
--    session (`tonyai_runtime`, LP1-03's login: submit, review, approve,
--    reject, void, the period lock's lock and unlock) or the owner's; K5 holds
--    each change to a step of the lifecycle. Without the second half a client
--    could insert a draft and walk it to approved, one valid step at a time.
CREATE FUNCTION "public"."activity_records_lifecycle_writer"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
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
  ELSIF NEW."status" IS DISTINCT FROM OLD."status"
        AND session_user <> 'tonyai_runtime'
        AND session_user <> (SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA005',
      MESSAGE = format('activity record %s moves from %s to %s only through the API, not as %s', OLD."id", OLD."status", NEW."status", session_user);
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "activity_records_lifecycle_writer"
  BEFORE INSERT OR UPDATE ON "activity_records"
  FOR EACH ROW EXECUTE FUNCTION "public"."activity_records_lifecycle_writer"();
ALTER TABLE "activity_records" ENABLE ALWAYS TRIGGER "activity_records_lifecycle_writer";

-- Born owner-only since OQ 14 (this role's defaults); said explicitly, so the
-- functions stay owner-only on a database whose defaults differ. A trigger
-- fires without its function's EXECUTE.
REVOKE ALL ON FUNCTION "public"."organisations_delete_owner_only"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."subsidiaries_stay_in_organisation"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."activity_records_lifecycle_writer"() FROM PUBLIC;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping their EXECUTE';
    RETURN;
  END IF;
  REVOKE ALL ON FUNCTION "public"."organisations_delete_owner_only"() FROM anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION "public"."subsidiaries_stay_in_organisation"() FROM anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION "public"."activity_records_lifecycle_writer"() FROM anon, authenticated, service_role;
END
$$;
