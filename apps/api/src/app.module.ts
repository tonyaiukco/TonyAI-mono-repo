import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { RuntimeLimits } from './common/runtime-limits';
import { RuntimeLimitsModule } from './common/runtime-limits.module';
import { SecurityModule } from './security/security.module';
import { RuntimeAuthGuard } from './common/runtime-request';
import { PrismaService } from './prisma/prisma.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { SupabaseAuthGuard } from './auth/auth.guard';
import { OrganisationModule } from './organisation/organisation.module';
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
import { FuelFilesModule } from './fuel-files/fuel-files.module';
import { UsersModule } from './users/users.module';
import { InventoryBoundaryModule } from './inventory-boundary/inventory-boundary.module';
import { ReportDatasetsModule } from './report-datasets/report-datasets.module';
import { ReportIssuancesModule } from './report-issuances/report-issuances.module';
import { HealthController } from './health.controller';
import { RequestContextMiddleware } from './observability/request-context.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    // LP4-05 PR C: the one RuntimeLimits, exported to the modules that need it.
    RuntimeLimitsModule,
    AuditModule,
    AuthModule,
    SubsidiariesModule,
    // inc26-group-tree: the organisation's own read and its consolidation approach.
    OrganisationModule,
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
    FuelFilesModule,
    // LP4-01: onboarding and the user lifecycle (its MailModule with it).
    UsersModule,
    // LP3-04: the inventory boundary's routes (W1, W13).
    InventoryBoundaryModule,
    ReportDatasetsModule,
    ReportIssuancesModule,
    // pre-g5-security-hardening: the web's CSP violation reports.
    SecurityModule,
  ],
  controllers: [HealthController],
  providers: [{
    provide: APP_GUARD,
    inject: [Reflector, PrismaService, RuntimeLimits],
    useFactory: (reflector: Reflector, prisma: PrismaService, limits: RuntimeLimits) =>
      new RuntimeAuthGuard(new SupabaseAuthGuard(reflector, prisma), limits),
  }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Middleware (not an interceptor) so the AsyncLocalStorage request context
    // wraps guards, the handler and the exception filter alike.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
