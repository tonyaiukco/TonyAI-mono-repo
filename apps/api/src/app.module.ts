import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
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
import { BulkUploadModule } from './bulk-upload/bulk-upload.module';
import { HealthController } from './health.controller';
import { RequestContextMiddleware } from './observability/request-context.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Configured globally because the module has to be, but its guard is NOT
    // an APP_GUARD: only the bulk-upload controller opts in with
    // `@UseGuards(ThrottlerGuard)`. WP9 owns global rate-limit tuning, and
    // turning it on everywhere as a side effect of WP8 would pre-empt it.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }]),
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
    BulkUploadModule,
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
