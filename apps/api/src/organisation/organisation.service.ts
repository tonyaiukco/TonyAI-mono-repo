import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { can, type OrganisationDTO } from '@tonyai/shared-types';
import type { Organisation } from '@tonyai/db';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { errorBody } from '../common/api-error';

/** No organisation to read: the generic 404, which names nothing. */
const noOrganisation = () => new NotFoundException(errorBody('not_found', 'Organisation not found'));
import { PrismaService } from '../prisma/prisma.service';
import { UpdateConsolidationApproachDto } from './dto/update-consolidation-approach.dto';

/**
 * The caller's own organisation (inc26-group-tree, design D8): what every
 * signed-in member reads, and its one consolidation approach (INC-2.6 §3,
 * RD4), set by the masterkey alone and audited on every change. Never another
 * organisation's: the only id read is the caller's own.
 */
@Injectable()
export class OrganisationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private static toDTO(o: Pick<Organisation, 'id' | 'legalName' | 'tradingName' | 'consolidationApproach'>): OrganisationDTO {
    return {
      id: o.id,
      legalName: o.legalName,
      tradingName: o.tradingName,
      consolidationApproach: o.consolidationApproach,
    };
  }

  async get(user: RequestUser): Promise<OrganisationDTO> {
    if (!user.organisationId) throw noOrganisation();
    const organisation = await this.prisma.organisation.findUnique({ where: { id: user.organisationId } });
    if (!organisation) throw noOrganisation();
    return OrganisationService.toDTO(organisation);
  }

  /** One audit row holding the earlier and the new approach; nothing changed writes nothing. */
  async setConsolidationApproach(user: RequestUser, dto: UpdateConsolidationApproachDto): Promise<OrganisationDTO> {
    if (!can(user.role, 'consolidation.write')) {
      throw new ForbiddenException('Only a masterkey sets the consolidation approach');
    }
    const organisationId = user.organisationId;
    if (!organisationId) throw new ForbiddenException('No organisation context for this user');
    return this.prisma.$transaction(async (tx) => {
      // Locked, so two masterkeys changing it at once audit the value each replaced.
      await tx.$queryRaw`SELECT id FROM organisations WHERE id = ${organisationId}::uuid FOR UPDATE`;
      const before = await tx.organisation.findUnique({ where: { id: organisationId } });
      if (!before) throw noOrganisation();
      if (before.consolidationApproach === dto.consolidationApproach) return OrganisationService.toDTO(before);
      const after = await tx.organisation.update({
        where: { id: organisationId },
        data: { consolidationApproach: dto.consolidationApproach },
      });
      await this.audit.record(
        user,
        {
          action: 'update',
          entity: 'organisation',
          entityId: organisationId,
          diff: {
            before: { consolidationApproach: before.consolidationApproach },
            after: { consolidationApproach: after.consolidationApproach },
          },
        },
        tx,
      );
      return OrganisationService.toDTO(after);
    });
  }
}
