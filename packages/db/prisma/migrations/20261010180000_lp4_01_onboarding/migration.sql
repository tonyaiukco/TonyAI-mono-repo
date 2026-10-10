-- LP4-01 PR B — onboarding and the user lifecycle (Decisions 2026-10-10
-- (second), K3–K6; sub-decisions S1–S12, same day).
--
--  * `profiles.disabled_at` (D19): the API's guard refuses a disabled account
--    on its next request; Supabase Auth bans it too, the database first.
--    `auth_sync_pending_since` records that Auth has yet to catch up (K4), and
--    `recovery_sent_at` is the public reset endpoint's per-address cooldown.
--  * `organisations.offboarded_at` (K6, D21): set by the operator CLI's
--    `offboard`, which also disables every member; the start of D21's 90-day
--    clock. Nothing here deletes anything.
--  * `invitations`: one row per invited profile — the durable state of the
--    steps that run outside the database (the Auth user, the email, the
--    acceptance), so a half-done invitation is visible and retried, never lost.
--
-- Additive only: four nullable columns (no rewrite), one new table, grants.
-- The migration still holds ACCESS EXCLUSIVE on `profiles` and
-- `organisations` until it commits — the guard reads `profiles` on every
-- request — so each lock wait gives up after 5 s rather than stall every
-- request behind a long transaction. Then Prisma records the migration as
-- failed and rolls it back whole: resolve it with
-- `prisma migrate resolve --rolled-back 20261010180000_lp4_01_onboarding`
-- before deploying again, in a quieter window.
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('pending', 'sent', 'accepted', 'revoked');

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "auth_sync_pending_since" TIMESTAMPTZ(6),
ADD COLUMN     "disabled_at" TIMESTAMPTZ(6),
ADD COLUMN     "recovery_sent_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "offboarded_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "invitations" (
    "profile_id" UUID NOT NULL,
    "language" TEXT NOT NULL,
    "invited_by" UUID,
    "status" "InvitationStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_step" TEXT,
    "last_error_code" TEXT,
    "last_attempt_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT transaction_timestamp(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("profile_id")
);

-- AddForeignKey. The profile's own key, not (id, organisation_id): an
-- invitation names no organisation of its own (it is the profile's), so there
-- is nothing to keep in step — and a composite key here would refuse an
-- organisation's deletion the way LP1-03 measured for `user_subsidiary_access`.
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What the state machine may hold, whoever writes it. Prisma does not model
-- CHECK constraints, so it reports no drift for these.
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_language_supported" CHECK ("language" IN ('en', 'tr')),
  ADD CONSTRAINT "invitations_error_step_known" CHECK ("last_error_step" IN ('auth', 'email')),
  ADD CONSTRAINT "invitations_error_paired" CHECK (("last_error_step" IS NULL) = ("last_error_code" IS NULL)),
  ADD CONSTRAINT "invitations_attempts_non_negative" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "invitations_sent_has_time" CHECK ("status" <> 'sent' OR "sent_at" IS NOT NULL),
  ADD CONSTRAINT "invitations_accepted_has_time" CHECK (("status" = 'accepted') = ("accepted_at" IS NOT NULL)),
  ADD CONSTRAINT "invitations_revoked_has_time" CHECK (("status" = 'revoked') = ("revoked_at" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Row Level Security and client grants
-- ---------------------------------------------------------------------------
--
-- Operational state read and written by the API alone (the runtime role,
-- BYPASSRLS): RLS on with NO policy, never FORCE, and nothing granted to a
-- client role — not even the service role, which nothing here needs — so
-- PostgREST serves no row of it. The new `profiles` columns need nothing:
-- `profiles_select_own` already lets a user read their own row, these three
-- included, and no client role writes `profiles`.
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles absent — skipping invitations client grants';
    RETURN;
  END IF;
  REVOKE ALL ON "invitations" FROM anon, authenticated, service_role;
END
$$;

-- ---------------------------------------------------------------------------
-- The runtime role (LP1-03) — `runtime-role.mjs` lists the same
-- ---------------------------------------------------------------------------

-- An invitation creates its profile at request time (S1, S2): a column-level
-- INSERT of exactly what the API writes. Never `disabled_at`, the Auth or
-- reset bookkeeping, or `theme` (their defaults), so a new account is born
-- enabled and in no state the lifecycle has not put it in. Which organisation
-- and role is the API's to enforce (`AccessAdminService`, the actor's own
-- organisation); the profile can never move afterwards (D17: no UPDATE on
-- `organisation_id`). `created_at` and `updated_at` are Prisma's to fill.
GRANT INSERT ("id", "email", "full_name", "role", "language", "organisation_id", "created_at", "updated_at")
  ON "profiles" TO "tonyai_runtime";

-- Disabling and enabling (D19), the Auth catch-up flag (K4), the reset
-- cooldown — beside `role`, `language` and `updated_at` (LP1-03, LP3-01).
GRANT UPDATE ("disabled_at", "auth_sync_pending_since", "recovery_sent_at") ON "profiles" TO "tonyai_runtime";

-- Invitations: created with the profile, moved along by delivery and
-- acceptance. Never deleted at runtime (a withdrawn invitation is `revoked`,
-- and its profile disabled), and never re-pointed: not `profile_id`,
-- `invited_by`, `language` or `created_at`.
GRANT SELECT, INSERT ON "invitations" TO "tonyai_runtime";
GRANT UPDATE (
  "status", "attempts", "last_error_step", "last_error_code", "last_attempt_at",
  "sent_at", "accepted_at", "revoked_at", "updated_at"
) ON "invitations" TO "tonyai_runtime";
