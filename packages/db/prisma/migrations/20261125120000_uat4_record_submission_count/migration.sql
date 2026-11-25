-- WP5 (`uat4-review-resubmit`) — a record counts its submissions.
--
-- The review queue could not tell a first submission from a record that was
-- recalled or returned and sent again: recall clears `submitted_at` and leaves
-- no other mark, and `reviewed_at` is overwritten by every start of review.
-- `submission_count` is that mark. The API raises it by one inside the
-- submit's own compare-and-set update (so a lost race raises nothing, and a
-- bulk submit counts each record through the submit it already calls per id)
-- and nothing else touches it. It is a marker for the queue's "Revised" badge;
-- the audit rows stay the authority on what happened.
--
-- Hand-written after 20260828120000_activity_record_submitted_at, for the same
-- reason: `prisma migrate dev` re-proposes dropping the index
-- "activity_records_reporting_entity_period_category_key" on every generation
-- (the raw NULLS NOT DISTINCT uniqueness guard Prisma cannot express; see
-- CLAUDE.md). This migration touches no index, no
-- trigger, no policy and no grant: the lifecycle trigger compares an explicit
-- column list, so the new column is neither frozen nor refused, RLS policies
-- are table-scoped, and the runtime role's grant on the table is table-wide.
--
-- Expand-only: the previous API image neither reads nor writes the column, so
-- it keeps working between this migration and the new image. A record
-- submitted by the old image in that window is one short (accepted; QA is
-- told in the deploy note).

ALTER TABLE "activity_records" ADD COLUMN "submission_count" INTEGER NOT NULL DEFAULT 0;

-- Backfill from the audit trail: one `submit` row per successful submit.
--
-- `audit_log.entity_id` is TEXT and `activity_records.id` is UUID: the join
-- casts `ar.id::text`, never `entity_id::uuid`, which would abort the whole
-- migration on the first malformed id in an unconstrained TEXT column.
--
-- `updated_at` is deliberately NOT bumped. It is the record's version for the
-- compare-and-set of every edit form and review sheet; the count is not an
-- input, and bumping it would refuse every form open across the deploy with
-- `record_changed`. Neither trigger objects: no frozen input changes and no
-- status moves (and the migration runs as the table's owner).
--
-- Submits logged before the audit taxonomy (20260730194540) are `update` rows
-- whose `diff.transition.to` is 'submitted'; they are counted too, as the
-- record's history (`buildRecordTrail`) classifies them, so the column and the
-- trail agree on which submission is which.
UPDATE "activity_records" AS ar
SET "submission_count" = counted."n"
FROM (
  SELECT "entity_id", COUNT(*)::INTEGER AS "n"
  FROM "audit_log"
  WHERE "entity" = 'activity_record'
    AND (
      "action" = 'submit'
      OR ("action" = 'update' AND "diff" -> 'transition' ->> 'to' = 'submitted')
    )
  GROUP BY "entity_id"
) AS counted
WHERE counted."entity_id" = ar."id"::text;

-- Floor: a record that left `draft` was submitted at least once, even when no
-- `submit` row says so. That is every seeded record (the seed writes them
-- straight to `approved` and calls no submit path) and any record whose submit
-- left no audit row.
UPDATE "activity_records"
SET "submission_count" = 1
WHERE "status" <> 'draft' AND "submission_count" = 0;
