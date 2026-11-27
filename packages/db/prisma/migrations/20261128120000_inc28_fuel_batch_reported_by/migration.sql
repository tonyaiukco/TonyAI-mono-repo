-- inc28-fuel-bulk (fourth review of WP9 PR B): a fuel batch keeps the
-- reporting company its records were written for (TA025, a central
-- reporter's main company), so a withdrawn batch — whose records are removed —
-- or one whose every record was voided still names it. Null while the batch
-- is its own company's; the API sets it with the batch's first records and
-- never clears it. Same organisation as the batch (composite key).

-- AlterTable
ALTER TABLE "fuel_batches" ADD COLUMN     "reported_by_subsidiary_id" UUID;

-- AddForeignKey
ALTER TABLE "fuel_batches" ADD CONSTRAINT "fuel_batches_reported_by_subsidiary_id_organisation_id_fkey" FOREIGN KEY ("reported_by_subsidiary_id", "organisation_id") REFERENCES "subsidiaries"("id", "organisation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Backfill from the records a batch holds now (any status, a voided one too).
UPDATE "fuel_batches" b
   SET "reported_by_subsidiary_id" = r."reported_by_subsidiary_id"
  FROM (
    SELECT DISTINCT ON ("fuel_batch_id") "fuel_batch_id", "reported_by_subsidiary_id"
      FROM "activity_records"
     WHERE "fuel_batch_id" IS NOT NULL AND "reported_by_subsidiary_id" IS NOT NULL
     ORDER BY "fuel_batch_id", "created_at", "id"
  ) r
 WHERE r."fuel_batch_id" = b."id" AND r."reported_by_subsidiary_id" <> b."subsidiary_id";

-- Runtime: the column is written once by the API (runtime-role.mjs RUNTIME_COLUMN_UPDATES).
GRANT UPDATE ("reported_by_subsidiary_id") ON "fuel_batches" TO "tonyai_runtime";
