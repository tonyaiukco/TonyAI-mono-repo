-- LP4-05 PR C: indexes for the keyset pages (`CursorPage`) of GET
-- /activity-records, /period-locks and /targets. Indexes only — no table,
-- column, grant or policy changes, so runtime-role.mjs is unchanged.
--
-- Chosen by EXPLAIN ANALYZE on 50,904 records over 20 subsidiaries (2,520
-- pending), synthesised and rolled back on the local stack:
--   newest, one subsidiary     0.92 ms -> 0.04 ms  (subsidiary_id, created_at DESC, id DESC)
--   newest, an organisation   26.0 ms  -> 0.07 ms  (created_at DESC, id DESC)
--   review queue              12.3 ms  -> 1.10 ms  (status, submitted_at, id)
-- An index led by subsidiary_id is not used for an organisation's IN-list
-- with ORDER BY, which is why `newest` has both. Period locks and targets are
-- small per subsidiary; their indexes match their page order.
--
-- Generated with `prisma migrate diff` between the two datamodels, so it
-- carries no spurious DROP of activity_records_reporting_entity_period_category_key.

-- CreateIndex
CREATE INDEX "activity_records_subsidiary_id_created_at_id_idx" ON "activity_records"("subsidiary_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "activity_records_created_at_id_idx" ON "activity_records"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "activity_records_status_submitted_at_id_idx" ON "activity_records"("status", "submitted_at", "id");

-- CreateIndex
CREATE INDEX "period_locks_subsidiary_id_created_at_id_idx" ON "period_locks"("subsidiary_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "targets_subsidiary_id_target_year_created_at_id_idx" ON "targets"("subsidiary_id", "target_year", "created_at" DESC, "id" DESC);
