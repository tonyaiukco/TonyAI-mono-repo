import { Module } from '@nestjs/common';
import { EmissionsModule } from '../emissions/emissions.module';
import { PdfRendererModule } from '../common/pdf-renderer.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  // ReportsService reuses EmissionsService.summary, and prints on the
  // replica's one Chromium — shared with the issuances (LP3-04 PR D).
  imports: [EmissionsModule, PdfRendererModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
