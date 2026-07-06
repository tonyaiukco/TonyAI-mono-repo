import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/** Global so any module (evidence, later reports/exports) can inject StorageService. */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
