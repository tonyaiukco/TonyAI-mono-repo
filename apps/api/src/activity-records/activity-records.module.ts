import { Module } from '@nestjs/common';
import { CalculationsModule } from '../calculations/calculations.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { ActivityRecordsController } from './activity-records.controller';
import { ActivityRecordsService } from './activity-records.service';

@Module({
  imports: [CalculationsModule, EvidenceModule],
  controllers: [ActivityRecordsController],
  providers: [ActivityRecordsService],
  // Exported for the bulk importer (WP8), which creates records one at a time
  // through this service rather than bulk-upserting: every row must get its own
  // factor snapshot, lifecycle gates and audit row, and a bulk write would
  // bypass all three.
  exports: [ActivityRecordsService],
})
export class ActivityRecordsModule {}
