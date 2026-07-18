import { Module } from '@nestjs/common';
import { EmissionsModule } from '../emissions/emissions.module';
import { IntensityService } from './intensity.service';
import { DenominatorsController } from './denominators.controller';
import { IntensityController } from './intensity.controller';

@Module({
  imports: [EmissionsModule], // IntensityService reuses EmissionsService.summary
  controllers: [DenominatorsController, IntensityController],
  providers: [IntensityService],
})
export class IntensityModule {}
