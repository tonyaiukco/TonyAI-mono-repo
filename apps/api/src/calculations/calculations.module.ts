import { Module } from '@nestjs/common';
import { CalculationsController } from './calculations.controller';
import { CalculationsService } from './calculations.service';
import { FACTOR_POLICY, bootFactorPolicy } from './factor-policy';

@Module({
  controllers: [CalculationsController],
  providers: [
    CalculationsService,
    // The one policy object, computed at boot (`main.ts`) — never per request.
    { provide: FACTOR_POLICY, useFactory: bootFactorPolicy },
  ],
  exports: [CalculationsService],
})
export class CalculationsModule {}
