-- Defense-in-depth: Supabase Row Level Security (RLS) for `activity_records`.
--
-- `activity_records` is a CHILD of `subsidiaries`, so it is tenant-scoped by
-- `subsidiary_id`: a row is selectable only if its parent subsidiary is
-- selectable (explicit user_subsidiary_access row, OR a super_admin / consultant
-- / executive_viewer in the same organisation). This mirrors the `locations`
-- policy in 20260630204830_rls_policies.
--
-- PRIMARY tenant enforcement lives in the NestJS guard (apps/api), which scopes
-- every query to `accessibleSubsidiaryIds`. This policy is the SECONDARY layer so
-- a direct PostgREST / anon / authenticated client cannot read cross-tenant data.
--
-- ENABLE (never FORCE): the `postgres` owner/backend role bypasses RLS so the API
-- and seed keep full access; SELECT-only for `authenticated` (all writes stay on
-- the owner/service-role backend, so no INSERT/UPDATE/DELETE policies).

-- ---------------------------------------------------------------------------
-- Shadow-database compatibility shim (see 20260630204830_rls_policies).
-- Prisma validates each migration against a vanilla shadow DB without Supabase's
-- `auth` schema. Create it ONLY IF ABSENT so this is a no-op on real Supabase and
-- never clobbers Supabase's real `auth.uid()` (hence no CREATE OR REPLACE).
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
ALTER TABLE "activity_records" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- activity_records: selectable if their parent subsidiary is selectable
-- (same access/role rule as `locations`, expressed via EXISTS on the parent).
-- ---------------------------------------------------------------------------
CREATE POLICY "activity_records_select_scoped"
  ON "activity_records"
  FOR SELECT
  TO "authenticated"
  USING (
    EXISTS (
      SELECT 1
      FROM "subsidiaries" s
      WHERE s."id" = "activity_records"."subsidiary_id"
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
