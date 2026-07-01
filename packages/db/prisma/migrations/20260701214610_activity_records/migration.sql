-- CreateEnum
CREATE TYPE "ActivityRecordStatus" AS ENUM ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'locked');

-- CreateTable
CREATE TABLE "activity_records" (
    "id" UUID NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "reporting_year" INTEGER NOT NULL,
    "reporting_period" TEXT NOT NULL,
    "period_value" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "scope" INTEGER NOT NULL,
    "status" "ActivityRecordStatus" NOT NULL DEFAULT 'draft',
    "activity_value" DOUBLE PRECISION NOT NULL,
    "activity_unit" TEXT NOT NULL,
    "input" JSONB,
    "calculation" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "anomaly_flag" BOOLEAN NOT NULL DEFAULT false,
    "variance_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "activity_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_records_subsidiary_id_idx" ON "activity_records"("subsidiary_id");

-- CreateIndex
CREATE UNIQUE INDEX "activity_records_subsidiary_id_reporting_year_reporting_per_key" ON "activity_records"("subsidiary_id", "reporting_year", "reporting_period", "period_value", "category");

-- AddForeignKey
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_subsidiary_id_fkey" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
