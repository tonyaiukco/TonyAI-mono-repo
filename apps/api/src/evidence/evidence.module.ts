import { Module } from '@nestjs/common';
import { EvidenceController } from './evidence.controller';
import { EvidenceService } from './evidence.service';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [EvidenceController],
  providers: [EvidenceService],
  // Exported for activity-records: deleting a record cascades its evidence rows
  // away inside Postgres, so the blobs have to be reclaimed by the one service
  // that knows the bucket, before the row goes.
  exports: [EvidenceService],
})
export class EvidenceModule {}
