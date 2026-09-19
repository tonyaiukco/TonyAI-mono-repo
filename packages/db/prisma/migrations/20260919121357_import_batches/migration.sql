-- Import batches: one row per APPLIED bulk import, and the record FK to it.
--
-- Inspected before applying, per CLAUDE.md: this generation did NOT emit the
-- spurious `DROP INDEX activity_records_reporting_entity_period_category_key`
-- (the raw NULLS NOT DISTINCT uniqueness index); nothing was removed. The index
-- is checked after applying.
--
-- `subsidiary_ids` is nullable because Prisma cannot mark a scalar list NOT
-- NULL; the API always writes it, and the RLS policy treats a null or empty
-- array as visible to no data_entry reader (fail-closed).

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('processing', 'completed', 'failed');

-- AlterTable
ALTER TABLE "activity_records" ADD COLUMN     "import_batch_id" UUID;

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "subsidiary_ids" UUID[],
    "file_name" TEXT NOT NULL,
    "file_format" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "storage_path" TEXT,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'processing',
    "total_rows" INTEGER NOT NULL,
    "accepted_count" INTEGER,
    "rejected_count" INTEGER,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_batches_organisation_id_created_at_idx" ON "import_batches"("organisation_id", "created_at");

-- CreateIndex
CREATE INDEX "import_batches_uploaded_by_created_at_idx" ON "import_batches"("uploaded_by", "created_at");

-- CreateIndex
CREATE INDEX "activity_records_import_batch_id_idx" ON "activity_records"("import_batch_id");

-- AddForeignKey
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
