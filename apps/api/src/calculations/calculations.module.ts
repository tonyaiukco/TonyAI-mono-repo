import { Module } from '@nestjs/common';
import { CalculationsController } from './calculations.controller';
import { CalculationsService } from './calculations.service';

@Module({
  controllers: [CalculationsController],
  providers: [CalculationsService],
})
export class CalculationsModule {}
