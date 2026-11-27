-- inc28-fuel-bulk D5, revised (owner decision 2026-11-27): the fuel dedupe
-- digest is keyed. A plain sha256 of a Shell row's card number, time, litres
-- and station could be reversed to the card number by anyone who reads the
-- column; C19 keeps no card number, so the digest is pseudonymous data
-- (KVKK/GDPR). From here on `fuel_rows.dedupe_digest` is
-- HMAC-SHA256(organisation key, sha256(source | key)), with one random 32-byte
-- key per organisation in this table. The API creates an organisation's key
-- on its first fuel upload and reads it on every one; no client role holds
-- any privilege on it.

-- ---------------------------------------------------------------------------
-- 1. No row keyed the old way may remain
-- ---------------------------------------------------------------------------
-- A stored plain digest cannot be re-keyed (the card number is not kept), and
-- a mix of plain and keyed digests would miss the duplicates between them.
-- The fuel upload screen ships with this change, so a database holding fuel
-- rows has them only from the API alone; this stops rather than guess.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "fuel_rows") THEN
    RAISE EXCEPTION 'fuel_rows holds rows whose dedupe digest is the plain sha256 (inc28-fuel-bulk D5, revised); they cannot be re-keyed. Remove them (and their batches, accounts and imports) before applying this migration.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. The table
-- ---------------------------------------------------------------------------
CREATE TABLE "fuel_dedupe_keys" (
    "organisation_id" UUID NOT NULL,
    "secret" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fuel_dedupe_keys_pkey" PRIMARY KEY ("organisation_id")
);

-- The key goes with its organisation, and with nothing else.
ALTER TABLE "fuel_dedupe_keys" ADD CONSTRAINT "fuel_dedupe_keys_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "fuel_dedupe_keys" ADD CONSTRAINT "fuel_dedupe_keys_secret_check" CHECK (octet_length("secret") = 32);

-- ---------------------------------------------------------------------------
-- 3. RLS and client grants — none
-- ---------------------------------------------------------------------------
-- Read and written by the API (the runtime role, BYPASSRLS) alone: RLS on
-- with NO policy, never FORCE, and nothing granted to a client role — not
-- even the service role, which nothing here needs — so PostgREST serves no
-- row of it (`rls:probe` measures each role's refusal).
ALTER TABLE "fuel_dedupe_keys" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase client roles absent (shadow database): skipping fuel_dedupe_keys client grants';
    RETURN;
  END IF;
  REVOKE ALL ON "fuel_dedupe_keys" FROM anon, authenticated, service_role;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Runtime grants (runtime-role.mjs RUNTIME_TABLE_PRIVILEGES)
-- ---------------------------------------------------------------------------
-- Created once and read; never updated or deleted — a changed key would stop
-- every stored digest from matching a re-upload of its row.
GRANT SELECT, INSERT ON "fuel_dedupe_keys" TO "tonyai_runtime";
