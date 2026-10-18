-- The runtime role leaves Supabase's `storage` schema (the open question
-- "Supabase storage definers reachable by the runtime role", `security-rls`'s
-- round-2 review of LP3-04 PR C; README "Security model").
--
-- LP1-03 granted `tonyai_runtime` USAGE on `storage` and SELECT on
-- `storage.objects`, for `storage:reconcile`'s two catalogue reads and the
-- sweeper's visibility check. USAGE also reached Supabase's own SECURITY
-- DEFINER helpers there (`add_prefixes`, `delete_prefix`, `lock_top_prefixes`,
-- `delete_leaf_prefixes`), which PUBLIC may EXECUTE and which pin no
-- search_path: a type name in them resolves through the CALLER's path, where
-- pg_temp comes first — so a runtime login's temporary domain over `text` ran
-- its own CHECK function as `supabase_storage_admin`, which may update
-- `storage.buckets` and delete `storage.objects` (reproduced from a fresh
-- runtime login). The helpers also rewrite Storage's prefix index as that
-- role when called plainly. The owner can neither revoke PUBLIC's EXECUTE on
-- them nor pin them (Storage owns and re-creates them), so the runtime role
-- gives up the schema instead:
--
--  * USAGE on `storage` and SELECT on `storage.objects` are revoked.
--  * Storage's catalogue is read through two functions in `public`, SECURITY
--    DEFINER as the owner of the schema's tables (BYPASSRLS, as the runtime
--    role is), pinned to `pg_catalog, pg_temp` like every function there, and
--    executable by the runtime role alone. They return a key, its creation
--    time and its size — nothing else of the catalogue — and nothing for a
--    NULL argument (STRICT: no unbounded page).
--
-- Only where Supabase's storage schema exists: without it (CI's plain
-- PostgreSQL) LP1-03 granted nothing, and there is nothing to read.
-- `runtime-role.mjs` holds the same: USAGE on `storage` for either of our
-- logins is a problem, and every SECURITY DEFINER function they can set
-- running must pin its search_path with pg_temp last.
DO $migration$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE 'storage.objects absent — skipping the runtime storage readers';
    RETURN;
  END IF;

  REVOKE SELECT ON "storage"."objects" FROM "tonyai_runtime";
  REVOKE USAGE ON SCHEMA "storage" FROM "tonyai_runtime";

  -- One keyset page of a bucket's keys, in the order of the column's own
  -- collation (the database default, which the cursor compares in too;
  -- `p_after` is the last key of the previous page): what `storage:reconcile`
  -- scans for orphans. Bounded by `p_limit`.
  CREATE FUNCTION "public"."storage_catalogue_page"(
    p_bucket text, p_prefix text, p_after text, p_created_before timestamptz, p_limit integer
  )
  RETURNS TABLE (name text, created_at timestamptz, size_bytes bigint)
  LANGUAGE sql STABLE STRICT SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    SELECT o.name, o.created_at, (o.metadata ->> 'size')::bigint
      FROM storage.objects o
     WHERE o.bucket_id = p_bucket
       AND o.name > p_after
       AND starts_with(o.name, p_prefix)
       AND o.created_at < p_created_before
     ORDER BY o.name
     LIMIT p_limit
  $fn$;

  -- Whether the catalogue names the object: what `storage:reconcile` asks of
  -- each row it checks for missing bytes.
  CREATE FUNCTION "public"."storage_catalogue_has"(p_bucket text, p_name text)
  RETURNS boolean
  LANGUAGE sql STABLE STRICT SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $fn$
    SELECT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = p_bucket AND o.name = p_name)
  $fn$;

  REVOKE ALL ON FUNCTION "public"."storage_catalogue_page"(text, text, text, timestamptz, integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION "public"."storage_catalogue_has"(text, text) FROM PUBLIC;
  -- Supabase's default privileges grant every new function to its client
  -- roles; OQ 14 took the owner's default back, and this keeps it so here.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION "public"."storage_catalogue_page"(text, text, text, timestamptz, integer)
      FROM anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION "public"."storage_catalogue_has"(text, text) FROM anon, authenticated, service_role;
  END IF;
  GRANT EXECUTE ON FUNCTION "public"."storage_catalogue_page"(text, text, text, timestamptz, integer) TO "tonyai_runtime";
  GRANT EXECUTE ON FUNCTION "public"."storage_catalogue_has"(text, text) TO "tonyai_runtime";
END
$migration$;
