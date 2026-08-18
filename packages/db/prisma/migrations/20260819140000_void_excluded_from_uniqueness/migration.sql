-- WP18 PR 2a — a WITHDRAWN figure must not block its own replacement.
--
-- The uniqueness guard had no status predicate, so a voided row kept occupying
-- its (subsidiary, location, year, period, category) slot forever. Voiding the
-- wrong January Electricity figure therefore meant that subsidiary could never
-- report January Electricity again: the correction 409s on this index, and the
-- voided row cannot be edited, deleted, submitted or un-voided. That is worse
-- than leaving the wrong number in place, and it makes FR §4.3's whole purpose
-- — withdraw the wrong figure SO THE RIGHT ONE CAN BE RECORDED — unreachable.
--
-- Partial, so the invariant becomes "at most one LIVE record per reporting
-- entity, period and category", with any number of withdrawn ones behind it.
-- That is what a restatement history should look like.
--
-- The NULLS NOT DISTINCT clause is preserved verbatim and is still load-bearing:
-- it is what stops two subsidiary-level rows (both `location_id IS NULL`) from
-- being treated as distinct keys. Dropping it would silently re-open duplicate
-- whole-company records, which shipped once in WP3.
--
-- NOTE for the next `prisma migrate dev`: Prisma still cannot express this index
-- and will keep re-proposing a DROP for it (see CLAUDE.md). The proposal now
-- also has to be ignored for the WHERE clause — a regenerated migration that
-- "restores" the index without `WHERE status <> 'voided'` would silently
-- reinstate the dead-end above.

DROP INDEX "activity_records_reporting_entity_period_category_key";

CREATE UNIQUE INDEX "activity_records_reporting_entity_period_category_key"
  ON "activity_records" (
    "subsidiary_id", "location_id", "reporting_year",
    "reporting_period", "period_value", "category"
  )
  NULLS NOT DISTINCT
  WHERE "status" <> 'voided';
