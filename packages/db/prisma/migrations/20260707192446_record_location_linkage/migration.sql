-- Activity-record ↔ location linkage (FR §1.1 / §5.2).
--
-- Adds an optional `location_id` to activity records (a record may be attributed
-- to the subsidiary as a whole, or to one of its operational locations) and a
-- required `geography_code` to locations (a location drives the emission-factor
-- geography instead of the subsidiary's when a record targets it).
--
-- Uniqueness moves from Prisma's `@@unique` (dropped) to a raw NULLS NOT DISTINCT
-- unique index so subsidiary-level rows (NULL location_id) are still deduplicated
-- — Prisma can't express NULLS NOT DISTINCT, so it lives here like the RLS policies.

-- Drop the old subsidiary-level unique index (Prisma-generated).
DROP INDEX "activity_records_subsidiary_id_reporting_year_reporting_per_key";

-- activity_records: optional location link (SET NULL so deleting a location
-- detaches its records rather than cascading their deletion).
ALTER TABLE "activity_records" ADD COLUMN "location_id" UUID;
CREATE INDEX "activity_records_location_id_idx" ON "activity_records"("location_id");
ALTER TABLE "activity_records"
  ADD CONSTRAINT "activity_records_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- locations.geography_code: add nullable, backfill from the parent subsidiary,
-- then enforce NOT NULL (the column is required going forward).
ALTER TABLE "locations" ADD COLUMN "geography_code" TEXT;
UPDATE "locations" l
  SET "geography_code" = s."geography_code"
  FROM "subsidiaries" s
  WHERE s."id" = l."subsidiary_id";
ALTER TABLE "locations" ALTER COLUMN "geography_code" SET NOT NULL;

-- New uniqueness: one record per (subsidiary, location, year, period, periodValue,
-- category). NULLS NOT DISTINCT (PG15+) means two subsidiary-level rows (NULL
-- location_id) with the same key collide too — so the subsidiary-level guarantee
-- is preserved while location-level entries for the same period are allowed.
CREATE UNIQUE INDEX "activity_records_reporting_entity_period_category_key"
  ON "activity_records" (
    "subsidiary_id", "location_id", "reporting_year",
    "reporting_period", "period_value", "category"
  )
  NULLS NOT DISTINCT;
