import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

/**
 * Global so every feature module can inject `AuditService` without importing
 * this module — the same shape `PrismaModule` uses. The read API (the
 * audit-trail viewer) is added here in the next PR.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
