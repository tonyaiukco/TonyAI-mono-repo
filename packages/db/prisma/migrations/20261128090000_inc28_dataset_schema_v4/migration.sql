-- inc28-fuel-bulk D17: report dataset schema 4 — schema 3 with one top-level
-- boolean, `cardFuelAttribution`, written from 4 on and absent before. Only the
-- version CHECK widens; the canonicalization tag is unchanged, so every
-- retained dataset of versions 1 to 3 keeps its fingerprint.

ALTER TABLE "report_datasets"
  DROP CONSTRAINT "report_datasets_schema_check";
ALTER TABLE "report_datasets"
  ADD CONSTRAINT "report_datasets_schema_check"
    CHECK ("schema_version" IN (1, 2, 3, 4) AND "canonicalization" = 'tonyai-report-dataset-v1');
