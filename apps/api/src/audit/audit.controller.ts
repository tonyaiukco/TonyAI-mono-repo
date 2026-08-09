import { Controller, Get, Query } from '@nestjs/common';
import type { AuditLogDTO, Paginated } from '@tonyai/shared-types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from './audit.service';
import { ListAuditQueryDto } from './dto/list-audit-query.dto';

/**
 * Read-only by design: `audit_log` is append-only (CLAUDE.md), there is no
 * UPDATE/DELETE RLS policy, and the write privileges were revoked from the
 * client roles in the WP7 migration. This controller therefore exposes exactly
 * one verb — adding a mutating route here would break the immutability the
 * whole table exists for.
 */
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query() query: ListAuditQueryDto,
  ): Promise<Paginated<AuditLogDTO>> {
    return this.audit.list(user, query);
  }
}
