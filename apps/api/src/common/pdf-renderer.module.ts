import { Module } from '@nestjs/common';
import { PdfRenderer } from './pdf-renderer';

/**
 * The replica's one `PdfRenderer` — one Chromium. Imported by the report
 * exports and the issuances; Nest instantiates a module's providers once
 * however many modules import it.
 */
@Module({
  providers: [PdfRenderer],
  exports: [PdfRenderer],
})
export class PdfRendererModule {}
