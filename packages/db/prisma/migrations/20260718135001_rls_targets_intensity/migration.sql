-- Defense-in-depth: Supabase Row Level Security (RLS) for `targets` and
-- `subsidiary_denominators` (WP5, Targets & intensity).
--
-- Both are CHILDREN of `subsidiaries`, so they are tenant-scoped by
-- `subsidiary_id`: a row is selectable only if its parent subsidiary is
-- selectable (explicit user_subsidiary_access row, OR a super_admin /
-- consultant / executive_viewer in the same organisation). Mirrors the
-- `period_locks` policy in 20260715192924_rls_period_locks.
--
-- PRIMARY tenant enforcement lives in the NestJS guard (apps/api). This policy
-- is the SECONDARY layer so a direct PostgREST / anon / authenticated client
-- cannot read cross-tenant targets or denominators.
--
-- ENABLE (never FORCE): the `postgres` owner/backend role bypasses RLS so the
-- API and seed keep full access; SELECT-only for `authenticated` (all writes
-- stay on the owner/service-role backend, so no INSERT/UPDATE/DELETE policies).

-- ---------------------------------------------------------------------------
-- Shadow-database compatibility shim (see 20260630204830_rls_policies).
-- Prisma validates each migration against a vanilla shadow DB without
-- Supabase's `auth` schema. Create it ONLY IF ABSENT so this is a no-op on real
-- Supabase and never clobbers Supabase's real `auth.uid()`.
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
ALTER TABLE "targets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subsidiary_denominators" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- targets: selectable if their parent subsidiary is selectable.
-- ---------------------------------------------------------------------------
CREATE POLICY "targets_select_scoped"
  ON "targets"
  FOR SELECT
  TO "authenticated"
  USING (
    EXISTS (
      SELECT 1
      FROM "subsidiaries" s
      WHERE s."id" = "targets"."subsidiary_id"
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
-- subsidiary_denominators: selectable if their parent subsidiary is selectable.
-- ---------------------------------------------------------------------------
CREATE POLICY "subsidiary_denominators_select_scoped"
  ON "subsidiary_denominators"
  FOR SELECT
  TO "authenticated"
  USING (
    EXISTS (
      SELECT 1
      FROM "subsidiaries" s
      WHERE s."id" = "subsidiary_denominators"."subsidiary_id"
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
