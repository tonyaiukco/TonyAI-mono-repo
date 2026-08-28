-- WP22 PR E — a record records WHEN it was submitted for review.
--
-- The review queue's "waiting" column counted days from `created_at`, which is
-- when the DRAFT was made. A record started in January and submitted in June
-- read as five months overdue. The column was honestly headed "Age" for exactly
-- that reason, and its source comment said so — the screen was truthful, just
-- much less useful than a reviewer needs when deciding what to pick up.
--
-- MOST RECENT submit, not the first. A rejected record can be resubmitted, so
-- `audit_log` holds one `submit` row per attempt and the question has two
-- honest answers: "when did this enter the review process" (MIN) and "how long
-- has the CURRENT reviewer had it" (MAX). MAX is what the queue is for, and it
-- matches how `reviewed_at` already behaves — overwritten on every review
-- outcome, not pinned to the first. The full history stays in `audit_log`.
--
-- Hand-written rather than generated, for the two reasons this repo has learned
-- the hard way. `prisma migrate dev` re-proposes
--   DROP INDEX "activity_records_reporting_entity_period_category_key";
-- on every generation, because that index is the raw NULLS NOT DISTINCT
-- uniqueness guard Prisma cannot express (see CLAUDE.md). Dropping it silently
-- allows duplicate subsidiary-level records — it shipped that way once in WP3.
-- And since 20260819140000 there is a SECOND way to get it wrong: a regenerated
-- migration that "restores" the index WITHOUT `WHERE status <> 'voided'` undoes
-- WP18 entirely, leaving a withdrawn figure's reporting entity unable to ever
-- report that month again. Writing this by hand means neither hazard enters the
-- file. This migration touches no index at all.
--
-- No RLS migration: `activity_records` policies exist from
-- 20260701214626_rls_activity_records and are table-scoped, not column-scoped,
-- so a new column inherits them.

ALTER TABLE "activity_records" ADD COLUMN "submitted_at" TIMESTAMP(3);

-- Backfill from the audit trail, which already holds the answer.
--
-- `audit_log.entity_id` is TEXT while `activity_records.id` is UUID, so the
-- join needs the cast — without it this is a type error, not a silent no-op.
-- The (entity, entity_id) index from the init migration serves this lookup.
--
-- Rows with no `submit` row keep NULL, deliberately. On a freshly seeded
-- database that is EVERY record: the seed writes them straight to `approved`
-- and never calls the submit path, so it produces no audit rows at all. The
-- queue renders an em dash for those rather than falling back to `created_at`,
-- because falling back would quietly reinstate the very misstatement this
-- column exists to end.
UPDATE "activity_records" AS ar
SET "submitted_at" = latest."at"
FROM (
  SELECT "entity_id", MAX("created_at") AS "at"
  FROM "audit_log"
  WHERE "entity" = 'activity_record' AND "action" = 'submit'
  GROUP BY "entity_id"
) AS latest
WHERE latest."entity_id" = ar."id"::text;
