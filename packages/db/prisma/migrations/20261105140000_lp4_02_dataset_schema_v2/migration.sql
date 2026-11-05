-- LP4-02 PR2: report dataset schema 2. Fugitive Gas joins the categories a
-- boundary must decide, which moves the assessments K2 recomputes. A dataset
-- retained under schema 1 keeps schema 1's five categories, so both versions
-- stay issuable. The canonical encoding has not changed.
-- ---------------------------------------------------------------------------

ALTER TABLE "report_datasets" DROP CONSTRAINT "report_datasets_schema_check";

ALTER TABLE "report_datasets"
  ADD CONSTRAINT "report_datasets_schema_check"
    CHECK ("schema_version" IN (1, 2) AND "canonicalization" = 'tonyai-report-dataset-v1');
