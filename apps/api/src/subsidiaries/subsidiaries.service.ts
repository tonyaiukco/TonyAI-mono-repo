import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SubsidiaryStatus, type Subsidiary } from '@tonyai/db';
import type { SubsidiaryDTO } from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { CreateSubsidiaryDto } from './dto/create-subsidiary.dto';
import { UpdateSubsidiaryDto } from './dto/update-subsidiary.dto';

@Injectable()
export class SubsidiariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private toDTO(s: Subsidiary): SubsidiaryDTO {
    return {
      id: s.id,
      organisationId: s.organisationId,
      legalName: s.legalName,
      tradingName: s.tradingName,
      location: s.location,
      geographyCode: s.geographyCode,
      businessArea: s.businessArea,
      sector: s.sector,
      designatedPerson: s.designatedPerson,
      reportingStatus: s.reportingStatus,
      includedScopes: s.includedScopes,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  private assertCanWrite(user: RequestUser): void {
    if (user.role !== 'super_admin') {
      throw new ForbiddenException('Only super_admin may modify subsidiaries');
    }
    if (!user.organisationId) {
      throw new ForbiddenException('No organisation context for this user');
    }
  }

  async list(user: RequestUser): Promise<SubsidiaryDTO[]> {
    const subs = await this.prisma.subsidiary.findMany({
      where: { id: { in: user.accessibleSubsidiaryIds } },
      orderBy: { createdAt: 'asc' },
    });
    return subs.map((s) => this.toDTO(s));
  }

  async get(user: RequestUser, id: string): Promise<SubsidiaryDTO> {
    // Tenant isolation: ids outside the accessible set are treated as not found.
    if (!user.accessibleSubsidiaryIds.includes(id)) {
      throw new NotFoundException('Subsidiary not found');
    }
    const s = await this.prisma.subsidiary.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Subsidiary not found');
    return this.toDTO(s);
  }

  async create(user: RequestUser, dto: CreateSubsidiaryDto): Promise<SubsidiaryDTO> {
    this.assertCanWrite(user);
    const created = await this.prisma.subsidiary.create({
      data: {
        organisationId: user.organisationId as string,
        legalName: dto.legalName,
        tradingName: dto.tradingName ?? null,
        location: dto.location ?? null,
        geographyCode: dto.geographyCode,
        businessArea: dto.businessArea ?? null,
        sector: dto.sector ?? null,
        designatedPerson: dto.designatedPerson ?? null,
        reportingStatus: (dto.reportingStatus ?? 'pending') as SubsidiaryStatus,
        includedScopes: dto.includedScopes ?? [1, 2],
      },
    });
    await this.audit.record(user, {
      action: 'create',
      entity: 'subsidiary',
      entityId: created.id,
      diff: { after: this.toDTO(created) },
    });
    return this.toDTO(created);
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateSubsidiaryDto,
  ): Promise<SubsidiaryDTO> {
    this.assertCanWrite(user);
    // Tenant check, not just the role check: without it a super_admin of one
    // organisation could update another organisation's subsidiary. 404 (never
    // 403) so the response cannot confirm the row exists — the same rule every
    // other scoped read/write in the API follows.
    const existing = await this.loadScoped(user, id);

    const data: Prisma.SubsidiaryUpdateInput = {};
    if (dto.legalName !== undefined) data.legalName = dto.legalName;
    if (dto.tradingName !== undefined) data.tradingName = dto.tradingName;
    if (dto.location !== undefined) data.location = dto.location;
    if (dto.geographyCode !== undefined) data.geographyCode = dto.geographyCode;
    if (dto.businessArea !== undefined) data.businessArea = dto.businessArea;
    if (dto.sector !== undefined) data.sector = dto.sector;
    if (dto.designatedPerson !== undefined) data.designatedPerson = dto.designatedPerson;
    if (dto.reportingStatus !== undefined) {
      data.reportingStatus = dto.reportingStatus as SubsidiaryStatus;
    }
    if (dto.includedScopes !== undefined) data.includedScopes = dto.includedScopes;

    const updated = await this.prisma.subsidiary.update({ where: { id }, data });
    await this.audit.record(user, {
      action: 'update',
      entity: 'subsidiary',
      entityId: id,
      diff: { before: this.toDTO(existing), after: this.toDTO(updated) },
    });
    return this.toDTO(updated);
  }

  async remove(user: RequestUser, id: string): Promise<{ id: string; deleted: true }> {
    this.assertCanWrite(user);
    const existing = await this.loadScoped(user, id);
    // Delete + audit in one transaction: the row is gone afterwards, so a
    // failed audit insert would leave a deletion with no trail at all.
    await this.prisma.$transaction(async (tx) => {
      await tx.subsidiary.delete({ where: { id } });
      await this.audit.record(
        user,
        { action: 'delete', entity: 'subsidiary', entityId: id, diff: { before: this.toDTO(existing) } },
        tx,
      );
    });
    return { id, deleted: true };
  }

  /**
   * Load a subsidiary the caller is entitled to see. Out-of-set ids 404 rather
   * than 403 so the response never confirms that a row exists in another
   * tenant (the project-wide rule, documented in permissions_and_roles.md §6.2).
   */
  private async loadScoped(user: RequestUser, id: string): Promise<Subsidiary> {
    if (!user.accessibleSubsidiaryIds.includes(id)) {
      throw new NotFoundException('Subsidiary not found');
    }
    const row = await this.prisma.subsidiary.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Subsidiary not found');
    return row;
  }
}
