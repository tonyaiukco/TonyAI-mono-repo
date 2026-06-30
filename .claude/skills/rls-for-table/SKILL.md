---
name: rls-for-table
description: Add Supabase Row Level Security to a new tenant table as defense-in-depth, via a Prisma migration — ENABLE (never FORCE) RLS, auth.uid()-keyed SELECT-only policies scoped by tenant, the Prisma shadow-DB auth-schema shim, and verification queries. Use when a new table is added to packages/db and needs RLS.
---

# rls-for-table

RLS is the **second** line of defence (the NestJS guard is primary). The backend connects as the Postgres
owner role, which **bypasses RLS**, so these policies only constrain direct PostgREST / anon / authenticated
clients — never break that model.

## Hard rules
- `ENABLE ROW LEVEL SECURITY` — **never `FORCE`** (FORCE also blocks the owner/Prisma path and breaks the API + seed).
- App tables: **SELECT-only** policies for the `authenticated` role, keyed on `auth.uid()`. Writes stay on the
  owner/service-role backend — do **not** add INSERT/UPDATE/DELETE policies.
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
         EXISTS (SELECT 1 FROM user_subsidiary_access a WHERE a.subsidiary_id = s.id AND a.user_id = auth.uid())
         OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid()
                    AND p.role IN ('super_admin','consultant','executive_viewer')
                    AND p.organisation_id = s.organisation_id)
       )
   ));
   ```
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
row must return `[]`, while the owner/Prisma path still sees all rows (e.g. re-run `pnpm db:seed`).
