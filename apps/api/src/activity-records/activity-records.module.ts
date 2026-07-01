import { Module } from '@nestjs/common';
import { CalculationsModule } from '../calculations/calculations.module';
import { ActivityRecordsController } from './activity-records.controller';
import { ActivityRecordsService } from './activity-records.service';

@Module({
  imports: [CalculationsModule],
  controllers: [ActivityRecordsController],
  providers: [ActivityRecordsService],
})
export class ActivityRecordsModule {}
