-- LP4-02 PR B1 (F01; Decisions 2026-10-11, L4/L5, and (second), P1–P10): the
-- factor library gets its one writer, and a draft its one rewriter.
--
-- 1. `factor_releases.sealed_at` (P1, P2). A release is loaded unsealed, its
--    rows join it, and the loader seals it in the same transaction: a sealed
--    release refuses rows, a seal is never undone, and a release left unsealed
--    at commit is refused (a deferred constraint trigger) — so no unsealed
--    release is ever visible, and pricing reads sealed releases only. Every
--    release that exists before this migration is sealed by it (the column's
--    default, then dropped: no trigger runs and no event is written — this
--    migration is that record). A withdrawal is of a sealed release.
-- 2. `tonyai_factor_loader` (L5, P3): NOLOGIN, owns nothing, no BYPASSRLS, a
--    member of no role. It reads and inserts releases, factors and
--    conversions, and updates a release's seal and withdrawal columns only;
--    its own RLS policies admit it. Its login is provisioned per environment
--    (`packages/db/scripts/runtime-role.mjs provision-loader` locally; a
--    deployed environment's operator with psql's `\password`), never here.
-- 3. K11 (L4, P5): a record's calculation and the inputs it was computed from
--    change, while it is a draft (or rejected), in the API's session or the
--    owner's only (TA006); its free-form `input` in theirs at any status. A
--    direct writer (the service role through PostgREST) rewrote a draft's
--    figure, and the author's ordinary submit committed it. The runtime
--    login's own SQL is caught by the API, which recomputes at submit and
--    approve (PR B2).
-- 4. A release is sealed and withdrawn by the loader's session or the
--    owner's alone (TA013) — before this, the service role could withdraw any
--    release (independent review F6). The service role loses INSERT, UPDATE
--    and DELETE on the library: the e2e suite's fixture load and `rls:probe`
--    use the owner.
--
-- SQLSTATEs added to LP3-03's list:
--   TA006  a record's calculation or inputs changed outside the API (K11)
--   TA013  a release sealed or withdrawn by a session other than the loader's
--          or the owner's

-- ---------------------------------------------------------------------------
-- 1. The seal
-- ---------------------------------------------------------------------------

-- Every existing release sealed now, in one statement that fires no trigger.
ALTER TABLE "factor_releases" ADD COLUMN "sealed_at" TIMESTAMPTZ(6) DEFAULT now();
ALTER TABLE "factor_releases" ALTER COLUMN "sealed_at" DROP DEFAULT;
ALTER TABLE "factor_releases"
  ADD CONSTRAINT "factor_releases_withdrawn_sealed_check" CHECK ("status" <> 'withdrawn' OR "sealed_at" IS NOT NULL);

ALTER TABLE "factor_release_events" DROP CONSTRAINT "factor_release_events_event_check";
ALTER TABLE "factor_release_events"
  ADD CONSTRAINT "factor_release_events_event_check"
    CHECK ("event" IN ('loaded', 'rows_added', 'sealed', 'withdrawn', 'rows_deleted', 'deleted'));

-- LP3-03's body, and a release is loaded unsealed: its seal is a change of
-- its own, made once its rows are in.
CREATE OR REPLACE FUNCTION "public"."factor_releases_before_insert"() RETURNS trigger
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
  -- The ordinal and withdrawal reads below must see a release committed while
  -- this statement waited on the publisher's lock; a REPEATABLE READ or
  -- SERIALIZABLE snapshot would not.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA011',
      MESSAGE = 'load a factor release under READ COMMITTED: a stricter isolation level cannot see a concurrent load';
  END IF;
  IF NEW."status" = 'withdrawn' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA011',
      MESSAGE = 'a release cannot be loaded as withdrawn: withdrawal is the change a loaded release accepts';
  END IF;
  IF NEW."sealed_at" IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA011',
      MESSAGE = 'a release is loaded unsealed: its seal closes it once its rows are in, in the same transaction';
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

-- The two changes a release accepts, each once and in this order: its seal
-- (`sealed_at` from NULL to the database's clock — a seal cannot be backdated
-- or undone), then its withdrawal (its status to `withdrawn` with who and why,
-- which the CHECK requires, at the database's clock). Every other column is
-- compared as JSON minus those five, so a column a later migration adds is
-- frozen too. Both are the loader's or the owner's (TA013): `session_user`,
-- the login — a role that could `SET ROLE` to the loader is not the loader.
CREATE OR REPLACE FUNCTION "public"."factor_releases_before_update"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  changing CONSTANT text[] := ARRAY['status', 'withdrawn_at', 'withdrawn_by', 'withdrawal_reason', 'sealed_at'];
BEGIN
  IF session_user <> 'tonyai_factor_loader'
     AND session_user <> (SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA013',
      MESSAGE = format('factor release %s is sealed and withdrawn by the factor loader or the owner only, not %s', OLD."id", session_user);
  END IF;
  -- Exclusive against the row triggers' shared lock: no row joins a release
  -- while it is being sealed or withdrawn.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('tonyai.factor_release'), pg_catalog.hashtext(OLD."id"::text));
  IF (pg_catalog.to_jsonb(NEW) - changing) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - changing) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA010',
      MESSAGE = format('factor release %s is append-only: the changes it accepts are its seal and its withdrawal', OLD."id");
  END IF;
  IF OLD."sealed_at" IS NULL THEN
    IF NEW."sealed_at" IS NULL
       OR NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."withdrawn_at" IS DISTINCT FROM OLD."withdrawn_at"
       OR NEW."withdrawn_by" IS DISTINCT FROM OLD."withdrawn_by"
       OR NEW."withdrawal_reason" IS DISTINCT FROM OLD."withdrawal_reason" THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA010',
        MESSAGE = format('factor release %s is not sealed: its seal is the one change it accepts, alone', OLD."id");
    END IF;
    NEW."sealed_at" := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF NEW."sealed_at" IS DISTINCT FROM OLD."sealed_at"
     OR OLD."status" = 'withdrawn'
     OR NEW."status" <> 'withdrawn' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA010',
      MESSAGE = format('factor release %s is sealed: the one change it accepts is its withdrawal, and a seal is never undone', OLD."id");
  END IF;
  NEW."withdrawn_at" := pg_catalog.now();
  RETURN NEW;
END
$fn$;

-- LP3-03's body, and a sealed release takes no row: its contents are what was
-- loaded with it. The release's shared lock (the seal takes it exclusively)
-- keeps a seal from landing between this check and the insert.
CREATE OR REPLACE FUNCTION "public"."factor_rows_before_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
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
  IF release_status = 'authoritative' AND NEW."activity_type" = 'unspecified' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA012',
      MESSAGE = format('an authoritative release cannot carry an unspecified activity type (%s, %s)', TG_TABLE_NAME, NEW."category");
  END IF;
  RETURN NEW;
END
$fn$;

-- Snapshots point at releases, so only a test run's release may go — the
-- fixture publisher's, now withdrawn ones too: a loader test's erratum
-- withdraws one, and it must leave nothing behind. (The fixture publisher's
-- releases are fixtures or withdrawn ones, nothing else — its CHECK.) Its
-- factors and conversions go first (the foreign keys RESTRICT).
CREATE OR REPLACE FUNCTION "public"."factor_releases_before_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF OLD."status" <> 'fixture' AND NOT (OLD."status" = 'withdrawn' AND OLD."publisher" = 'TonyAI test fixture') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA010',
      MESSAGE = format('factor release %s is %s: only a test fixture release may be deleted', OLD."id", OLD."status");
  END IF;
  RETURN OLD;
END
$fn$;

CREATE OR REPLACE FUNCTION "public"."factor_rows_before_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."factor_releases" r
     WHERE r."id" = OLD."release_id"
       AND (r."status" = 'fixture' OR (r."status" = 'withdrawn' AND r."publisher" = 'TonyAI test fixture'))
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA010',
      MESSAGE = format('%s is append-only: only a test fixture release''s rows may be deleted', TG_TABLE_NAME);
  END IF;
  RETURN OLD;
END
$fn$;

-- LP3-03's record, and a seal is recorded as one, not as a withdrawal.
CREATE OR REPLACE FUNCTION "public"."factor_releases_record_event"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  r record;
  happened text;
  detail jsonb;
BEGIN
  -- It writes as the owner, so it answers for one table only: attached to
  -- any other, it would record whatever that table held.
  IF TG_RELID <> 'public.factor_releases'::pg_catalog.regclass THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA010',
      MESSAGE = 'factor_releases_record_event records public.factor_releases only';
  END IF;
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
  -- Nested: an INSERT has no OLD to compare.
  IF TG_OP = 'INSERT' THEN
    happened := 'loaded';
  ELSIF TG_OP = 'DELETE' THEN
    happened := 'deleted';
  ELSIF NEW."sealed_at" IS DISTINCT FROM OLD."sealed_at" THEN
    happened := 'sealed';
    detail := pg_catalog.jsonb_build_object('sealed_at', NEW."sealed_at");
  ELSE
    happened := 'withdrawn';
    detail := pg_catalog.jsonb_build_object(
      'withdrawn_at', NEW."withdrawn_at", 'withdrawn_by', NEW."withdrawn_by", 'withdrawal_reason', NEW."withdrawal_reason");
  END IF;
  INSERT INTO "public"."factor_release_events"
    ("id", "release_id", "publisher", "edition", "release_status", "event", "detail", "db_role", "actor", "occurred_at")
  VALUES (
    gen_random_uuid(), r."id", r."publisher", r."edition", r."status", happened, detail,
    "public"."factor_release_events_actor_role"(),
    NULLIF(pg_catalog.current_setting('tonyai.actor', true), ''),
    -- The wall clock, not the transaction's start: a load's events order.
    pg_catalog.clock_timestamp()
  );
  RETURN NULL;
END
$fn$;

-- A release still unsealed when its loading transaction commits is refused:
-- the seal belongs to the load. Deferred to the commit, which is when the
-- rows are all in; a data-only restore (replica) carries each release's seal.
CREATE FUNCTION "public"."factor_releases_sealed_at_commit"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM "public"."factor_releases" r WHERE r."id" = NEW."id" AND r."sealed_at" IS NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA011',
      MESSAGE = format('factor release %s was loaded and not sealed: a release is sealed in the transaction that loads it', NEW."id");
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER "factor_releases_sealed_at_commit"
  AFTER INSERT ON "factor_releases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "public"."factor_releases_sealed_at_commit"();
ALTER TABLE "factor_releases" ENABLE ALWAYS TRIGGER "factor_releases_sealed_at_commit";

-- ---------------------------------------------------------------------------
-- 2. The loader role
-- ---------------------------------------------------------------------------

-- Created once per cluster (roles are cluster-wide, so a shadow database
-- replaying this migration finds it already there).
DO $$
DECLARE
  r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'tonyai_factor_loader';
  IF NOT FOUND THEN
    CREATE ROLE "tonyai_factor_loader" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSIF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls THEN
    RAISE EXCEPTION 'LP4-02: role tonyai_factor_loader already exists with attributes this migration does not expect (superuser/createdb/createrole/replication/bypassrls). Fix it by hand before applying.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'tonyai_factor_loader')
  ) THEN
    RAISE EXCEPTION 'LP4-02: role tonyai_factor_loader is a member of another role and would inherit or SET ROLE into its privileges. Revoke the membership before applying.';
  END IF;
END
$$;

-- From nothing on every table, so a re-run ends with exactly the grants below.
REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM "tonyai_factor_loader";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "public" FROM "tonyai_factor_loader";
GRANT USAGE ON SCHEMA "public" TO "tonyai_factor_loader";
-- It reads the library (an identical release already loaded is a no-op, a
-- differing one a refusal), loads releases and their rows, and seals and
-- withdraws a release — the columns those two changes write, nothing else.
-- No DELETE: a fixture is removed by the owner.
GRANT SELECT, INSERT ON "factor_releases", "emission_factors", "unit_conversions" TO "tonyai_factor_loader";
GRANT UPDATE ("sealed_at", "status", "withdrawn_at", "withdrawn_by", "withdrawal_reason")
  ON "factor_releases" TO "tonyai_factor_loader";

-- RLS is on for all three (never FORCE); without BYPASSRLS the loader is
-- admitted by policies of its own. The triggers are the library's rules; the
-- policies only open the door its grants describe.
CREATE POLICY "factor_releases_loader_select" ON "factor_releases" FOR SELECT TO "tonyai_factor_loader" USING ( true );
CREATE POLICY "factor_releases_loader_insert" ON "factor_releases" FOR INSERT TO "tonyai_factor_loader" WITH CHECK ( true );
CREATE POLICY "factor_releases_loader_update" ON "factor_releases" FOR UPDATE TO "tonyai_factor_loader" USING ( true ) WITH CHECK ( true );
CREATE POLICY "emission_factors_loader_select" ON "emission_factors" FOR SELECT TO "tonyai_factor_loader" USING ( true );
CREATE POLICY "emission_factors_loader_insert" ON "emission_factors" FOR INSERT TO "tonyai_factor_loader" WITH CHECK ( true );
CREATE POLICY "unit_conversions_loader_select" ON "unit_conversions" FOR SELECT TO "tonyai_factor_loader" USING ( true );
CREATE POLICY "unit_conversions_loader_insert" ON "unit_conversions" FOR INSERT TO "tonyai_factor_loader" WITH CHECK ( true );

-- ---------------------------------------------------------------------------
-- 3. K11: a draft's figure and inputs are the API's
-- ---------------------------------------------------------------------------

-- LP4-01's body, and what a draft (or a rejected record) says — its
-- calculation and every input K5 freezes once it is committed — changes in
-- the API's session or the owner's alone; its free-form `input` too, at any
-- status (K5 does not hold it). A committed record's other columns stay K5's
-- (TA001, for every writer).
CREATE OR REPLACE FUNCTION "public"."activity_records_lifecycle_writer"() RETURNS trigger
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
  ELSIF session_user <> 'tonyai_runtime'
        AND session_user <> (SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID) THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA005',
        MESSAGE = format('activity record %s moves from %s to %s only through the API, not as %s', OLD."id", OLD."status", NEW."status", session_user);
    END IF;
    IF NEW."input" IS DISTINCT FROM OLD."input"
       OR (OLD."status" IN ('draft', 'rejected') AND (
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
       )) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'TA006',
        MESSAGE = format('activity record %s keeps the figure the API computed and the inputs it computed it from: only the API changes them, not %s', OLD."id", session_user);
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Who may write the library — and the new function's EXECUTE
-- ---------------------------------------------------------------------------

-- A trigger fires without its function's EXECUTE; no role but the owner holds
-- one (`runtime-role.mjs` checks). CREATE OR REPLACE kept the others' ACLs.
REVOKE ALL ON FUNCTION "public"."factor_releases_sealed_at_commit"() FROM PUBLIC;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping their library grants and EXECUTE';
    RETURN;
  END IF;
  -- The library has one writer besides the owner: the loader. The service
  -- role keeps SELECT (PostgREST reads); its row verbs on the library go —
  -- the e2e fixture load and `rls:probe` write through the owner.
  REVOKE INSERT, UPDATE, DELETE ON "factor_releases", "emission_factors", "unit_conversions" FROM service_role;
  REVOKE ALL ON FUNCTION "public"."factor_releases_sealed_at_commit"() FROM anon, authenticated, service_role;
END
$$;
