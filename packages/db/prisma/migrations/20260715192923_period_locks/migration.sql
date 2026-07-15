-- CreateTable
CREATE TABLE "period_locks" (
    "id" UUID NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "reporting_year" INTEGER NOT NULL,
    "reporting_period" TEXT NOT NULL,
    "period_value" TEXT NOT NULL,
    "locked_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "period_locks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "period_locks_subsidiary_id_idx" ON "period_locks"("subsidiary_id");

-- CreateIndex
CREATE UNIQUE INDEX "period_locks_subsidiary_id_reporting_year_reporting_period__key" ON "period_locks"("subsidiary_id", "reporting_year", "reporting_period", "period_value");

-- AddForeignKey
ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_subsidiary_id_fkey" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
