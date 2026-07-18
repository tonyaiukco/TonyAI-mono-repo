import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type SubsidiaryDenominator } from '@tonyai/db';
import type {
  DenominatorDTO,
  IntensityMetricKey,
  IntensityMetricResultDTO,
  IntensityResponseDTO,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { EmissionsService } from '../emissions/emissions.service';
import { CreateDenominatorDto } from './dto/create-denominator.dto';
import { UpdateDenominatorDto } from './dto/update-denominator.dto';

@Injectable()
export class IntensityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emissions: EmissionsService,
  ) {}

  private toDTO(d: SubsidiaryDenominator): DenominatorDTO {
    return {
      id: d.id,
      subsidiaryId: d.subsidiaryId,
      year: d.year,
      metric: d.metric as IntensityMetricKey,
      value: d.value,
      unit: d.unit,
      createdBy: d.createdBy,
      createdAt: d.createdAt.toISOString(),
    };
  }

  /** Denominators are org configuration — super_admin only (perm §5.3). */
  private assertCanManage(user: RequestUser): void {
    if (user.role !== 'super_admin') {
      throw new ForbiddenException('Only super_admin may manage intensity denominators');
    }
  }

  private scopeIds(user: RequestUser, subsidiaryId?: string): string[] {
    if (subsidiaryId) {
      return user.accessibleSubsidiaryIds.includes(subsidiaryId)
        ? [subsidiaryId]
        : [];
    }
    return user.accessibleSubsidiaryIds;
  }

  // --- Denominator CRUD -----------------------------------------------------

  async listDenominators(
    user: RequestUser,
    subsidiaryId?: string,
    year?: number,
  ): Promise<DenominatorDTO[]> {
    const ids = this.scopeIds(user, subsidiaryId);
    if (ids.length === 0) return [];
    const rows = await this.prisma.subsidiaryDenominator.findMany({
      where: { subsidiaryId: { in: ids }, year },
      orderBy: [{ year: 'desc' }, { metric: 'asc' }],
    });
    return rows.map((d) => this.toDTO(d));
  }

  async createDenominator(
    user: RequestUser,
    dto: CreateDenominatorDto,
  ): Promise<DenominatorDTO> {
    this.assertCanManage(user);
    if (!user.accessibleSubsidiaryIds.includes(dto.subsidiaryId)) {
      throw new NotFoundException('Subsidiary not found');
    }
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.subsidiaryDenominator.create({
          data: {
            subsidiaryId: dto.subsidiaryId,
            year: dto.year,
            metric: dto.metric,
            value: dto.value,
            unit: dto.unit,
            createdBy: user.id,
          },
        });
        await this.audit(tx, user.id, 'create', row.id, {
          denominator: this.toDTO(row),
        });
        return row;
      });
      return this.toDTO(created);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          'A denominator for this subsidiary, year and metric already exists.',
        );
      }
      throw e;
    }
  }

  async updateDenominator(
    user: RequestUser,
    id: string,
    dto: UpdateDenominatorDto,
  ): Promise<DenominatorDTO> {
    this.assertCanManage(user);
    const existing = await this.prisma.subsidiaryDenominator.findUnique({
      where: { id },
    });
    if (
      !existing ||
      !user.accessibleSubsidiaryIds.includes(existing.subsidiaryId)
    ) {
      throw new NotFoundException('Denominator not found');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.subsidiaryDenominator.update({
        where: { id },
        data: { value: dto.value, unit: dto.unit },
      });
      await this.audit(tx, user.id, 'update', row.id, {
        before: this.toDTO(existing),
        after: this.toDTO(row),
      });
      return row;
    });
    return this.toDTO(updated);
  }

  async removeDenominator(
    user: RequestUser,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    this.assertCanManage(user);
    const existing = await this.prisma.subsidiaryDenominator.findUnique({
      where: { id },
    });
    if (
      !existing ||
      !user.accessibleSubsidiaryIds.includes(existing.subsidiaryId)
    ) {
      throw new NotFoundException('Denominator not found');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.subsidiaryDenominator.delete({ where: { id } });
      await this.audit(tx, user.id, 'delete', id, {
        denominator: this.toDTO(existing),
      });
    });
    return { id, deleted: true };
  }

  // --- Intensity computation ------------------------------------------------

  /**
   * Emissions intensity for a year: per configured metric, divide the emissions
   * of the subsidiaries that HAVE that denominator by the sum of those
   * denominators (honest — a metric only appears when it is configured, and its
   * emissions numerator is scoped to exactly those subsidiaries). Returns no
   * metrics when nothing is configured, so the Absolute/Intensity toggle stays
   * gated (emissions_page.md §2: "only valid configured metrics should be shown").
   */
  async intensity(
    user: RequestUser,
    year?: number,
    subsidiaryId?: string,
  ): Promise<IntensityResponseDTO> {
    const ids = this.scopeIds(user, subsidiaryId);
    if (ids.length === 0 || year === undefined) {
      return { year: year ?? null, metrics: [] };
    }

    const denoms = await this.prisma.subsidiaryDenominator.findMany({
      where: { subsidiaryId: { in: ids }, year },
    });
    if (denoms.length === 0) return { year, metrics: [] };

    // Group by metric AND unit — summing different units for the same metric
    // (e.g. "M EUR" + "M USD") would produce a meaningless intensity, so mixed
    // units become separate honest entries rather than one wrong number.
    const byMetricUnit = new Map<
      string,
      { metric: string; unit: string; denominatorTotal: number; subIds: Set<string> }
    >();
    for (const d of denoms) {
      const key = `${d.metric}|${d.unit}`;
      const e = byMetricUnit.get(key) ?? {
        metric: d.metric,
        unit: d.unit,
        denominatorTotal: 0,
        subIds: new Set<string>(),
      };
      e.denominatorTotal += d.value;
      e.subIds.add(d.subsidiaryId);
      byMetricUnit.set(key, e);
    }

    const metrics: IntensityMetricResultDTO[] = [];
    for (const e of byMetricUnit.values()) {
      // Emissions numerator: only the subsidiaries that have this denominator.
      let emissionsTotal = 0;
      for (const sid of e.subIds) {
        const summary = await this.emissions.summary(user, {
          subsidiaryId: sid,
          year,
        });
        emissionsTotal += summary.totals.total;
      }
      metrics.push({
        metric: e.metric as IntensityMetricKey,
        unit: e.unit,
        emissionsTotal,
        denominatorTotal: e.denominatorTotal,
        intensity:
          e.denominatorTotal > 0 ? emissionsTotal / e.denominatorTotal : 0,
      });
    }
    return { year, metrics };
  }

  private async audit(
    tx: Prisma.TransactionClient,
    userId: string,
    action: string,
    entityId: string,
    diff: unknown,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        userId,
        action,
        entity: 'denominator',
        entityId,
        diff: diff as Prisma.InputJsonValue,
      },
    });
  }
}
