-- Self-service registration (OpenSpec `self-service-registration`; owner
-- decisions 2026-11-11): a public, code-gated form creates an organisation and
-- its first `super_admin` through the API, where until now only the operator
-- CLI did on the owner's connection (D18).
--
--  * `profiles.job_title`: the registrant's job title. Nullable, no backfill:
--    an invited or provisioned account has none.
--  * `consents`: one row per consent given (today the registration's KVKK
--    notice), naming the notice version shown. Append-only at runtime.
--  * The runtime role gains a column-level INSERT on `organisations` — the
--    one new reach of this change (design D4).
--
-- No stored row is rewritten.

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN "job_title" TEXT;

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "text_version" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "consents_profile_id_idx" ON "consents"("profile_id");

-- AddForeignKey
-- CASCADE like `invitations`: a consent goes only with its profile, which goes
-- only with its organisation's own deletion (the owner's, D21/D24).
ALTER TABLE "consents" ADD CONSTRAINT "consents_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Each one flat condition, so a dump and restore prints the same text.
ALTER TABLE "consents"
  ADD CONSTRAINT "consents_kind_known" CHECK ("kind" IN ('kvkk_registration')),
  ADD CONSTRAINT "consents_language_supported" CHECK ("language" IN ('en', 'tr')),
  ADD CONSTRAINT "consents_text_version_present" CHECK ("text_version" <> '');

-- ---------------------------------------------------------------------------
-- Row Level Security and client grants
-- ---------------------------------------------------------------------------
--
-- Read and written by the API alone (the runtime role, BYPASSRLS), exactly as
-- `invitations`: RLS on with NO policy, never FORCE, and nothing granted to a
-- client role — not even the service role — so PostgREST serves no row of it.
-- `profiles.job_title` needs nothing here: grants are table-level and RLS is
-- row-level, so whoever already reads a profile row reads its job title.
ALTER TABLE "consents" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping consents client grants';
    RETURN;
  END IF;
  REVOKE ALL ON "consents" FROM anon, authenticated, service_role;
END
$$;

-- ---------------------------------------------------------------------------
-- The runtime role (LP1-03) — `runtime-role.mjs` lists the same
-- ---------------------------------------------------------------------------

-- Registration creates the organisation at request time: a column-level INSERT
-- of exactly what the API writes — its name, country, geography and currency.
-- Never `offboarded_at` (an organisation is born active), and no UPDATE or
-- DELETE: an organisation's facts and its offboarding stay the owner's. Prisma
-- fills `id` and the two timestamps on every create.
GRANT INSERT ("id", "legal_name", "country", "geography_code", "reporting_currency", "created_at", "updated_at")
  ON "organisations" TO "tonyai_runtime";

-- The registrant's job title, written with the profile; never updated at
-- runtime (no UPDATE grant), like the name and the address.
GRANT INSERT ("job_title") ON "profiles" TO "tonyai_runtime";

-- A consent is inserted and read, never changed or removed. Not `accepted_at`:
-- the database's clock stamps it, so not even a bug can backdate a consent.
GRANT SELECT ON "consents" TO "tonyai_runtime";
GRANT INSERT ("id", "profile_id", "kind", "text_version", "language") ON "consents" TO "tonyai_runtime";
