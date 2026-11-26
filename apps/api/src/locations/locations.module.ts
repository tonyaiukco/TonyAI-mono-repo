import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { CalculationsModule } from '../calculations/calculations.module';

@Module({
  // The factor library's coverage, for the geography rule (inc26-group-tree).
  imports: [CalculationsModule],
  controllers: [LocationsController],
  providers: [LocationsService],
  // Exported for `POST /subsidiaries`, which creates a subsidiary and its
  // locations in one transaction through the shared row writer.
  exports: [LocationsService],
})
export class LocationsModule {}
