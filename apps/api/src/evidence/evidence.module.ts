import { Module } from '@nestjs/common';
import { EvidenceController } from './evidence.controller';
import { EvidenceService } from './evidence.service';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [EvidenceController],
  providers: [EvidenceService],
  // Exported for activity-records: deleting a record cascades its evidence
  // LINKS away inside Postgres, and a file left with no links has to be
  // deleted — row and blob — by the one service that knows the bucket.
  exports: [EvidenceService],
})
export class EvidenceModule {}
