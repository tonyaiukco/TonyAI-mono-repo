-- Read-only acceptance queries, run in the isolated staging SQL editor.
-- Save only counts/settings, never credentials or user records.
SELECT count(*) AS unfinished_migrations
FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;
SELECT id, public, file_size_limit, allowed_mime_types
FROM storage.buckets WHERE id IN ('evidence', 'import-sources') ORDER BY id;
-- A fresh staging project must have no storage policies granting browser access.
-- API service-role operations bypass RLS; app guards enforce tenant access.
SELECT count(*) AS storage_object_policies
FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';
SELECT tablename FROM pg_tables t
JOIN pg_class c ON c.relname = t.tablename
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
WHERE t.schemaname = 'public' AND t.tablename <> '_prisma_migrations'
AND NOT c.relrowsecurity;
SELECT count(*) AS demo_auth_users FROM auth.users
WHERE email LIKE '%@tonyai.local';
-- Before controlled onboarding, both must be zero. No whole demo seed was applied.
SELECT count(*) AS auth_users FROM auth.users;
SELECT count(*) AS factor_rows FROM public.emission_factors;
SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
WHERE rolname IN ('postgres', 'anon', 'authenticated', 'service_role');
