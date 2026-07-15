import { Module } from '@nestjs/common';
import { PeriodLocksController } from './period-locks.controller';
import { PeriodLocksService } from './period-locks.service';

@Module({
  controllers: [PeriodLocksController],
  providers: [PeriodLocksService],
})
export class PeriodLocksModule {}
