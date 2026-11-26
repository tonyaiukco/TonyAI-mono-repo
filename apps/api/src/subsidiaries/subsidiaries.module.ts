import { Module } from '@nestjs/common';
import { SubsidiariesController } from './subsidiaries.controller';
import { SubsidiariesService } from './subsidiaries.service';
import { LocationsModule } from '../locations/locations.module';
import { AuthModule } from '../auth/auth.module';
import { CalculationsModule } from '../calculations/calculations.module';

@Module({
  // AuthModule: `AccessAdminService`, the only writer of grants (a child
  // company's creator is granted it). CalculationsModule: the factor library's
  // coverage, for the geography rule (inc26-group-tree).
  imports: [LocationsModule, AuthModule, CalculationsModule],
  controllers: [SubsidiariesController],
  providers: [SubsidiariesService],
})
export class SubsidiariesModule {}
