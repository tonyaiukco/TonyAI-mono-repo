-- Defense-in-depth: Supabase Row Level Security (RLS) for the public tenant tables.
--
-- PRIMARY tenant enforcement lives in the NestJS guard (apps/api), which scopes every
-- query to `accessibleSubsidiaryIds`. These policies are the SECONDARY layer: a direct
-- PostgREST / anon / authenticated client must NOT be able to read cross-tenant data
-- even if the application layer is bypassed.
--
-- NOTE on the backend bypass (verified against this local Supabase image):
--   * The NestJS/Prisma backend connects as the `postgres` role.
--   * `postgres` has rolbypassrls = true AND owns every table below.
--   * A role with BYPASSRLS, and a table owner, both bypass RLS as long as the table
--     uses ENABLE (not FORCE) ROW LEVEL SECURITY.
--   * We therefore use ENABLE only. Do NOT add `FORCE ROW LEVEL SECURITY` here, or the
--     owner/backend connection would start being filtered and the API would break.
--
-- Policies are SELECT-only for the `authenticated` role. All writes go through the
-- service-role / owner backend, so no INSERT/UPDATE/DELETE policies are added.

-- ---------------------------------------------------------------------------
-- Shadow-database compatibility shim.
--
-- Prisma validates each migration against a throwaway "shadow" database that is a
-- vanilla Postgres without Supabase's `auth` schema. The policies below reference
-- `auth.uid()`, so on the shadow DB that schema/function must exist for the SQL to
-- parse. We create them ONLY IF ABSENT: on the real Supabase database both already
-- exist, so this block is a no-op there and never clobbers Supabase's real
-- `auth.uid()` (note: we do NOT use CREATE OR REPLACE for that reason).
-- ---------------------------------------------------------------------------
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
    -- Stub used only by the shadow DB. Mirrors Supabase's signature: it reads the
    -- request JWT's `sub` claim. On the shadow DB there is no JWT, so it returns NULL.
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
-- Enable Row Level Security (default-deny once enabled; no FORCE).
-- ---------------------------------------------------------------------------
ALTER TABLE "profiles"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organisations"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subsidiaries"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "locations"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_subsidiary_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log"              ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- profiles: a user may select only their own row.
-- ---------------------------------------------------------------------------
CREATE POLICY "profiles_select_own"
  ON "profiles"
  FOR SELECT
  TO "authenticated"
  USING ( "id" = (SELECT auth.uid()) );

-- ---------------------------------------------------------------------------
-- organisations: selectable only if it is the current user's organisation.
-- ---------------------------------------------------------------------------
CREATE POLICY "organisations_select_own_org"
  ON "organisations"
  FOR SELECT
  TO "authenticated"
  USING (
    "id" = (
      SELECT p."organisation_id"
      FROM "profiles" p
      WHERE p."id" = (SELECT auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- subsidiaries: selectable if the current user has an explicit
-- user_subsidiary_access row for it, OR the user's role is one of
-- (super_admin, consultant, executive_viewer) AND the subsidiary belongs to
-- the user's organisation. (data_entry is limited to explicit access rows.)
-- ---------------------------------------------------------------------------
CREATE POLICY "subsidiaries_select_scoped"
  ON "subsidiaries"
  FOR SELECT
  TO "authenticated"
  USING (
    EXISTS (
      SELECT 1
      FROM "user_subsidiary_access" usa
      WHERE usa."subsidiary_id" = "subsidiaries"."id"
        AND usa."user_id" = (SELECT auth.uid())
    )
    OR EXISTS (
      SELECT 1
      FROM "profiles" p
      WHERE p."id" = (SELECT auth.uid())
        AND p."role" IN ('super_admin', 'consultant', 'executive_viewer')
        AND p."organisation_id" = "subsidiaries"."organisation_id"
    )
  );

-- ---------------------------------------------------------------------------
-- locations: selectable if their parent subsidiary is selectable
-- (same access/role rule, expressed via EXISTS on the parent subsidiary).
-- ---------------------------------------------------------------------------
CREATE POLICY "locations_select_scoped"
  ON "locations"
  FOR SELECT
  TO "authenticated"
  USING (
    EXISTS (
      SELECT 1
      FROM "subsidiaries" s
      WHERE s."id" = "locations"."subsidiary_id"
        AND (
          EXISTS (
            SELECT 1
            FROM "user_subsidiary_access" usa
            WHERE usa."subsidiary_id" = s."id"
              AND usa."user_id" = (SELECT auth.uid())
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
  );

-- ---------------------------------------------------------------------------
-- user_subsidiary_access: a user may select only their own access rows.
-- ---------------------------------------------------------------------------
CREATE POLICY "user_subsidiary_access_select_own"
  ON "user_subsidiary_access"
  FOR SELECT
  TO "authenticated"
  USING ( "user_id" = (SELECT auth.uid()) );

-- ---------------------------------------------------------------------------
-- audit_log: append-only and super_admin-only for reads. No UPDATE/DELETE
-- policies are ever added here, preserving immutability for non-owner roles.
-- ---------------------------------------------------------------------------
CREATE POLICY "audit_log_select_super_admin"
  ON "audit_log"
  FOR SELECT
  TO "authenticated"
  USING (
    EXISTS (
      SELECT 1
      FROM "profiles" p
      WHERE p."id" = (SELECT auth.uid())
        AND p."role" = 'super_admin'
    )
  );
