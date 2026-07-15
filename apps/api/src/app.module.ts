import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { SupabaseAuthGuard } from './auth/auth.guard';
import { SubsidiariesModule } from './subsidiaries/subsidiaries.module';
import { KpiModule } from './kpi/kpi.module';
import { CalculationsModule } from './calculations/calculations.module';
import { ActivityRecordsModule } from './activity-records/activity-records.module';
import { EmissionsModule } from './emissions/emissions.module';
import { LocationsModule } from './locations/locations.module';
import { EvidenceModule } from './evidence/evidence.module';
import { PeriodLocksModule } from './period-locks/period-locks.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    SubsidiariesModule,
    KpiModule,
    CalculationsModule,
    ActivityRecordsModule,
    EmissionsModule,
    LocationsModule,
    EvidenceModule,
    PeriodLocksModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: SupabaseAuthGuard }],
})
export class AppModule {}
