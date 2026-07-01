-- CreateTable
CREATE TABLE "emission_factors" (
    "id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "geography_code" TEXT NOT NULL,
    "reporting_year" INTEGER NOT NULL,
    "scope" INTEGER NOT NULL,
    "factor_value" DOUBLE PRECISION NOT NULL,
    "factor_unit" TEXT NOT NULL,
    "normalized_unit" TEXT NOT NULL,
    "methodology" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emission_factors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "emission_factors_category_geography_code_reporting_year_idx" ON "emission_factors"("category", "geography_code", "reporting_year");

-- CreateIndex
CREATE UNIQUE INDEX "emission_factors_category_geography_code_reporting_year_ver_key" ON "emission_factors"("category", "geography_code", "reporting_year", "version");
