-- Defense-in-depth: Supabase Row Level Security (RLS) for `emission_factors`.
--
-- IMPORTANT: emission factors are REFERENCE DATA, not tenant-scoped. Every
-- authenticated user (regardless of organisation / subsidiary access) may read
-- factors, because the calculation engine needs them for any geography/year.
-- The SELECT policy therefore has NO tenant predicate — it simply gates reads on
-- being authenticated. Writes stay on the owner/service-role backend (seed), so
-- no INSERT/UPDATE/DELETE policies are added.
--
-- As with the other tables: ENABLE (never FORCE) — the `postgres` owner/backend
-- role bypasses RLS so the API and seed keep full access; these policies only
-- constrain direct PostgREST / anon / authenticated clients.

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
ALTER TABLE "emission_factors" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- emission_factors: reference data — any authenticated user may read all rows.
-- No tenant/organisation predicate by design. SELECT-only; writes stay on the
-- owner/service-role backend.
-- ---------------------------------------------------------------------------
CREATE POLICY "emission_factors_select_authenticated"
  ON "emission_factors"
  FOR SELECT
  TO "authenticated"
  USING ( true );
