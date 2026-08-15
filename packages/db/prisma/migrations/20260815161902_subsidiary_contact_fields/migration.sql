-- WP16 PR 2a — subsidiary contact fields (round-1 UAT SUB-2).
--
-- NOTE: Prisma's generated diff for this migration contained a spurious
--   DROP INDEX "activity_records_reporting_entity_period_category_key";
-- as its FIRST line. It has been DELETED. That index is the raw
-- `NULLS NOT DISTINCT` uniqueness guard from the record_location_linkage
-- migration, which Prisma cannot express in schema.prisma and therefore
-- re-proposes for removal on every generation (see the guard rule in
-- CLAUDE.md). Dropping it would silently allow duplicate subsidiary-level
-- activity records — it shipped that way once in WP3 and was caught by review,
-- not by tests.
--
-- Both columns are nullable: every existing row predates them, and a subsidiary
-- is legally identifiable without a contact. No backfill, no RLS migration —
-- `subsidiaries` policies already exist from 20260630204830_rls_policies and
-- adding a column does not change row visibility.

-- AlterTable
ALTER TABLE "subsidiaries" ADD COLUMN     "contact_email" TEXT,
ADD COLUMN     "contact_phone" TEXT;
