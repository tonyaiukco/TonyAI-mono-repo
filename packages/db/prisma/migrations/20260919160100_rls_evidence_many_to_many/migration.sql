-- Row Level Security for evidence after it became many-to-many — defense in
-- depth.
--
-- The API (primary gate) reads through Prisma as the owner role, which
-- bypasses RLS; this constrains direct PostgREST / Supabase-client access only.
-- ENABLE, never FORCE (FORCE would block the owner path the API and seed use).
-- SELECT-only for `authenticated`: every write goes through the API.
--
-- Both tables now carry the subsidiary themselves, so both use the plain
-- subsidiary predicate every record-level table uses: a data_entry user reads
-- what belongs to a subsidiary they are granted; super_admin, consultant and
-- executive_viewer read their own organisation's. The link's subsidiary is the
-- record's AND the file's (composite foreign keys), so a reader of a link can
-- read both ends of it and nothing else.

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

-- `evidence` keeps RLS enabled from 20260706193227_rls_evidence; only its
-- policy changes (the previous migration dropped the one that read
-- `activity_record_id`).
ALTER TABLE "evidence" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "evidence_select_scoped"
  ON "evidence"
  FOR SELECT
  TO "authenticated"
  USING (
    EXISTS (
      SELECT 1
      FROM "subsidiaries" s
      WHERE s."id" = "evidence"."subsidiary_id"
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

ALTER TABLE "activity_record_evidence" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "activity_record_evidence_select_scoped"
  ON "activity_record_evidence"
  FOR SELECT
  TO "authenticated"
  USING (
    EXISTS (
      SELECT 1
      FROM "subsidiaries" s
      WHERE s."id" = "activity_record_evidence"."subsidiary_id"
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

-- A new table comes up invisible to client roles: default privileges are
-- granted to service_role only (see 20260811090000_postgrest_grants). The same
-- verbs as every other RLS-filtered table — NOT TRUNCATE, which RLS does not
-- filter. Guarded so the shadow database, which has no Supabase roles, skips it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping activity_record_evidence grants';
    RETURN;
  END IF;
  GRANT SELECT, INSERT, UPDATE, DELETE ON "activity_record_evidence" TO anon, authenticated;
  GRANT ALL ON "activity_record_evidence" TO service_role;
END
$$;
