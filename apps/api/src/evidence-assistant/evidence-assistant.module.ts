import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { EvidenceAssistantRuntime } from './evidence-assistant-runtime';
import { EvidenceAssistantService } from './evidence-assistant.service';
import { PdfReaderService } from './pdf-reader.service';
import { UploadReadingService } from './upload-reading';

/** The evidence assistant (inc29-evidence-assistant): the reader, its settings, the upload's reading and the comparison. */
@Module({
  imports: [StorageModule],
  providers: [PdfReaderService, EvidenceAssistantRuntime, UploadReadingService, EvidenceAssistantService],
  exports: [PdfReaderService, EvidenceAssistantRuntime, UploadReadingService, EvidenceAssistantService],
})
export class EvidenceAssistantModule {}
