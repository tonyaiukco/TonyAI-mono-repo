import { Module } from '@nestjs/common';
import { OrganisationController } from './organisation.controller';
import { OrganisationService } from './organisation.service';

@Module({
  controllers: [OrganisationController],
  providers: [OrganisationService],
  // Exported for the live reports' methodology text (the stored approach).
  exports: [OrganisationService],
})
export class OrganisationModule {}
