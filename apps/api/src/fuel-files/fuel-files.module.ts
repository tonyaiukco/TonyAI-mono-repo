import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ActivityRecordsModule } from '../activity-records/activity-records.module';
import { FuelBatchFormationService } from '../fuel-batches/fuel-batch-formation.service';
import { FuelAccountsController } from '../fuel-accounts/fuel-accounts.controller';
import { FuelAccountsService } from '../fuel-accounts/fuel-accounts.service';
import { FuelFilesController } from './fuel-files.controller';
import { FuelFilesService } from './fuel-files.service';
import { FuelUploadsService } from './fuel-uploads.service';

/** The fuel bulk upload (inc28-fuel-bulk): files, uploads and their rows, accounts. */
@Module({
  imports: [AuditModule, ActivityRecordsModule],
  controllers: [FuelFilesController, FuelAccountsController],
  providers: [FuelFilesService, FuelUploadsService, FuelAccountsService, FuelBatchFormationService],
  exports: [FuelUploadsService, FuelAccountsService],
})
export class FuelFilesModule {}
