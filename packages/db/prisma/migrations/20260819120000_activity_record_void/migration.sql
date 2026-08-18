-- WP18 PR 2a — FR §4.3's revision rule: an approved figure can be WITHDRAWN.
--
-- `approved` and `locked` are terminal and immutable, and that is correct: a
-- figure a reviewer accepted must not be silently edited away. But it left a
-- record entered in error with no exit at all — the API refuses update, delete,
-- submit, review, approve and reject on both statuses, and being `super_admin`
-- does not help, because the status check is independent of the role check. The
-- only remedy was deleting the row, which the API rightly refuses.
--
-- `voided` is the missing outcome. The row stays, stays auditable, keeps its
-- immutable calculation snapshot, and counts towards nothing. The three columns
-- are FR §4.3's requirements: a mandatory reason, who acted, and when.
--
-- Hand-written rather than generated. `prisma migrate dev` re-proposes
--   DROP INDEX "activity_records_reporting_entity_period_category_key";
-- on every generation, because that index is the raw NULLS NOT DISTINCT
-- uniqueness guard Prisma cannot express (see CLAUDE.md). Writing this by hand
-- means the hazard never enters the file. Dropping that index would silently
-- allow duplicate subsidiary-level records — it shipped that way once in WP3.
--
-- `voided_by` is a plain UUID with no FK, matching `reviewed_by`: identity is
-- resolved at read time, so deleting a profile removes the name from the view
-- while the opaque id survives for the audit trail.
--
-- No RLS migration. `activity_records` policies exist from
-- 20260701214626_rls_activity_records, and neither a new enum value nor a new
-- column changes which rows a client role can see — the policy keys on
-- `subsidiary_id` alone.

-- AlterEnum
-- Safe inside Prisma's transaction on PG 12+: the new value is added here and
-- first USED by a later statement in a later transaction.
ALTER TYPE "ActivityRecordStatus" ADD VALUE 'voided';

-- AlterTable
ALTER TABLE "activity_records" ADD COLUMN     "void_reason" TEXT,
ADD COLUMN     "voided_at" TIMESTAMP(3),
ADD COLUMN     "voided_by" UUID;
