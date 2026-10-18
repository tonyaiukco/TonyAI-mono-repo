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

**Learned on LP3-04 PR B (the inventory boundary):**
- **A table the seed leaves empty** cannot join `rls:probe`'s `TENANT_TABLES` loop (it asserts the seeded
  entry user sees > 0). Plant its rows in the probe as the owner (`ownerDb()`), found again by a sentinel,
  count each role through PostgREST, and remove them in the `finally` — before any parent they keep
  (`probeBoundaries`). Never seed demo rows that could read as authoritative.
- **One trigger function on several tables:** a condition naming a column only some tables have fails to
  plan on the others (42703) even behind `TG_TABLE_NAME = …  AND`. Nest it: `IF TG_TABLE_NAME = … THEN IF …`.
- **A key from a parent the organisation's deletion also reaches:** `NO ACTION` is checked when its event
  runs, and the organisation's cascades run in trigger order — a sibling cascade queued later can leave
  the check failing (LP1-03 measured it for `user_subsidiary_access`). Prefer `CASCADE` and let a guard
  refuse the cascades it must (`inventory_boundary_rows_frozen`: refused while the parent row is gone and
  the version stands; admitted once the version itself is).

**Learned on LP3-04 PR C (the retained report datasets):**
- **A table only the API reads** (`report_datasets`, `invitations`, `storage_intents`): RLS on with NO client
  policy, and `REVOKE ALL … FROM anon, authenticated, service_role` inside the roles-exist `DO` block — the
  service role has BYPASSRLS and gets every new table by default privilege, so it must be revoked by name.
  Add a `tonyai_runtime` policy (`FOR ALL … USING (true)`) so the table keeps working should BYPASSRLS go.
- **Prove "no client access" by privilege, not by "0 rows":** `rls:probe` reads and writes as anon, a user and
  the service role and expects 42501. Do not plant rows in an append-only, guarded table — nothing could
  remove them. In an int spec, `SET LOCAL ROLE x` first proves the role was taken (`SELECT current_user`):
  a refused `SET ROLE` is a 42501 too, and would pass for the refusal you meant.
- **Every function in `public` pins `SET search_path = pg_catalog, pg_temp`, never `''` — definer or
  invoker:** with `''` PostgreSQL still searches `pg_temp` FIRST for type and relation names, so any login
  (TEMP is PUBLIC's) can `CREATE DOMAIN pg_temp.jsonb … CHECK (pg_temp.f(VALUE))` and have `f` run as
  whoever the function runs as. A definer runs as its owner — and so does an invoker it calls, or a trigger
  an owner-run statement or an FK cascade fires (LP3-04 PR C: the factor event recorders' invoker SQL helper
  ran the loader's domain as postgres). `runtime-role.mjs` (`checkFunctionSearchPaths`) holds every function
  in `public` to the path. Probe from a FRESH session as the real login: PL/pgSQL resolves types once per
  session, at the first call. **Outside `public` the platform's definers are not ours to pin**, so our logins
  must not reach them: grant no USAGE on a Supabase schema (`storage`, `auth`, `graphql`, …) — read what you
  need through a pinned definer in `public` instead, as `storage_catalogue_page`/`_has` read Storage's
  catalogue — and `checkReachableDefiners` fails on any SECURITY DEFINER the runtime or loader login can call,
  fire by a write, or fire by DDL (an event trigger) that does not pin `pg_temp` last. Grant roles to a login by
  its name in probes (Open questions, "Supabase's own definers and the runtime and loader logins" (1)).
- **Fingerprinted JSON goes in a `text` column, not `jsonb`:** Prisma rounds a double to 16 significant
  digits on a jsonb write (and jsonb reorders keys), so a hash recomputed from the stored value would not
  match. Keep small, guard-checked jsonb copies (a `context`) for SQL filters only.

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
