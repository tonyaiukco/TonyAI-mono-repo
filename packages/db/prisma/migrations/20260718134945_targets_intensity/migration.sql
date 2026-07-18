-- CreateTable
CREATE TABLE "targets" (
    "id" UUID NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "baseline_year" INTEGER NOT NULL,
    "baseline_tco2e" DOUBLE PRECISION NOT NULL,
    "target_year" INTEGER NOT NULL,
    "target_tco2e" DOUBLE PRECISION NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subsidiary_denominators" (
    "id" UUID NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subsidiary_denominators_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "targets_subsidiary_id_idx" ON "targets"("subsidiary_id");

-- CreateIndex
CREATE INDEX "subsidiary_denominators_subsidiary_id_idx" ON "subsidiary_denominators"("subsidiary_id");

-- CreateIndex
CREATE UNIQUE INDEX "subsidiary_denominators_subsidiary_id_year_metric_key" ON "subsidiary_denominators"("subsidiary_id", "year", "metric");

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_subsidiary_id_fkey" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subsidiary_denominators" ADD CONSTRAINT "subsidiary_denominators_subsidiary_id_fkey" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
