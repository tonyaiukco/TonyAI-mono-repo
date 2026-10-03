import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { StorageIntentsService } from './storage-intents.service';

/**
 * NOT global: a module that injects `StorageService` must import this one
 * (evidence and bulk-upload do). Nest reports a missing import only at boot.
 * One instance however many modules import it, so `StorageIntentsService`
 * runs one sweeper per process.
 */
@Module({
  providers: [StorageService, StorageIntentsService],
  exports: [StorageService, StorageIntentsService],
})
export class StorageModule {}
