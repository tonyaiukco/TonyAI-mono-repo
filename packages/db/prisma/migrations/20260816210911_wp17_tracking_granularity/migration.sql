-- WP17 PR 2 — how completeness is measured, per subsidiary (round-1 DE-2 + DASH-3).
--
-- NOTE: Prisma's generated diff contained a spurious
--   DROP INDEX "activity_records_reporting_entity_period_category_key";
-- as its second statement. It has been DELETED. That index is the raw
-- `NULLS NOT DISTINCT` uniqueness guard from the record_location_linkage
-- migration, which Prisma cannot express in schema.prisma and therefore
-- re-proposes for removal on every generation (see the guard rule in
-- CLAUDE.md). Dropping it would silently allow duplicate subsidiary-level
-- activity records — it shipped that way once in WP3 and was caught by review,
-- not by tests.
--
-- The column is NOT NULL with a default rather than nullable: "how is this
-- subsidiary measured" always has an answer, and `subsidiary` is the answer for
-- every row that predates the question. No backfill is needed and no dashboard
-- changes colour on deploy. No RLS migration either — `subsidiaries` policies
-- already exist from 20260630204830_rls_policies, and adding a column does not
-- change which rows a client role can see.

-- CreateEnum
CREATE TYPE "TrackingGranularity" AS ENUM ('subsidiary', 'location');

-- AlterTable
ALTER TABLE "subsidiaries" ADD COLUMN     "tracking_granularity" "TrackingGranularity" NOT NULL DEFAULT 'subsidiary';
