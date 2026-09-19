import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * NOT global: a module that injects `StorageService` must import this one
 * (evidence and bulk-upload do). Nest reports a missing import only at boot.
 */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
