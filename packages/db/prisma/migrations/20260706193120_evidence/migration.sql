-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "activity_record_id" UUID NOT NULL,
    "storage_path" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evidence_activity_record_id_idx" ON "evidence"("activity_record_id");

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_activity_record_id_fkey" FOREIGN KEY ("activity_record_id") REFERENCES "activity_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
