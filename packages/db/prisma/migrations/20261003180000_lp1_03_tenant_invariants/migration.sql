-- LP1-03 (F06): tenant and administrative invariants.
--
-- 1. A grant of a subsidiary to a profile can only join the SAME organisation —
--    enforced by composite foreign keys, so it holds for every writer (the API,
--    the seed, a service-role client, the owner), not only for the API's guard.
-- 2. Every RLS policy's explicit-grant branch also requires the same
--    organisation, independently of (1): before this, a stray cross-organisation
--    grant row was refused by the API's guard but honoured by PostgREST.
-- 3. A least-privilege runtime role, `tonyai_runtime`, for the API process and
--    its tools (DATABASE_URL). Migrations, DDL and the seed stay on the owner
--    (DIRECT_URL). See README "Security model" for the trust boundary.

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
    EXECUTE $fn$
      CREATE FUNCTION "auth"."uid"() RETURNS uuid
      LANGUAGE sql STABLE
      AS $body$
        SELECT NULLIF(
          current_setting('request.jwt.claim.sub', true),
          ''
        )::uuid
      $body$;
    $fn$;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. Same-organisation grants
-- ---------------------------------------------------------------------------

-- Never guess which side of a cross-organisation grant is wrong, and never
-- delete one silently: stop, and let a person remove it with an audit note.
DO $$
DECLARE
  bad integer;
BEGIN
  SELECT count(*) INTO bad
  FROM "user_subsidiary_access" usa
  JOIN "profiles" p ON p."id" = usa."user_id"
  JOIN "subsidiaries" s ON s."id" = usa."subsidiary_id"
  WHERE p."organisation_id" IS DISTINCT FROM s."organisation_id";
  IF bad > 0 THEN
    RAISE EXCEPTION 'LP1-03: % user_subsidiary_access row(s) join a profile and a subsidiary of different organisations (or a profile with none). Remove them by hand, with an audit note, before applying this migration.', bad;
  END IF;
END
$$;

-- DropForeignKey
ALTER TABLE "user_subsidiary_access" DROP CONSTRAINT "user_subsidiary_access_subsidiary_id_fkey";

-- DropForeignKey
ALTER TABLE "user_subsidiary_access" DROP CONSTRAINT "user_subsidiary_access_user_id_fkey";

-- AlterTable: added nullable, back-filled from the subsidiary (equal to the
-- profile's, checked above), then made required.
ALTER TABLE "user_subsidiary_access" ADD COLUMN "organisation_id" UUID;

UPDATE "user_subsidiary_access" usa
SET "organisation_id" = s."organisation_id"
FROM "subsidiaries" s
WHERE s."id" = usa."subsidiary_id";

ALTER TABLE "user_subsidiary_access" ALTER COLUMN "organisation_id" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "profiles_id_organisation_id_key" ON "profiles"("id", "organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "subsidiaries_id_organisation_id_key" ON "subsidiaries"("id", "organisation_id");

-- CreateIndex
CREATE INDEX "user_subsidiary_access_subsidiary_id_idx" ON "user_subsidiary_access"("subsidiary_id");

-- AddForeignKey. A profile with no organisation matches no (id, organisation)
-- pair, so it can hold no grant.
ALTER TABLE "user_subsidiary_access" ADD CONSTRAINT "user_subsidiary_access_user_id_organisation_id_fkey" FOREIGN KEY ("user_id", "organisation_id") REFERENCES "profiles"("id", "organisation_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_subsidiary_access" ADD CONSTRAINT "user_subsidiary_access_subsidiary_id_organisation_id_fkey" FOREIGN KEY ("subsidiary_id", "organisation_id") REFERENCES "subsidiaries"("id", "organisation_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Deleting an organisation sets its profiles' organisation to NULL and
-- cascades to its subsidiaries — and with the keys above, whether a grant is
-- removed (by the subsidiary cascade) before its profile's key changes depends
-- on the order PostgreSQL fires the two cascades in, which follows constraint
-- OIDs and can differ after a dump and restore. Measured on this schema: the
-- profile side fired first and the delete was refused. The organisation's
-- grants go first, explicitly, so the delete behaves the same everywhere.
-- Prisma does not model triggers, so this reports no drift.
CREATE FUNCTION "public"."organisations_remove_access_before_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  DELETE FROM "public"."user_subsidiary_access" WHERE "organisation_id" = OLD."id";
  RETURN OLD;
END
$fn$;

CREATE TRIGGER "organisations_remove_access_before_delete"
  BEFORE DELETE ON "organisations"
  FOR EACH ROW EXECUTE FUNCTION "public"."organisations_remove_access_before_delete"();

-- ---------------------------------------------------------------------------
-- 2. RLS: the explicit-grant branch requires the same organisation
-- ---------------------------------------------------------------------------
--
-- The branch joins the caller's own profile and compares organisations itself
-- rather than trusting `user_subsidiary_access.organisation_id`, so the policy
-- holds even if the foreign keys above were ever dropped. It mirrors the API's
-- guard (`auth.guard.ts`), which intersects a data_entry user's grants with
-- the profile's organisation. The organisation-wide branch is unchanged.

ALTER POLICY "subsidiaries_select_scoped" ON "subsidiaries" USING (
  EXISTS (
    SELECT 1
    FROM "user_subsidiary_access" usa
    JOIN "profiles" p ON p."id" = usa."user_id"
    WHERE usa."subsidiary_id" = "subsidiaries"."id"
      AND usa."user_id" = (SELECT auth.uid())
      AND p."organisation_id" = "subsidiaries"."organisation_id"
  )
  OR EXISTS (
    SELECT 1
    FROM "profiles" p
    WHERE p."id" = (SELECT auth.uid())
      AND p."role" IN ('super_admin', 'consultant', 'executive_viewer')
      AND p."organisation_id" = "subsidiaries"."organisation_id"
  )
);

-- The seven tables that carry `subsidiary_id` share one predicate: the row's
-- subsidiary is one the caller may read.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'locations',
    'activity_records',
    'activity_record_evidence',
    'evidence',
    'period_locks',
    'targets',
    'subsidiary_denominators'
  ] LOOP
    EXECUTE format($policy$
      ALTER POLICY %I ON %I USING (
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

-- An import batch: organisation-wide readers of its organisation, or its
-- uploader when every subsidiary it touched is granted to them AND belongs to
-- the batch's organisation (before, a grant was enough, whatever its subsidiary's
-- organisation).
ALTER POLICY "import_batches_select_scoped" ON "import_batches" USING (
  EXISTS (
    SELECT 1
    FROM "profiles" p
    WHERE p."id" = (SELECT auth.uid())
      AND p."organisation_id" = "import_batches"."organisation_id"
      AND p."role" IN ('super_admin', 'consultant', 'executive_viewer')
  )
  OR (
    "import_batches"."uploaded_by" = (SELECT auth.uid())
    AND cardinality("import_batches"."subsidiary_ids") > 0
    AND EXISTS (
      SELECT 1
      FROM "profiles" p
      WHERE p."id" = (SELECT auth.uid())
        AND p."organisation_id" = "import_batches"."organisation_id"
    )
    AND NOT EXISTS (
      SELECT 1
      FROM unnest("import_batches"."subsidiary_ids") AS sid(sid)
      WHERE NOT EXISTS (
        SELECT 1
        FROM "user_subsidiary_access" usa
        JOIN "subsidiaries" s ON s."id" = usa."subsidiary_id"
        WHERE usa."user_id" = (SELECT auth.uid())
          AND usa."subsidiary_id" = sid.sid
          AND s."organisation_id" = "import_batches"."organisation_id"
      )
    )
  )
);

-- ---------------------------------------------------------------------------
-- 3. The runtime role
-- ---------------------------------------------------------------------------
--
-- What it is for: the owner (`postgres`) can alter policies, write
-- `_prisma_migrations`, rewrite or truncate `audit_log`, and create roles. A
-- process that only serves requests needs none of that, so the API, its
-- in-process Storage sweeper and the operational scripts (`storage:reconcile`,
-- `anomaly:recompute`) connect as this role instead. It owns nothing.
--
-- BYPASSRLS, deliberately: the API is the primary tenant boundary — every
-- service scopes by `accessibleSubsidiaryIds` — and acts for every tenant, and
-- the sweeper's owned-bytes guard must see EVERY row of `evidence`,
-- `import_batches` and `storage.objects` (`storage.objects` belongs to
-- Supabase's storage admin, so no policy of ours can be written on it). RLS
-- stays the defense-in-depth layer for PostgREST clients (`authenticated`,
-- `anon`); it never filtered the API's queries, before or after this role.
-- Never FORCE RLS.
--
-- No password and NOLOGIN here: a credential never goes into git. The login is
-- provisioned per environment — locally by `packages/db/scripts/runtime-role.mjs`
-- (loopback only), in a deployed environment by its operator (rotation runbook).
-- Created once per cluster (roles are cluster-wide, so a shadow database
-- replaying this migration finds it already there).
DO $$
DECLARE
  r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'tonyai_runtime';
  IF NOT FOUND THEN
    CREATE ROLE "tonyai_runtime" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;
  ELSIF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR NOT r.rolbypassrls THEN
    RAISE EXCEPTION 'LP1-03: role tonyai_runtime already exists with attributes this migration does not expect (superuser/createdb/createrole/replication, or no bypassrls). Fix it by hand before applying.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'tonyai_runtime')
  ) THEN
    RAISE EXCEPTION 'LP1-03: role tonyai_runtime is a member of another role and would inherit or SET ROLE into its privileges. Revoke the membership before applying.';
  END IF;
END
$$;

-- Start from nothing on every table, so a re-run (a reset database, a
-- pre-existing role) ends with exactly the grants below.
REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM "tonyai_runtime";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "public" FROM "tonyai_runtime";
GRANT USAGE ON SCHEMA "public" TO "tonyai_runtime";

-- Read-only to the runtime. Profiles and organisations are created by the
-- operator boundary (LP4-01), not by a request; factors are reference data
-- written by the seed/import tooling.
GRANT SELECT ON "organisations", "emission_factors" TO "tonyai_runtime";

-- A profile: read by the guard on every request; only its role changes at
-- runtime (`AccessAdminService`, LP1-03's mutation boundary). Column-level, so
-- the runtime can never move a profile to another organisation (D17) or
-- rewrite its identity. `updated_at` is Prisma's @updatedAt on the same UPDATE.
GRANT SELECT ON "profiles" TO "tonyai_runtime";
GRANT UPDATE ("role", "updated_at") ON "profiles" TO "tonyai_runtime";

-- Grants: read by the guard; granted and revoked by `AccessAdminService`.
-- A grant is never edited in place.
GRANT SELECT, INSERT, DELETE ON "user_subsidiary_access" TO "tonyai_runtime";

-- Tenant data the API creates, edits and deletes.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "subsidiaries",
  "locations",
  "targets",
  "subsidiary_denominators",
  "activity_records"
TO "tonyai_runtime";

-- Evidence: never edited, but UPDATE is what `SELECT … FOR UPDATE` requires,
-- and LP1-01's lifecycle protocol row-locks files that way.
GRANT SELECT, INSERT, UPDATE, DELETE ON "evidence" TO "tonyai_runtime";
GRANT SELECT, INSERT, DELETE ON "activity_record_evidence" TO "tonyai_runtime";
GRANT SELECT, INSERT, DELETE ON "period_locks" TO "tonyai_runtime";
GRANT SELECT, INSERT, UPDATE ON "import_batches" TO "tonyai_runtime";

-- The audit trail is append-only for the runtime: written with every mutation,
-- read by `/audit`, never updated, deleted or truncated.
GRANT SELECT, INSERT ON "audit_log" TO "tonyai_runtime";

-- LP1-02's Storage protocol: the API writes, claims (FOR UPDATE SKIP LOCKED),
-- updates and deletes intents.
GRANT SELECT, INSERT, UPDATE, DELETE ON "storage_intents" TO "tonyai_runtime";

-- `storage_intents` has RLS on and, until now, no policy at all — it is
-- operational state, not tenant data, and no client role may touch it. Its only
-- legitimate reader and writer is the runtime, so its one policy names exactly
-- that role. Under today's BYPASSRLS it changes nothing; it states the intended
-- access in RLS terms, so the table keeps working for the runtime if BYPASSRLS
-- is ever removed, and it grants client roles nothing.
CREATE POLICY "storage_intents_runtime_all" ON "storage_intents"
  AS PERMISSIVE FOR ALL TO "tonyai_runtime"
  USING (true) WITH CHECK (true);

-- Nothing on `_prisma_migrations` (the REVOKE above covers it): the runtime
-- can neither read nor forge the migration history.

-- `storage:reconcile` and the sweeper's owned-bytes guard read
-- `storage.objects` (and cast its name to regclass, which needs USAGE). Only
-- where Supabase's storage schema exists.
DO $$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE 'storage.objects absent — skipping the runtime storage grants';
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA "storage" TO "tonyai_runtime";
  GRANT SELECT ON "storage"."objects" TO "tonyai_runtime";
END
$$;
