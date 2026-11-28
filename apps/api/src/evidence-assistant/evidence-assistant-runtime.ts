import { Inject, Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import {
  EVIDENCE_ASSISTANT_CONFIG,
  readEvidenceAssistantConfig,
  type EvidenceAssistantConfig,
} from './evidence-assistant-config';
import { PdfReaderService } from './pdf-reader.service';

/**
 * The assistant's settings as this process runs them, and its reader's start:
 * on, the reader proves its isolation once at boot (in the background — the
 * API answers meanwhile and stores files unread until it has); off, no reader
 * process is ever started.
 */
@Injectable()
export class EvidenceAssistantRuntime implements OnModuleInit {
  readonly config: EvidenceAssistantConfig;

  constructor(
    readonly reader: PdfReaderService,
    @Optional() @Inject(EVIDENCE_ASSISTANT_CONFIG) config?: EvidenceAssistantConfig,
  ) {
    this.config = config ?? readEvidenceAssistantConfig();
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  onModuleInit(): void {
    if (this.config.enabled) void this.reader.start();
  }
}
