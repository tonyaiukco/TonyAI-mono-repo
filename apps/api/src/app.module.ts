import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
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
import { TargetsModule } from './targets/targets.module';
import { IntensityModule } from './intensity/intensity.module';
import { ReportsModule } from './reports/reports.module';
import { HealthController } from './health.controller';
import { RequestContextMiddleware } from './observability/request-context.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuditModule,
    AuthModule,
    SubsidiariesModule,
    KpiModule,
    CalculationsModule,
    ActivityRecordsModule,
    EmissionsModule,
    LocationsModule,
    EvidenceModule,
    PeriodLocksModule,
    TargetsModule,
    IntensityModule,
    ReportsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: SupabaseAuthGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Middleware (not an interceptor) so the AsyncLocalStorage request context
    // wraps guards, the handler and the exception filter alike.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
