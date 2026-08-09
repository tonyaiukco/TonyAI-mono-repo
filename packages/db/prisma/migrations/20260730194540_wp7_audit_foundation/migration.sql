-- WP7 audit foundation.
--
-- NOTE: Prisma's generated diff for this migration contained a spurious
--   DROP INDEX "activity_records_reporting_entity_period_category_key";
-- It has been DELETED. That index is the raw `NULLS NOT DISTINCT` uniqueness
-- guard from the record_location_linkage migration, which Prisma cannot express
-- in schema.prisma and therefore re-proposes for removal on every generation
-- (see the guard rule in CLAUDE.md). Dropping it would silently allow duplicate
-- subsidiary-level activity records.

-- Shadow-DB shim: Prisma validates against a vanilla DB with no Supabase `auth`
-- schema. No-op on real Supabase; never CREATE OR REPLACE (that would clobber
-- Supabase's real auth.uid()).
CREATE SCHEMA IF NOT EXISTS "auth";
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT NULL::uuid $f$;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- Review outcome fields: a reviewer's words no longer overwrite the author's
-- variance justification.
-- --------------------------------------------------------------------------
ALTER TABLE "activity_records" ADD COLUMN     "review_note" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "reviewed_by" UUID;

-- --------------------------------------------------------------------------
-- Audit rows gain the actor's role and a tenant scope.
-- --------------------------------------------------------------------------
ALTER TABLE "audit_log" ADD COLUMN     "organisation_id" UUID,
ADD COLUMN     "role" TEXT;

CREATE INDEX "audit_log_organisation_id_created_at_idx" ON "audit_log"("organisation_id", "created_at");

-- Backfill the tenant scope from the actor's profile as it stands TODAY.
-- Assumption, stated plainly: no user has changed organisation. That holds now
-- (a single organisation exists and there is no org-change flow), and it is why
-- this is acceptable — but a future org-change feature must NOT rewrite these
-- rows, or a user's old actions would retroactively move to their new tenant.
-- `role` is deliberately NOT backfilled: roles change routinely, and stamping
-- today's role onto a year-old action would be a fabricated audit record.
-- Historic rows keep role = NULL.
UPDATE "audit_log" a
   SET "organisation_id" = p."organisation_id"
  FROM "profiles" p
 WHERE p."id" = a."user_id"
   AND a."organisation_id" IS NULL;

-- --------------------------------------------------------------------------
-- Tighten audit RLS: was role-gated only, so a super_admin of organisation A
-- could read organisation B's audit rows through PostgREST. Now scoped to the
-- reader's own organisation as well. Still SELECT-only — the table stays
-- append-only, with no UPDATE/DELETE policy, ever.
-- Rows whose organisation could not be backfilled (no matching profile) are
-- invisible to every client: fail-closed, by design.
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS "audit_log_select_super_admin" ON "audit_log";

CREATE POLICY "audit_log_select_scoped"
  ON "audit_log"
  FOR SELECT
  TO "authenticated"
  USING (
    EXISTS (
      SELECT 1
      FROM "profiles" p
      WHERE p."id" = (SELECT auth.uid())
        AND p."role" = 'super_admin'
        AND p."organisation_id" IS NOT NULL
        AND p."organisation_id" = "audit_log"."organisation_id"
    )
  );

-- --------------------------------------------------------------------------
-- Defense-in-depth for immutability. RLS already denies INSERT/UPDATE/DELETE to
-- these roles (no such policy exists), but **TRUNCATE is not subject to RLS at
-- all** — a table-level privilege is the only thing standing in its way. For
-- the one table whose entire value is being append-only, the privilege should
-- not be granted in the first place. SELECT stays (the policy governs it).
-- Prisma/the API connect as the owner and are unaffected.
-- --------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "audit_log" FROM "anon", "authenticated";
