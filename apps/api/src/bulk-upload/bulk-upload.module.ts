import { Module } from '@nestjs/common';
import { ActivityRecordsModule } from '../activity-records/activity-records.module';
import { AuditModule } from '../audit/audit.module';
import { StorageModule } from '../storage/storage.module';
import { BulkSubmitController } from './bulk-submit.controller';
import { BulkSubmitService } from './bulk-submit.service';
import { BulkUploadController } from './bulk-upload.controller';
import { BulkUploadService } from './bulk-upload.service';
import { ImportBatchesController } from './import-batches.controller';
import { ImportBatchesService } from './import-batches.service';

/**
 * Bulk upload owns one table, `import_batches`: the record of each APPLIED
 * import (the file, who sent it, what came of it), read and submitted through
 * `ImportBatchesController`. Every row it accepts still becomes an ordinary
 * activity record, written one at a time through `ActivityRecordsService` so each gets
 * its own factor snapshot, lifecycle gates and audit row — which is why this
 * module imports that one rather than reaching for Prisma's `createMany`.
 *
 * Bulk SUBMIT lives here too rather than in `activity-records`, for one
 * reason: the batch idiom is all here — the per-record loop that continues
 * past a failure, the exception-to-code mapper, the batch audit row written
 * even on total failure, and the per-user throttle.
 *
 * (An earlier version of this comment also claimed `import-x/no-cycle` forbade
 * the reverse edge. It does not: a bulk-submit service in `activity-records`
 * would need nothing from here but `UserThrottlerGuard`, which imports only
 * `@nestjs/throttler` and the auth types. Cohesion is the whole reason, and it
 * is enough.)
 *
 * Its ROUTE is a separate decision and goes the other way — `BulkSubmitController`
 * serves `/activity-records/bulk-submit`, because the resource is a record,
 * not an upload. `ActivityRecordsService.submit` remains the only place the
 * lifecycle rules live.
 */
@Module({
  imports: [ActivityRecordsModule, AuditModule, StorageModule],
  controllers: [BulkUploadController, BulkSubmitController, ImportBatchesController],
  providers: [BulkUploadService, BulkSubmitService, ImportBatchesService],
})
export class BulkUploadModule {}
