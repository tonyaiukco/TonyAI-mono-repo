-- Evidence becomes many-to-many (WP8 retrospective, decision 3a): one uploaded
-- file can back several activity records of the same subsidiary, so a bulk
-- import's drafts can share an invoice instead of each needing its own upload.
--
-- A file stops hanging off one record and is owned by a SUBSIDIARY; the links
-- live in `activity_record_evidence`. Both of the link's foreign keys are
-- composite over `subsidiary_id`, so the database itself refuses a link between
-- a record and a file of different subsidiaries.
--
-- Hand-ordered: Prisma's generated diff adds a NOT NULL column to a table that
-- holds rows and drops `activity_record_id` before anything has read it. Every
-- existing row becomes a file of its record's subsidiary with exactly one link,
-- so every record keeps exactly the evidence it had.

-- The old RLS policy reads `evidence.activity_record_id`, so it goes before the
-- column can. Its replacement is in the next migration (rls_evidence_many_to_many).
DROP POLICY IF EXISTS "evidence_select_scoped" ON "evidence";

-- 1. The owner subsidiary, filled from each file's record.
ALTER TABLE "evidence" ADD COLUMN "subsidiary_id" UUID;

UPDATE "evidence" e
SET "subsidiary_id" = ar."subsidiary_id"
FROM "activity_records" ar
WHERE ar."id" = e."activity_record_id";

ALTER TABLE "evidence" ALTER COLUMN "subsidiary_id" SET NOT NULL;

CREATE INDEX "evidence_subsidiary_id_idx" ON "evidence"("subsidiary_id");

ALTER TABLE "evidence" ADD CONSTRAINT "evidence_subsidiary_id_fkey" FOREIGN KEY ("subsidiary_id") REFERENCES "subsidiaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. The (id, subsidiary_id) pairs the link's composite foreign keys point at.
CREATE UNIQUE INDEX "activity_records_id_subsidiary_id_key" ON "activity_records"("id", "subsidiary_id");

CREATE UNIQUE INDEX "evidence_id_subsidiary_id_key" ON "evidence"("id", "subsidiary_id");

-- 3. The links, one per existing file.
CREATE TABLE "activity_record_evidence" (
    "activity_record_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "subsidiary_id" UUID NOT NULL,
    "linked_by" UUID NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_record_evidence_pkey" PRIMARY KEY ("activity_record_id","evidence_id")
);

CREATE INDEX "activity_record_evidence_evidence_id_idx" ON "activity_record_evidence"("evidence_id");

ALTER TABLE "activity_record_evidence" ADD CONSTRAINT "activity_record_evidence_activity_record_id_subsidiary_id_fkey" FOREIGN KEY ("activity_record_id", "subsidiary_id") REFERENCES "activity_records"("id", "subsidiary_id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "activity_record_evidence" ADD CONSTRAINT "activity_record_evidence_evidence_id_subsidiary_id_fkey" FOREIGN KEY ("evidence_id", "subsidiary_id") REFERENCES "evidence"("id", "subsidiary_id") ON DELETE CASCADE ON UPDATE NO ACTION;

INSERT INTO "activity_record_evidence" ("activity_record_id", "evidence_id", "subsidiary_id", "linked_by", "linked_at")
SELECT e."activity_record_id", e."id", e."subsidiary_id", e."uploaded_by", e."created_at"
FROM "evidence" e;

-- 4. The single-parent column, now that nothing reads it.
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_activity_record_id_fkey";

DROP INDEX "evidence_activity_record_id_idx";

ALTER TABLE "evidence" DROP COLUMN "activity_record_id";
