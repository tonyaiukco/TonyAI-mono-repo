-- LP1-02 (F14): recoverable Storage effects, content identity, one object per row.
--
-- `storage_intents` names every object an API path is about to write or has
-- committed to removing, so a failure between the database and Storage leaves
-- a row here for the API's sweeper to retry rather than an object nothing
-- knows about, or a row pointing at bytes that are gone. See the model comment
-- in schema.prisma for the protocol.

-- CreateEnum
CREATE TYPE "storage_intent_kind" AS ENUM ('upload', 'delete');

-- AlterTable: content identity. Null on files uploaded before this migration —
-- unverified, never back-filled with a guess.
ALTER TABLE "evidence" ADD COLUMN     "sha256" CHAR(64);

-- CreateTable
CREATE TABLE "storage_intents" (
    "id" UUID NOT NULL,
    "kind" "storage_intent_kind" NOT NULL,
    "bucket" TEXT NOT NULL,
    "object_path" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "organisation_id" UUID,
    "subsidiary_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "storage_intents_kind_next_attempt_at_idx" ON "storage_intents"("kind", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "storage_intents_bucket_object_path_key" ON "storage_intents"("bucket", "object_path");

-- CreateIndex: one object backs one row, so removing an object can never take
-- bytes another row still points at. Every key the API writes carries a fresh
-- uuid, so existing data has no duplicates; if a database did, this fails
-- loudly rather than guessing which row owns the object.
CREATE UNIQUE INDEX "evidence_storage_path_key" ON "evidence"("storage_path");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_storage_path_key" ON "import_batches"("storage_path");

-- Operational state, not tenant data: RLS on with NO policy, and nothing
-- granted to client roles, so PostgREST sees no row of it. Only the API (the
-- owner role) and service_role touch it. Never FORCE (it would block the
-- owner path). Guarded so the shadow database, which has no Supabase roles,
-- skips the grant.
ALTER TABLE "storage_intents" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping storage_intents grants';
    RETURN;
  END IF;
  REVOKE ALL ON "storage_intents" FROM anon, authenticated;
  GRANT ALL ON "storage_intents" TO service_role;
END
$$;
