import { Module } from '@nestjs/common';
import { EmissionsController } from './emissions.controller';
import { EmissionsService } from './emissions.service';

@Module({
  controllers: [EmissionsController],
  providers: [EmissionsService],
  exports: [EmissionsService], // reused by TargetsModule for progress computation
})
export class EmissionsModule {}
