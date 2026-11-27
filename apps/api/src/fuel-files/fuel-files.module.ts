import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { ActivityRecordsModule } from '../activity-records/activity-records.module';
import { FuelBatchFormationService } from '../fuel-batches/fuel-batch-formation.service';
import { FuelBatchesController } from '../fuel-batches/fuel-batches.controller';
import { FuelBatchesService } from '../fuel-batches/fuel-batches.service';
import { FuelAccountsController } from '../fuel-accounts/fuel-accounts.controller';
import { FuelAccountsService } from '../fuel-accounts/fuel-accounts.service';
import { FuelFilesController } from './fuel-files.controller';
import { FuelFilesService } from './fuel-files.service';
import { FuelUploadsService } from './fuel-uploads.service';

/** The fuel bulk upload (inc28-fuel-bulk): files, uploads and their rows, accounts. */
@Module({
  imports: [AuditModule, ActivityRecordsModule, EvidenceModule],
  controllers: [FuelFilesController, FuelAccountsController, FuelBatchesController],
  providers: [FuelFilesService, FuelUploadsService, FuelAccountsService, FuelBatchFormationService, FuelBatchesService],
  exports: [FuelUploadsService, FuelAccountsService],
})
export class FuelFilesModule {}
