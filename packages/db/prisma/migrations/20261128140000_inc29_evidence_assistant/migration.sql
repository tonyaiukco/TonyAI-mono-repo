BEGIN;

ALTER TABLE "evidence"
  ADD COLUMN "source_sha256" CHAR(64),
  ADD COLUMN "source_page_from" INTEGER,
  ADD COLUMN "source_page_to" INTEGER,
  ADD CONSTRAINT "evidence_source_check" CHECK (
    ("source_sha256" IS NULL AND "source_page_from" IS NULL AND "source_page_to" IS NULL)
    OR (
      "source_sha256" IS NOT NULL AND "source_page_from" IS NOT NULL AND "source_page_to" IS NOT NULL
      AND "source_sha256" ~ '^[0-9a-f]{64}$' AND "source_page_from" > 0
      AND "source_page_to" >= "source_page_from"
    )
  );

CREATE TABLE "evidence_readings" (
  "evidence_id" UUID NOT NULL,
  "subsidiary_id" UUID NOT NULL,
  "reader_version" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "page_count" INTEGER NOT NULL,
  "invoices" JSONB NOT NULL,
  "read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_readings_pkey" PRIMARY KEY ("evidence_id", "reader_version"),
  CONSTRAINT "evidence_readings_evidence_id_subsidiary_id_fkey"
    FOREIGN KEY ("evidence_id", "subsidiary_id") REFERENCES "evidence" ("id", "subsidiary_id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "evidence_readings_version_check" CHECK (btrim("reader_version") <> ''),
  CONSTRAINT "evidence_readings_status_check" CHECK (
    "status" IN ('read', 'no_text', 'encrypted', 'unreadable', 'limit_exceeded', 'timed_out')
  ),
  CONSTRAINT "evidence_readings_page_count_check" CHECK ("page_count" >= 0),
  CONSTRAINT "evidence_readings_invoices_check" CHECK (jsonb_typeof("invoices") = 'array')
);

CREATE INDEX "fuel_rows_organisation_id_invoice_ref_idx" ON "fuel_rows" ("organisation_id", "invoice_ref");

-- Extracted invoice details are API-only. The service role bypasses RLS, so
-- revoke its privilege as well. The vanilla shadow database may lack these roles.
ALTER TABLE "evidence_readings" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "evidence_readings" FROM PUBLIC;
DO $$
DECLARE
  client_role text;
BEGIN
  FOR client_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
  LOOP
    EXECUTE format('REVOKE ALL ON "evidence_readings" FROM %I', client_role);
  END LOOP;
END
$$;

GRANT SELECT, INSERT ON "evidence_readings" TO "tonyai_runtime";

COMMIT;
