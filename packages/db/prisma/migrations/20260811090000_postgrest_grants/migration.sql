-- PostgREST access depends on grants that live in Supabase's own bootstrap, not
-- in this schema. `prisma migrate reset` drops and recreates `public` and takes
-- them with it: after a reset, anon / authenticated / service_role had NO usage
-- on the schema and zero table grants, so every RLS containment probe and the
-- whole E2E teardown failed. It failed silently, because the teardown never
-- checked its response — which is how a broken second layer could have gone
-- unnoticed. Declaring the grants here makes the schema self-contained and
-- `pnpm db:reset` reproducible.
--
-- This does NOT widen access: every domain table has RLS enabled with a policy
-- (verified before writing this), so a grant is only permission to be filtered.
-- The two carve-outs below are the parts that would otherwise be widened.

GRANT USAGE ON SCHEMA "public" TO anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA "public" TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA "public" TO anon, authenticated, service_role;

-- Tables added by later migrations inherit the same treatment, so this file does
-- not have to be revisited every time the schema grows.
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

-- Carve-out 1: `audit_log` is append-only. The blanket grant above would hand
-- the write verbs straight back, undoing the control the WP7 audit migration
-- added. TRUNCATE is listed because it is not subject to RLS.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "audit_log" FROM anon, authenticated;

-- Carve-out 2: `_prisma_migrations` is the only table in this schema WITHOUT
-- RLS — it is Prisma's own bookkeeping. A blanket grant would publish migration
-- history through PostgREST and let a client corrupt migration state. The
-- service role keeps it: that key is server-side only.
REVOKE ALL ON "_prisma_migrations" FROM anon, authenticated;
