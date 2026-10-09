-- Open questions, LP3-03 PR B (14) — no function in `public` is born
-- executable by anyone but its owner.
--
-- PostgreSQL grants EXECUTE on every new function to PUBLIC, and Supabase's
-- default privileges on `public` add anon, authenticated and the service role
-- for every function `postgres` creates there. LP3-03 took both back from its
-- own fifteen functions by name; a function a later migration adds (LP4-01's
-- delete guard) would be born with them again — measured on a CI-shaped
-- database: `{=X, anon=X, authenticated=X, service_role=X}`. No function in
-- `public` is meant for a client: the policies call only `auth.uid()`, nothing
-- else (a default, a CHECK, a view, an index) depends on one, the API calls
-- none, and a trigger fires without its function's EXECUTE — PostgreSQL checks
-- that at CREATE TRIGGER, not when the trigger fires.
-- (`runtime-role.mjs check`, `checkFunctionExecutors`, holds every function in
-- `public` and this role's default to that.)

-- 1. The built-in default, for every function this role creates from here on.
--    Global: a per-schema default only adds to the global one, so it cannot
--    take PUBLIC's EXECUTE back. It reaches this role's functions in any
--    schema; the migrations create functions in `public` alone. Supabase's
--    `supabase_admin` keeps its own defaults — the platform's, out of a
--    migration's reach (`check` names them).
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 2. The one function in `public` still holding the built-in grant: LP1-03's
--    access-removal trigger function (SECURITY INVOKER, so a client gained
--    nothing by it; taken back so that the rule above has no exception).
REVOKE ALL ON FUNCTION "public"."organisations_remove_access_before_delete"() FROM PUBLIC;

-- 3. Supabase's default privileges on `public`, and what they gave that
--    function. A local `pnpm db:reset` recreates the schema without them; CI,
--    staging and production keep them — hence all three roles.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping their function defaults';
    RETURN;
  END IF;
  ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION "public"."organisations_remove_access_before_delete"() FROM anon, authenticated, service_role;
END
$$;
