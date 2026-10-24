import { Module } from '@nestjs/common';
import { PdfRendererModule } from '../common/pdf-renderer.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  // ReportsService sums its own snapshot's rows (`summariseCounted`, LP4-03
  // K2) and prints on the replica's one Chromium — shared with the issuances.
  imports: [PdfRendererModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
