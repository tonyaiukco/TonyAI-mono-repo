-- Expand-only: three new tables, two nullable or defaulted columns, one index
-- widened, two triggers, RLS and grants. No table or policy is dropped, no
-- column is renamed, and no existing row is rewritten: every record of today
-- has no fuel batch, and every import of today reads `template` from its
-- default. The previous API image keeps working on this schema (design
-- "Migration Plan" 2): the index is only wider, and it never writes a batch.
-- Once batch records exist, TA029 refuses that image's every insert, edit,
-- delete and review step on them, so no batch record's figure, slot or review
-- status changes through it; a void and a period lock still act as D9
-- allows, and its evidence links (`activity_record_evidence`) are not
-- guarded. No forward-only mark.
--
-- WP9 (`inc28-fuel-bulk`), PR A — INC-2.8, INC-2.9 §3: fuel accounts, fuel
-- rows and fuel batches (design D1), the slot key widened by the batch (D2),
-- the batch fixed on its records (TA028) and the earlier-image guard (TA029,
-- D9), RLS by D14's matrix.
--
-- Order:
--   1. the auth.uid() shim for a database without Supabase Auth;
--   2. the columns, tables, indexes and foreign keys Prisma models;
--   3. the CHECKs each column and each state needs;
--   4. the live-row dedupe index (D5) and the widened slot index (D2);
--   5. the triggers TA028 and TA029;
--   6. RLS and the client roles' grants (D14);
--   7. the runtime role's grants.
--
-- New error codes:
--   TA028  a record's fuel batch changed after insert                    → 409
--   TA029  a record of a fuel batch written outside a step of that batch  → 409
--          (a step declares `<batch id>:<its transaction id>`, see TA029)
--
-- Hand-written: `prisma migrate dev` re-proposes dropping the raw NULLS NOT
-- DISTINCT index "activity_records_reporting_entity_period_category_key" on
-- every generation (CLAUDE.md). Section 4 drops it and re-creates it, wider,
-- under the same name, in this transaction; no generated DROP is taken.

-- ALTER TABLE takes ACCESS EXCLUSIVE locks until commit; queued behind a long
-- transaction it would stall every request. Give up instead, and let the
-- deploy be retried.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. auth.uid() for a database without Supabase Auth (the shadow database)
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS "auth";
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth'
      AND p.proname = 'uid'
  ) THEN
    EXECUTE $shim$
      CREATE FUNCTION "auth"."uid"() RETURNS uuid
      LANGUAGE sql STABLE
      AS $body$
        SELECT NULLIF(
          current_setting('request.jwt.claim.sub', true),
          ''
        )::uuid
      $body$
    $shim$;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Columns, tables, indexes, foreign keys (design D1; schema.prisma)
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "activity_records" ADD COLUMN     "fuel_batch_id" UUID;

-- AlterTable
ALTER TABLE "import_batches" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'template';

-- CreateTable
CREATE TABLE "fuel_accounts" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subsidiary_id" UUID,
    "state" TEXT NOT NULL DEFAULT 'unmatched',
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fuel_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_batches" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "fuel_account_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "invoice_ref" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "usage" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submitted_at" TIMESTAMPTZ(6),
    "submission_count" INTEGER NOT NULL DEFAULT 0,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_note" TEXT,
    "variance_reason" TEXT,
    "withdrawn_by" UUID,
    "withdrawn_at" TIMESTAMPTZ(6),
    "withdrawn_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fuel_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_rows" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "import_batch_id" UUID NOT NULL,
    "holder_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "dedupe_digest" CHAR(64) NOT NULL,
    "fuel_account_id" UUID NOT NULL,
    "raw_fuel" TEXT,
    "fuel" TEXT,
    "usage" TEXT NOT NULL,
    "litres" DECIMAL NOT NULL,
    "transaction_at" TIMESTAMP(0),
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "invoice_ref" TEXT NOT NULL,
    "file_row" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "hold_reason" TEXT,
    "subsidiary_id" UUID,
    "fuel_batch_id" UUID,
    "withdrawn_by" UUID,
    "withdrawn_at" TIMESTAMPTZ(6),
    "withdrawn_reason" TEXT,
    "withdrawn_state" TEXT,
    "replaces_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fuel_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fuel_accounts_subsidiary_id_idx" ON "fuel_accounts"("subsidiary_id");

-- CreateIndex
CREATE UNIQUE INDEX "fuel_accounts_organisation_id_source_code_key" ON "fuel_accounts"("organisation_id", "source", "code");

-- CreateIndex
CREATE UNIQUE INDEX "fuel_accounts_id_organisation_id_key" ON "fuel_accounts"("id", "organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "fuel_accounts_id_source_key" ON "fuel_accounts"("id", "source");

-- CreateIndex
CREATE INDEX "fuel_batches_organisation_id_status_idx" ON "fuel_batches"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "fuel_batches_subsidiary_id_status_idx" ON "fuel_batches"("subsidiary_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "fuel_batches_fuel_account_id_invoice_ref_sequence_key" ON "fuel_batches"("fuel_account_id", "invoice_ref", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "fuel_batches_id_subsidiary_id_key" ON "fuel_batches"("id", "subsidiary_id");

-- CreateIndex
CREATE UNIQUE INDEX "fuel_batches_id_fuel_account_id_key" ON "fuel_batches"("id", "fuel_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "fuel_batches_id_invoice_ref_key" ON "fuel_batches"("id", "invoice_ref");

-- CreateIndex
CREATE INDEX "fuel_rows_import_batch_id_state_idx" ON "fuel_rows"("import_batch_id", "state");

-- CreateIndex
CREATE INDEX "fuel_rows_fuel_account_id_state_idx" ON "fuel_rows"("fuel_account_id", "state");

-- CreateIndex
CREATE INDEX "fuel_rows_fuel_batch_id_idx" ON "fuel_rows"("fuel_batch_id");

-- CreateIndex
CREATE INDEX "fuel_rows_holder_id_state_idx" ON "fuel_rows"("holder_id", "state");

-- CreateIndex
CREATE INDEX "fuel_rows_subsidiary_id_state_idx" ON "fuel_rows"("subsidiary_id", "state");

-- CreateIndex
CREATE INDEX "fuel_rows_fuel_account_id_invoice_ref_idx" ON "fuel_rows"("fuel_account_id", "invoice_ref");

-- CreateIndex
CREATE UNIQUE INDEX "fuel_rows_id_organisation_id_key" ON "fuel_rows"("id", "organisation_id");

-- CreateIndex
CREATE INDEX "activity_records_fuel_batch_id_idx" ON "activity_records"("fuel_batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_id_organisation_id_key" ON "import_batches"("id", "organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_id_source_key" ON "import_batches"("id", "source");

-- AddForeignKey
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_fuel_batch_id_subsidiary_id_fkey" FOREIGN KEY ("fuel_batch_id", "subsidiary_id") REFERENCES "fuel_batches"("id", "subsidiary_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_accounts" ADD CONSTRAINT "fuel_accounts_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_accounts" ADD CONSTRAINT "fuel_accounts_subsidiary_id_organisation_id_fkey" FOREIGN KEY ("subsidiary_id", "organisation_id") REFERENCES "subsidiaries"("id", "organisation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_batches" ADD CONSTRAINT "fuel_batches_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_batches" ADD CONSTRAINT "fuel_batches_subsidiary_id_organisation_id_fkey" FOREIGN KEY ("subsidiary_id", "organisation_id") REFERENCES "subsidiaries"("id", "organisation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_batches" ADD CONSTRAINT "fuel_batches_fuel_account_id_organisation_id_fkey" FOREIGN KEY ("fuel_account_id", "organisation_id") REFERENCES "fuel_accounts"("id", "organisation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_batches" ADD CONSTRAINT "fuel_batches_fuel_account_id_source_fkey" FOREIGN KEY ("fuel_account_id", "source") REFERENCES "fuel_accounts"("id", "source") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_import_batch_id_organisation_id_fkey" FOREIGN KEY ("import_batch_id", "organisation_id") REFERENCES "import_batches"("id", "organisation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_import_batch_id_source_fkey" FOREIGN KEY ("import_batch_id", "source") REFERENCES "import_batches"("id", "source") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_fuel_account_id_organisation_id_fkey" FOREIGN KEY ("fuel_account_id", "organisation_id") REFERENCES "fuel_accounts"("id", "organisation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_fuel_account_id_source_fkey" FOREIGN KEY ("fuel_account_id", "source") REFERENCES "fuel_accounts"("id", "source") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_subsidiary_id_organisation_id_fkey" FOREIGN KEY ("subsidiary_id", "organisation_id") REFERENCES "subsidiaries"("id", "organisation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_fuel_batch_id_fuel_account_id_fkey" FOREIGN KEY ("fuel_batch_id", "fuel_account_id") REFERENCES "fuel_batches"("id", "fuel_account_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_fuel_batch_id_subsidiary_id_fkey" FOREIGN KEY ("fuel_batch_id", "subsidiary_id") REFERENCES "fuel_batches"("id", "subsidiary_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_fuel_batch_id_invoice_ref_fkey" FOREIGN KEY ("fuel_batch_id", "invoice_ref") REFERENCES "fuel_batches"("id", "invoice_ref") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_replaces_id_organisation_id_fkey" FOREIGN KEY ("replaces_id", "organisation_id") REFERENCES "fuel_rows"("id", "organisation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- 3. CHECKs (design D1, D5, D8; the vocabularies are `@tonyai/shared-types`)
-- ---------------------------------------------------------------------------

-- What an import is (`IMPORT_SOURCES`). A fuel import keeps no file (C19) and
-- names no company: its rows do.
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_source_check"
  CHECK ("source" IN ('template', 'shell', 'petrol_ofisi', 'tanker'));
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_fuel_import_check"
  CHECK ("source" = 'template' OR ("storage_path" IS NULL AND COALESCE(cardinality("subsidiary_ids"), 0) = 0));

-- An account: its source, a code, and the columns of its mapping state (C4, C5).
ALTER TABLE "fuel_accounts" ADD CONSTRAINT "fuel_accounts_source_check"
  CHECK ("source" IN ('shell', 'petrol_ofisi', 'tanker'));
ALTER TABLE "fuel_accounts" ADD CONSTRAINT "fuel_accounts_code_check"
  CHECK (length("code") > 0);
ALTER TABLE "fuel_accounts" ADD CONSTRAINT "fuel_accounts_state_check"
  CHECK (
    ("state" = 'unmatched' AND "subsidiary_id" IS NULL AND "confirmed_by" IS NULL AND "confirmed_at" IS NULL)
    OR ("state" = 'proposed' AND "subsidiary_id" IS NOT NULL AND "confirmed_by" IS NULL AND "confirmed_at" IS NULL)
    OR ("state" = 'confirmed' AND "subsidiary_id" IS NOT NULL AND "confirmed_by" IS NOT NULL AND "confirmed_at" IS NOT NULL)
  );

-- A batch: its vocabularies; the category its usage decides (D6: stationary is
-- the `Fuel` category, on-road and off-road Mobile Combustion); a Shell
-- invoice is a half-month (C2); a withdrawal keeps who, when and why (C14).
ALTER TABLE "fuel_batches" ADD CONSTRAINT "fuel_batches_source_check"
  CHECK ("source" IN ('shell', 'petrol_ofisi', 'tanker'));
ALTER TABLE "fuel_batches" ADD CONSTRAINT "fuel_batches_usage_check"
  CHECK ("usage" IN ('on_road', 'off_road', 'stationary'));
ALTER TABLE "fuel_batches" ADD CONSTRAINT "fuel_batches_category_check"
  CHECK ("category" IN ('Mobile Combustion', 'Fuel') AND ("usage" = 'stationary') = ("category" = 'Fuel'));
ALTER TABLE "fuel_batches" ADD CONSTRAINT "fuel_batches_status_check"
  CHECK ("status" IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn'));
ALTER TABLE "fuel_batches" ADD CONSTRAINT "fuel_batches_sequence_check"
  CHECK ("sequence" >= 1 AND "submission_count" >= 0);
ALTER TABLE "fuel_batches" ADD CONSTRAINT "fuel_batches_invoice_ref_check"
  CHECK (
    length("invoice_ref") BETWEEN 1 AND 64
    AND ("source" <> 'shell' OR "invoice_ref" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-[12]$')
  );
ALTER TABLE "fuel_batches" ADD CONSTRAINT "fuel_batches_submitted_check"
  CHECK ("status" NOT IN ('submitted', 'under_review', 'approved') OR ("submitted_at" IS NOT NULL AND "submission_count" >= 1));
ALTER TABLE "fuel_batches" ADD CONSTRAINT "fuel_batches_withdrawn_check"
  CHECK (
    ("status" = 'withdrawn' AND "withdrawn_by" IS NOT NULL AND "withdrawn_at" IS NOT NULL
      AND "withdrawn_reason" IS NOT NULL AND length(btrim("withdrawn_reason")) > 0)
    OR ("status" <> 'withdrawn' AND "withdrawn_by" IS NULL AND "withdrawn_at" IS NULL AND "withdrawn_reason" IS NULL)
  );

-- A row: its vocabularies and values (D4, D5); a card row's period is the
-- calendar month of its transaction date and a Shell row's invoice its
-- half-month (C2); a tanker delivery has no date and no raw fuel name, and is
-- declared a fuel (C3).
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_source_check"
  CHECK ("source" IN ('shell', 'petrol_ofisi', 'tanker'));
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_usage_check"
  CHECK ("usage" IN ('on_road', 'off_road', 'stationary'));
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_fuel_check"
  CHECK ("fuel" IS NULL OR "fuel" IN ('diesel', 'petrol'));
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_values_check"
  CHECK (
    "litres" > 0 AND "litres" < 'Infinity'::numeric AND "month" BETWEEN 1 AND 12 AND "file_row" >= 1
    AND "dedupe_digest" ~ '^[0-9a-f]{64}$'
    AND length("invoice_ref") BETWEEN 1 AND 64
    AND ("replaces_id" IS NULL OR "replaces_id" <> "id")
  );
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_source_shape_check"
  CHECK (
    ("source" = 'tanker' AND "transaction_at" IS NULL AND "raw_fuel" IS NULL AND "fuel" IS NOT NULL)
    OR ("source" <> 'tanker' AND "transaction_at" IS NOT NULL AND "raw_fuel" IS NOT NULL
      AND "year" = EXTRACT(YEAR FROM "transaction_at")
      AND "month" = EXTRACT(MONTH FROM "transaction_at"))
  );
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_shell_invoice_check"
  CHECK (
    "source" <> 'shell'
    OR "invoice_ref" = lpad(EXTRACT(YEAR FROM "transaction_at")::int::text, 4, '0')
      || '-' || lpad(EXTRACT(MONTH FROM "transaction_at")::int::text, 2, '0')
      || '-' || CASE WHEN EXTRACT(DAY FROM "transaction_at") <= 15 THEN '1' ELSE '2' END
  );
-- The row states (D8) and the columns each holds. A withdrawn row keeps the
-- columns of the state it was withdrawn from (`withdrawn_state`), so the same
-- rules read it by that state. Each is wrapped in COALESCE(…, false): a CHECK
-- passes on NULL, and `x IN (…)` is NULL for an empty `x`.
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_state_check"
  CHECK (COALESCE(
    "state" IN ('waiting_account', 'excluded', 'waiting_fuel', 'ready', 'held', 'assigned', 'withdrawn')
    AND (
      ("state" = 'withdrawn' AND "withdrawn_state" IN ('waiting_account', 'excluded', 'waiting_fuel', 'ready', 'held', 'assigned')
        AND "withdrawn_by" IS NOT NULL AND "withdrawn_at" IS NOT NULL
        AND "withdrawn_reason" IS NOT NULL AND length(btrim("withdrawn_reason")) > 0)
      OR ("state" <> 'withdrawn' AND "withdrawn_state" IS NULL AND "withdrawn_by" IS NULL
        AND "withdrawn_at" IS NULL AND "withdrawn_reason" IS NULL)
    ),
    false
  ));
ALTER TABLE "fuel_rows" ADD CONSTRAINT "fuel_rows_state_columns_check"
  CHECK (COALESCE(
    CASE COALESCE("withdrawn_state", "state")
      WHEN 'waiting_account' THEN "subsidiary_id" IS NULL AND "fuel_batch_id" IS NULL AND "hold_reason" IS NULL
      WHEN 'excluded' THEN "subsidiary_id" IS NOT NULL AND "fuel_batch_id" IS NULL AND "hold_reason" IS NULL
      WHEN 'waiting_fuel' THEN "subsidiary_id" IS NOT NULL AND "fuel_batch_id" IS NULL AND "hold_reason" IS NULL
        AND "fuel" IS NULL
      WHEN 'ready' THEN "subsidiary_id" IS NOT NULL AND "fuel_batch_id" IS NULL AND "hold_reason" IS NULL
        AND "fuel" IS NOT NULL
      WHEN 'held' THEN "subsidiary_id" IS NOT NULL AND "fuel_batch_id" IS NULL AND "fuel" IS NOT NULL
        AND "hold_reason" IN ('fuel_out_of_scope', 'period_locked', 'category_not_granted',
          'single_entry_period_conflict', 'no_factor', 'entity_closed_to_data_entry', 'slot_holds_untyped', 'unexpected')
      WHEN 'assigned' THEN "subsidiary_id" IS NOT NULL AND "fuel_batch_id" IS NOT NULL AND "hold_reason" IS NULL
        AND "fuel" IS NOT NULL
      ELSE false
    END,
    false
  ));

-- A batch's record is typed, of a fuel category (D6: every fuel and usage
-- pair names an activity type). With the batch in the slot key, an untyped
-- record in a batch would otherwise sit beside the slot's one untyped manual
-- record and another batch's: TA002 refuses only a mix of typed and untyped.
ALTER TABLE "activity_records" ADD CONSTRAINT "activity_records_fuel_batch_typed_check"
  CHECK ("fuel_batch_id" IS NULL OR ("activity_type" IS NOT NULL AND "category" IN ('Mobile Combustion', 'Fuel')));

-- ---------------------------------------------------------------------------
-- 4. The live-row dedupe index (D5) and the widened slot index (D2)
-- ---------------------------------------------------------------------------

-- A row's key is stored once among the organisation's live rows of a source,
-- for every writer; a withdrawn row leaves its key free for its replacement.
-- Partial, so invisible to Prisma, like the slot index.
CREATE UNIQUE INDEX "fuel_rows_live_dedupe_key"
  ON "fuel_rows" ("organisation_id", "source", "dedupe_digest")
  WHERE "state" <> 'withdrawn';

-- The slot key gains the batch, last: a manual record (NULL batch) keeps one
-- per slot as before, and each batch holds one record per slot and type. The
-- slot-kind rule (TA002) is untouched and stays slot-wide.
DROP INDEX "activity_records_reporting_entity_period_category_key";
CREATE UNIQUE INDEX "activity_records_reporting_entity_period_category_key"
  ON "activity_records" ("subsidiary_id", "location_id", "reporting_year", "reporting_period", "period_value", "category", "activity_type", "fuel_batch_id")
  NULLS NOT DISTINCT
  WHERE "status" <> 'voided';

-- ---------------------------------------------------------------------------
-- 5. TA028 and TA029 (design D9)
-- ---------------------------------------------------------------------------

-- TA028: a record's batch is set when it is inserted and never changes, so a
-- record never moves into, out of or between batches.
CREATE FUNCTION "public"."activity_records_fuel_batch_fixed"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
  END IF;
  IF NEW."fuel_batch_id" IS DISTINCT FROM OLD."fuel_batch_id" THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TA028',
      MESSAGE = format('fuel_batch_fixed: record %s keeps the fuel batch it was stored with (%s)',
        OLD."id", COALESCE(OLD."fuel_batch_id"::text, 'none'));
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "activity_records_fuel_batch_fixed"
  BEFORE UPDATE ON "activity_records"
  FOR EACH ROW EXECUTE FUNCTION "public"."activity_records_fuel_batch_fixed"();
ALTER TABLE "activity_records" ENABLE ALWAYS TRIGGER "activity_records_fuel_batch_fixed";

-- TA029: a record of a fuel batch is inserted, changed or deleted only inside
-- a step of that batch: a transaction that declared it with
-- set_config('tonyai.fuel_batch_step', '<batch id>:' || pg_current_xact_id(), true),
-- which only the batch service does. The transaction id binds the declaration
-- to its own transaction, so one written for the whole session by a slip
-- (`is_local` false) is worth nothing in the next. Two exceptions, each changing nothing but its own
-- columns: a void (the status to `voided`, the void's three columns and
-- `updated_at`) and a period lock's flip (`approved` <-> `locked` and
-- `updated_at`). An API image from before batches never declares a batch, so
-- on this schema it cannot submit, approve, edit or delete one record of a
-- batch. A guard against an earlier image and a coding slip, not against a
-- caller holding the runtime role, who may set the declaration too.
CREATE FUNCTION "public"."activity_records_fuel_batch_step"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  batch_id uuid;
  declared text;
  probe "public"."activity_records";
BEGIN
  IF pg_catalog.current_setting('session_replication_role') = 'replica' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    batch_id := NEW."fuel_batch_id";
  ELSIF TG_OP = 'UPDATE' THEN
    batch_id := COALESCE(OLD."fuel_batch_id", NEW."fuel_batch_id");
  ELSE
    batch_id := OLD."fuel_batch_id";
  END IF;
  IF batch_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  declared := pg_catalog.current_setting('tonyai.fuel_batch_step', true);
  IF declared IS NOT NULL
     AND declared = batch_id::text || ':' || pg_catalog.pg_current_xact_id()::text THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    probe := NEW;
    IF OLD."status" <> 'voided' AND NEW."status" = 'voided' THEN
      probe."status" := OLD."status";
      probe."void_reason" := OLD."void_reason";
      probe."voided_by" := OLD."voided_by";
      probe."voided_at" := OLD."voided_at";
      probe."updated_at" := OLD."updated_at";
      IF probe IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
    ELSIF (OLD."status" = 'approved' AND NEW."status" = 'locked')
       OR (OLD."status" = 'locked' AND NEW."status" = 'approved') THEN
      probe."status" := OLD."status";
      probe."updated_at" := OLD."updated_at";
      IF probe IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'TA029',
    MESSAGE = format('record_in_batch: a record of fuel batch %s is written only by a step of that batch (%s)',
      batch_id, lower(TG_OP));
END
$fn$;

CREATE TRIGGER "activity_records_fuel_batch_step"
  BEFORE INSERT OR UPDATE OR DELETE ON "activity_records"
  FOR EACH ROW EXECUTE FUNCTION "public"."activity_records_fuel_batch_step"();
ALTER TABLE "activity_records" ENABLE ALWAYS TRIGGER "activity_records_fuel_batch_step";

-- ---------------------------------------------------------------------------
-- 6. RLS (design D14) — ENABLE, never FORCE; SELECT-only, auth.uid()-keyed
-- ---------------------------------------------------------------------------
-- The API runs as tonyai_runtime (BYPASSRLS) and scopes every query itself;
-- these confine a direct PostgREST client to D14's matrix: a masterkey and an
-- auditor read their organisation; a super_admin a granted company's; a
-- standard user a granted company's in the categories of its grant (a row's
-- or batch's category: `Fuel` for the stationary usage, Mobile Combustion
-- otherwise), its own batch only in a company it is still granted, and the
-- rows it holds while they are in no batch; a row in a batch is read exactly
-- when its batch is (so a reader of its own batch reads its rows, and a
-- withdrawn grant closes both at once); a row with no company only its
-- holder; accounts never a standard user.

ALTER TABLE "fuel_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fuel_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fuel_rows" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fuel_accounts_select_scoped" ON "fuel_accounts" FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM "profiles" p
    WHERE p."id" = (SELECT auth.uid())
      AND p."organisation_id" = "fuel_accounts"."organisation_id"
      AND p."role" = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])
  )
  OR EXISTS (
    SELECT 1 FROM "user_subsidiary_access" usa
    JOIN "profiles" p ON p."id" = usa."user_id"
    JOIN "subsidiaries" s ON s."id" = usa."subsidiary_id"
    WHERE usa."user_id" = (SELECT auth.uid())
      AND usa."subsidiary_id" = "fuel_accounts"."subsidiary_id"
      AND p."role" = 'super_admin'::"UserRole"
      AND p."organisation_id" = "fuel_accounts"."organisation_id"
      AND s."organisation_id" = "fuel_accounts"."organisation_id"
  )
);

CREATE POLICY "fuel_batches_select_scoped" ON "fuel_batches" FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM "profiles" p
    WHERE p."id" = (SELECT auth.uid())
      AND p."organisation_id" = "fuel_batches"."organisation_id"
      AND p."role" = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])
  )
  OR EXISTS (
    SELECT 1 FROM "user_subsidiary_access" usa
    JOIN "profiles" p ON p."id" = usa."user_id"
    JOIN "subsidiaries" s ON s."id" = usa."subsidiary_id"
    WHERE usa."user_id" = (SELECT auth.uid())
      AND usa."subsidiary_id" = "fuel_batches"."subsidiary_id"
      AND p."organisation_id" = "fuel_batches"."organisation_id"
      AND s."organisation_id" = "fuel_batches"."organisation_id"
      AND (
        p."role" = 'super_admin'::"UserRole"
        OR "fuel_batches"."category" = ANY (usa."categories")
        OR "fuel_batches"."created_by" = (SELECT auth.uid())
      )
  )
);

CREATE POLICY "fuel_rows_select_scoped" ON "fuel_rows" FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM "profiles" p
    WHERE p."id" = (SELECT auth.uid())
      AND p."organisation_id" = "fuel_rows"."organisation_id"
      AND p."role" = ANY (ARRAY['masterkey'::"UserRole", 'auditor'::"UserRole"])
  )
  -- A row in a batch: exactly when the batch is readable (its own policy
  -- applies to this subquery).
  OR ("fuel_rows"."fuel_batch_id" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "fuel_batches" b
    WHERE b."id" = "fuel_rows"."fuel_batch_id"
      AND b."organisation_id" = "fuel_rows"."organisation_id"
  ))
  -- A row in no batch: its holder (a standard user also with a company); a
  -- granted company's reader by role and category.
  OR ("fuel_rows"."fuel_batch_id" IS NULL AND (
    EXISTS (
      SELECT 1 FROM "profiles" p
      WHERE p."id" = (SELECT auth.uid())
        AND p."organisation_id" = "fuel_rows"."organisation_id"
        AND "fuel_rows"."holder_id" = p."id"
        AND ("fuel_rows"."subsidiary_id" IS NULL OR p."role" = 'standard_user'::"UserRole")
    )
    OR EXISTS (
      SELECT 1 FROM "user_subsidiary_access" usa
      JOIN "profiles" p ON p."id" = usa."user_id"
      JOIN "subsidiaries" s ON s."id" = usa."subsidiary_id"
      WHERE usa."user_id" = (SELECT auth.uid())
        AND usa."subsidiary_id" = "fuel_rows"."subsidiary_id"
        AND p."organisation_id" = "fuel_rows"."organisation_id"
        AND s."organisation_id" = "fuel_rows"."organisation_id"
        AND (
          p."role" = 'super_admin'::"UserRole"
          OR (CASE WHEN "fuel_rows"."usage" = 'stationary' THEN 'Fuel' ELSE 'Mobile Combustion' END) = ANY (usa."categories")
        )
    )
  ))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase client roles absent (shadow database): skipping client grants';
    RETURN;
  END IF;
  REVOKE ALL ON "fuel_accounts", "fuel_batches", "fuel_rows" FROM anon, authenticated, service_role;
  GRANT SELECT ON "fuel_accounts", "fuel_batches", "fuel_rows" TO anon, authenticated, service_role;
END
$$;

-- ---------------------------------------------------------------------------
-- 7. Runtime grants (runtime-role.mjs RUNTIME_TABLE_PRIVILEGES, RUNTIME_COLUMN_UPDATES)
-- ---------------------------------------------------------------------------
-- Nothing of the three is deleted (C14). An account's name is the one last
-- read (display only); its source, code and organisation, a batch's company, account and invoice, and a row's key,
-- litres, account and import never change; only the columns a step writes
-- are updatable. `import_batches.source` and `activity_records.fuel_batch_id`
-- are covered by those tables' existing table-wide grants.

GRANT SELECT, INSERT ON "fuel_accounts", "fuel_batches", "fuel_rows" TO "tonyai_runtime";
GRANT UPDATE ("name", "subsidiary_id", "state", "confirmed_by", "confirmed_at", "updated_at")
  ON "fuel_accounts" TO "tonyai_runtime";
GRANT UPDATE ("usage", "category", "status", "submitted_at", "submission_count", "reviewed_by", "reviewed_at",
  "review_note", "variance_reason", "withdrawn_by", "withdrawn_at", "withdrawn_reason", "updated_at")
  ON "fuel_batches" TO "tonyai_runtime";
GRANT UPDATE ("holder_id", "fuel", "usage", "year", "month", "state", "hold_reason", "subsidiary_id", "fuel_batch_id",
  "withdrawn_by", "withdrawn_at", "withdrawn_reason", "withdrawn_state", "updated_at")
  ON "fuel_rows" TO "tonyai_runtime";
