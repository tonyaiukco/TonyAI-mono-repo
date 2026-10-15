import { Module } from '@nestjs/common';
import { ReportDatasetsController } from './report-datasets.controller';
import { ReportDatasetsService } from './report-datasets.service';

/** LP3-04 PR C: the report dataset's capture and retained reads (V1–V12). */
@Module({
  controllers: [ReportDatasetsController],
  providers: [ReportDatasetsService],
})
export class ReportDatasetsModule {}
