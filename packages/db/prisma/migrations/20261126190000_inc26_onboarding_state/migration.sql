-- Expand-only: one nullable column on `organisations`, the stamp of every
-- organisation that exists when it ships, one system audit row each, and one
-- column grant. No table, index or policy is dropped or changed, nothing is
-- renamed, and no company, grant, record or boundary row is touched. The
-- previous API image keeps working on this schema: it never reads the column,
-- and an organisation it registers is born unfinished (the runtime role cannot
-- insert the column), which only the new image's wizard reads. No
-- forward-only mark.
--
-- WP8 (`inc26-central-reporter-onboarding`) — INC-2.6 Rev.3 §7.1: a new
-- organisation's masterkey is held on the setup wizard until it is finished
-- (design D8). Organisations that exist when this ships are treated as
-- finished (C1): they are stamped here, each with one audit row that has no
-- acting user and names this change as its source.
--
-- Hand-written: `prisma migrate dev` re-proposes dropping the raw NULLS NOT
-- DISTINCT index "activity_records_reporting_entity_period_category_key" on
-- every generation (CLAUDE.md). This migration drops no index. `audit_log` is
-- append-only: INSERT is the only statement run on it.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "organisations" ADD COLUMN "onboarding_completed_at" TIMESTAMPTZ(6);

-- C1: every organisation that exists now is finished, at the migration's own instant.
UPDATE "organisations"
   SET "onboarding_completed_at" = now()
 WHERE "onboarding_completed_at" IS NULL;

INSERT INTO "audit_log" ("id", "user_id", "action", "entity", "entity_id", "diff", "organisation_id", "role")
SELECT
  gen_random_uuid(),
  NULL,
  'update',
  'organisation',
  o."id"::text,
  jsonb_build_object(
    'source', 'migration:inc26-central-reporter-onboarding',
    'carryOver', true,
    'onboardingCompletedAt', jsonb_build_object('before', NULL, 'after', to_jsonb(o."onboarding_completed_at"))
  ),
  o."id",
  NULL
FROM "organisations" o;

-- The wizard's finish sets the column once (D8). Never inserted by the runtime
-- role: its column INSERT grant on `organisations` does not name it, so an
-- organisation — a registration's, the operator's — is born unfinished.
GRANT UPDATE ("onboarding_completed_at") ON "organisations" TO "tonyai_runtime";
