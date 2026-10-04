---
name: rls-for-table
description: Add Supabase Row Level Security to a new tenant table as defense-in-depth, via a Prisma migration — ENABLE (never FORCE) RLS, auth.uid()-keyed SELECT-only policies scoped by tenant (grant branch same-organisation), the Prisma shadow-DB auth-schema shim, the least-privileged runtime role's grants, and verification queries. Use when a new table is added to packages/db and needs RLS.
---

# rls-for-table

RLS confines **direct database clients** (PostgREST / anon / authenticated). The API connects as the
least-privileged runtime role `tonyai_runtime` (LP1-03), which **bypasses RLS** — so RLS never filters the
API's queries; the NestJS guard and each service's `accessibleSubsidiaryIds` scoping do. Migrations and the
seed run as the owner (`DIRECT_URL`). Every new table therefore needs THREE things: RLS + policies (client
roles), client-role grants, and the runtime role's grants (step 2c).

## Hard rules
- `ENABLE ROW LEVEL SECURITY` — **never `FORCE`** (it breaks the owner's migrations and seed, and filters nothing useful for the runtime role, whose queries carry no user context).
- App tables: **SELECT-only** policies for the `authenticated` role, keyed on `auth.uid()`. Writes go through
  the API (runtime role) — do **not** add INSERT/UPDATE/DELETE policies for client roles.
- The explicit-grant branch **joins the caller's profile and requires the same organisation** (LP1-03) — never
  a bare `user_subsidiary_access` lookup, even though the composite keys already refuse cross-organisation grants.
- Audit-style tables: SELECT only for `super_admin`; append-only (never any UPDATE/DELETE policy).

## Steps
1. Create an empty migration:
   ```bash
   pnpm --filter @tonyai/db exec prisma migrate dev --create-only --name rls_<table>
   ```
2. Edit `packages/db/prisma/migrations/<ts>_rls_<table>/migration.sql`:

   **(a) Prepend the shadow-DB shim.** Prisma validates migrations against a vanilla DB that lacks Supabase's
   `auth` schema. This shim is a no-op on real Supabase. Do **not** use `CREATE OR REPLACE` (it would clobber
   Supabase's real `auth.uid()`):
   ```sql
   CREATE SCHEMA IF NOT EXISTS "auth";
   DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'auth' AND p.proname = 'uid'
     ) THEN
       CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT NULL::uuid $f$;
     END IF;
   END $$;
   ```

   **(b) Enable RLS and add the tenant-scoped SELECT policy** (example for a child of `subsidiaries`):
   ```sql
   ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;

   CREATE POLICY "<table>_select_scoped" ON "<table>" FOR SELECT TO authenticated
   USING (EXISTS (
     SELECT 1 FROM subsidiaries s
     WHERE s.id = "<table>".subsidiary_id
       AND (
         EXISTS (SELECT 1 FROM user_subsidiary_access a JOIN profiles p ON p.id = a.user_id
                 WHERE a.subsidiary_id = s.id AND a.user_id = (SELECT auth.uid())
                   AND p.organisation_id = s.organisation_id)
         OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
                    AND p.role IN ('super_admin','consultant','executive_viewer')
                    AND p.organisation_id = s.organisation_id)
       )
   ));
   ```
   **(c) Grant the runtime role exactly what the API does with the table** — never `ALL`, never TRUNCATE;
   an append-only table gets `SELECT, INSERT` only; a table the API row-locks (`FOR UPDATE`) needs UPDATE:
   ```sql
   GRANT SELECT, INSERT, UPDATE, DELETE ON "<table>" TO "tonyai_runtime";
   ```
   and add the same list to `RUNTIME_TABLE_PRIVILEGES` in `packages/db/scripts/runtime-role.mjs`. Until both
   agree, `test:int` (`runtime-role.int.spec.ts`), `pnpm rls:probe` and `runtime-role.mjs check` fail — a table
   with no decision fails closed instead of coming up unreachable or over-granted.
3. Apply:
   ```bash
   pnpm --filter @tonyai/db exec prisma migrate dev
   ```

## Verify (paste the output)
```sql
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = '<table>';  -- expect t, f
SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = '<table>';
```
Then prove containment via PostgREST as the seeded `data_entry` user (anon key + Bearer token): a cross-tenant
row must return `[]`, while the API (runtime role) still sees all rows. Check the runtime grants:
```bash
set -a; source packages/db/.env; set +a; node packages/db/scripts/runtime-role.mjs check
```
and add the table to `SCOPED` in `apps/api/test/int/tenant-invariants.int.spec.ts` (RLS with a planted
cross-organisation grant) and, if it has routes, to `apps/api/test/int/tenant-isolation.int.spec.ts`.

## Columns are not tables

A new **table** comes up invisible to client roles until its migration grants
them: default privileges are granted to `service_role` only. A new **column**
needs nothing — grants in this database are table-level (`pg_attribute.attacl`
is null on every column in `public`, and there is no such thing as a default
privilege for a future column), and RLS is row-level, so an existing policy
governs a new column identically the instant `ALTER TABLE` commits.

The consequence worth remembering: **you cannot add a private column.** Anything
added to a tenant table is readable by every role that can already read the row.
Verified against the live database when WP21 added `anomaly_baseline_*` to
`activity_records` — a `data_entry` JWT read both new columns with no grant in
the migration, and `anon` read none.
