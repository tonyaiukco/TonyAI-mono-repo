import { Module } from '@nestjs/common';
import { EmissionsModule } from '../emissions/emissions.module';
import { TargetsController } from './targets.controller';
import { TargetsService } from './targets.service';

@Module({
  imports: [EmissionsModule], // TargetsService reuses EmissionsService.summary
  controllers: [TargetsController],
  providers: [TargetsService],
})
export class TargetsModule {}
