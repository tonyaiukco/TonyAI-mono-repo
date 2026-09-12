import { Module } from '@nestjs/common';
import { ActivityRecordsModule } from '../activity-records/activity-records.module';
import { AuditModule } from '../audit/audit.module';
import { BulkUploadController } from './bulk-upload.controller';
import { BulkUploadService } from './bulk-upload.service';

/**
 * Bulk upload owns no table. Every row it accepts becomes an ordinary activity
 * record, written one at a time through `ActivityRecordsService` so each gets
 * its own factor snapshot, lifecycle gates and audit row — which is why this
 * module imports that one rather than reaching for Prisma's `createMany`.
 */
@Module({
  imports: [ActivityRecordsModule, AuditModule],
  controllers: [BulkUploadController],
  providers: [BulkUploadService],
})
export class BulkUploadModule {}
