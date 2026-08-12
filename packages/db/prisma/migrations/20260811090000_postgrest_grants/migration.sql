-- PostgREST access depends on grants that live in Supabase's own bootstrap, not
-- in this schema. `prisma migrate reset` drops and recreates `public` and takes
-- them with it: after a reset, anon / authenticated / service_role had NO usage
-- on the schema and zero table grants, so every RLS containment probe and the
-- whole E2E teardown failed. It failed silently, because the teardown never
-- checked its response. Declaring the grants here makes the schema
-- self-contained and `pnpm db:reset` reproducible.
--
-- Portability: the Supabase roles do not exist on a plain Postgres, and an
-- unguarded GRANT would abort the deploy there (Phase-2 Azure runs migrations
-- against a managed instance). Sibling migrations shim `auth.uid()` for the same
-- reason.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping PostgREST grants';
    RETURN;
  END IF;

  GRANT USAGE ON SCHEMA "public" TO anon, authenticated, service_role;

  -- NOT `GRANT ALL`. `ALL` includes TRUNCATE, and TRUNCATE is NOT filtered by
  -- row-level security — a role that can read zero rows could still truncate
  -- every table and cascade through the foreign keys. RLS only governs
  -- SELECT/INSERT/UPDATE/DELETE, so those are the only verbs a policy-filtered
  -- client role may hold. (This file's audit_log carve-out below states the same
  -- fact about TRUNCATE; the first cut of this migration contradicted it.)
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public"
    TO anon, authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA "public" TO service_role;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA "public" TO service_role;

  -- Default privileges for service_role ONLY, deliberately.
  --
  -- Granting them to anon/authenticated would make the next table created by a
  -- migration come up readable AND writable by anon before anyone has enabled
  -- RLS on it — turning "the author forgot the rls-for-table skill" from a
  -- fail-closed mistake (table invisible) into a fail-open one (table world
  -- writable), silently. Each new table now grants its own client access next to
  -- its `ENABLE ROW LEVEL SECURITY`, and `scripts/rls-probes.mjs` fails if any
  -- table in this schema has RLS off.
  ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT ALL ON TABLES TO service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT ALL ON SEQUENCES TO service_role;

  -- Carve-out 1: `audit_log` is append-only. The grant above would hand back the
  -- write verbs the WP7 audit migration revoked. TRUNCATE is named because it is
  -- not subject to RLS.
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "audit_log" FROM anon, authenticated;

  -- Carve-out 2: `_prisma_migrations` is the only table here WITHOUT RLS — it is
  -- Prisma's own bookkeeping. Guarded on existence because Prisma does not create
  -- it in the shadow database before replaying migrations, so an unguarded REVOKE
  -- makes `prisma migrate dev` fail with P3006/P1014 — i.e. it would break the
  -- next person to add a table.
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON "_prisma_migrations" FROM anon, authenticated';
  END IF;
END $$;
