-- Row Level Security for `import_batches` — defense in depth.
--
-- The API (primary gate) reads through Prisma as the owner role, which
-- bypasses RLS; this constrains direct PostgREST / Supabase-client access only.
-- ENABLE, never FORCE (FORCE would block the owner path the API and seed use).
-- SELECT-only for `authenticated`: every write goes through the API.
--
-- Who may read a batch:
--   * super_admin, consultant, executive_viewer — every batch of their own
--     organisation, as they read its records;
--   * data_entry — ONLY a batch they uploaded, and only while they can still
--     reach every subsidiary the file names (`subsidiary_ids`). The batch's
--     subject is the source file, which holds every row, refused ones
--     included: a colleague with access to one of its three subsidiaries would
--     otherwise read the other two's data. A null or empty `subsidiary_ids`
--     matches no data_entry reader (fail-closed; the API always writes it).
-- The API applies the same rule in `ImportBatchesService`.

-- Shadow-DB shim: Prisma validates migrations on a vanilla Postgres without
-- Supabase's `auth` schema. A no-op on real Supabase. Not CREATE OR REPLACE,
-- which would clobber the real `auth.uid()`.
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

ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "import_batches_select_scoped"
  ON "import_batches"
  FOR SELECT
  TO "authenticated"
  USING (
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
        FROM unnest("import_batches"."subsidiary_ids") AS sid
        WHERE NOT EXISTS (
          SELECT 1
          FROM "user_subsidiary_access" usa
          WHERE usa."user_id" = (SELECT auth.uid())
            AND usa."subsidiary_id" = sid
        )
      )
    )
  );

-- A new table comes up invisible to client roles: default privileges are
-- granted to service_role only (see 20260811090000_postgrest_grants). The same
-- verbs as every other RLS-filtered table — NOT TRUNCATE, which RLS does not
-- filter. Guarded so the shadow database, which has no Supabase roles, skips it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping import_batches grants';
    RETURN;
  END IF;
  GRANT SELECT, INSERT, UPDATE, DELETE ON "import_batches" TO anon, authenticated;
  GRANT ALL ON "import_batches" TO service_role;
END
$$;
