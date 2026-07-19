import { Module } from '@nestjs/common';
import { EmissionsModule } from '../emissions/emissions.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [EmissionsModule], // ReportsService reuses EmissionsService.summary
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
