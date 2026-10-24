import { Module } from '@nestjs/common';
import { PdfRendererModule } from '../common/pdf-renderer.module';
import { StorageModule } from '../storage/storage.module';
import { IssuancePreviewController, ReportIssuancesController } from './report-issuances.controller';
import { ReportIssuancesService } from './report-issuances.service';

/** LP3-04 PR D: the issuance — the final gate, the retained PDF and its recovery. */
@Module({
  // The replica's one PdfRenderer (one Chromium, shared with the report
  // exports); StorageModule for the bucket and its intents.
  imports: [PdfRendererModule, StorageModule],
  controllers: [ReportIssuancesController, IssuancePreviewController],
  providers: [ReportIssuancesService],
})
export class ReportIssuancesModule {}
