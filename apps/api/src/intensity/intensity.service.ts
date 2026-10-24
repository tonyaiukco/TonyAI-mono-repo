import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { errorBody, ResourceNotFoundError } from '../common/api-error';
import { Prisma, type SubsidiaryDenominator } from '@tonyai/db';
import { GROUP_INTENSITY_METRICS } from '@tonyai/shared-types';
import type {
  CursorPage,
  ReportingContext,
  ReportingIntensityResponse,
  ReportingIntensityData,
  ReportingIntensityMetric,
  DenominatorDTO,
  IntensityMetricKey,
  IntensityResponseDTO,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { EmissionsService } from '../emissions/emissions.service';
import { CreateDenominatorDto } from './dto/create-denominator.dto';
import { UpdateDenominatorDto } from './dto/update-denominator.dto';
import { DenominatorPageQueryDto } from './dto/denominator-page-query.dto';
import {
  cursorBinding,
  decodeCursor,
  keysetOrderBy,
  keysetWhere,
  pageLimit,
  toCursorPage,
  type KeysetSort,
} from '../common/keyset-cursor';
import { scopedSubsidiaryIds } from '../common/page-filters';
import { readRuntimeConfig } from '../common/runtime-config';

/** GET /denominators: newest year first, then by metric code, the id breaking ties. */
export const DENOMINATOR_SORT: KeysetSort = {
  endpoint: 'denominators',
  table: 'subsidiary_denominators',
  name: 'default',
  keys: [
    { field: 'year', kind: 'int', direction: 'desc' },
    { field: 'metric', kind: 'text', direction: 'asc' },
    { field: 'id', kind: 'uuid', direction: 'asc' },
  ],
};

const hasSelectedSubsidiary = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

@Injectable()
export class IntensityService {
  private readonly limits = readRuntimeConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly emissions: EmissionsService,
    private readonly audit: AuditService,
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
    if (hasSelectedSubsidiary(subsidiaryId)) {
      return user.accessibleSubsidiaryIds.includes(subsidiaryId)
        ? [subsidiaryId]
        : [];
    }
    return user.accessibleSubsidiaryIds;
  }

  // --- Denominator CRUD -----------------------------------------------------

  /** One `CursorPage` of denominators, inside the caller's current access. */
  async listDenominatorPage(
    user: RequestUser,
    query: DenominatorPageQueryDto,
  ): Promise<CursorPage<DenominatorDTO>> {
    const limit = pageLimit(query.limit);
    const binding = cursorBinding(DENOMINATOR_SORT, { subsidiaryId: query.subsidiaryId, year: query.year });
    const after = query.cursor !== undefined ? decodeCursor(DENOMINATOR_SORT, binding, query.cursor) : null;
    const ids = scopedSubsidiaryIds(user, query.subsidiaryId);
    if (ids.length === 0) return { items: [], limit, nextCursor: null };
    const where: Prisma.SubsidiaryDenominatorWhereInput = {
      subsidiaryId: { in: ids },
      ...(query.year !== undefined ? { year: query.year } : {}),
    };
    const rows = await this.prisma.subsidiaryDenominator.findMany({
      where: after ? { AND: [where, keysetWhere(DENOMINATOR_SORT, after) as Prisma.SubsidiaryDenominatorWhereInput] } : where,
      orderBy: keysetOrderBy(DENOMINATOR_SORT) as Prisma.SubsidiaryDenominatorOrderByWithRelationInput[],
      take: limit + 1,
    });
    return toCursorPage(rows, limit, DENOMINATOR_SORT, binding, (d) => [d.year, d.metric, d.id], (d) => this.toDTO(d));
  }

  async createDenominator(
    user: RequestUser,
    dto: CreateDenominatorDto,
  ): Promise<DenominatorDTO> {
    this.assertCanManage(user);
    if (!user.accessibleSubsidiaryIds.includes(dto.subsidiaryId)) {
      throw new ResourceNotFoundError('subsidiary_not_found');
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
        await this.audit.record(
          user,
          {
            action: 'create',
            entity: 'denominator',
            entityId: row.id,
            diff: { denominator: this.toDTO(row) },
          },
          tx,
        );
        return row;
      });
      return this.toDTO(created);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          errorBody('denominator_duplicate', 'A denominator for this subsidiary, year and metric already exists.'),
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
      throw new ResourceNotFoundError('denominator_not_found');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.subsidiaryDenominator.update({
        where: { id },
        data: { value: dto.value, unit: dto.unit },
      });
      await this.audit.record(
        user,
        {
          action: 'update',
          entity: 'denominator',
          entityId: row.id,
          diff: { before: this.toDTO(existing), after: this.toDTO(row) },
        },
        tx,
      );
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
      throw new ResourceNotFoundError('denominator_not_found');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.subsidiaryDenominator.delete({ where: { id } });
      await this.audit.record(
        user,
        {
          action: 'delete',
          entity: 'denominator',
          entityId: id,
          diff: { denominator: this.toDTO(existing) },
        },
        tx,
      );
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
    if (year === undefined) return { year: null, metrics: [] };
    const data = await this.computeIntensity(user, {
      year,
      ...(hasSelectedSubsidiary(subsidiaryId) ? { subsidiaryId } : {}),
    });
    return {
      year,
      metrics: data.metrics.map(({ metric, unit, emissionsTotal, denominatorTotal, intensity }) =>
        ({ metric, unit, emissionsTotal, denominatorTotal, intensity })),
    };
  }

  async contextIntensity(
    user: RequestUser,
    context: ReportingContext,
  ): Promise<ReportingIntensityResponse> {
    return { context, data: await this.computeIntensity(user, context) };
  }

  private async computeIntensity(
    user: RequestUser,
    context: ReportingContext,
  ): Promise<ReportingIntensityData> {
    const selectedSubsidiaryIds = [...new Set(this.scopeIds(user, context.subsidiaryId))].sort();
    const empty = { selectedSubsidiaryIds, metrics: [] };
    if (selectedSubsidiaryIds.length === 0) return empty;
    const denoms = await this.prisma.subsidiaryDenominator.findMany({
      where: {
        subsidiaryId: { in: selectedSubsidiaryIds },
        year: context.year,
        ...(!hasSelectedSubsidiary(context.subsidiaryId) ? { metric: { in: [...GROUP_INTENSITY_METRICS] } } : {}),
      },
      orderBy: [{ metric: 'asc' }, { unit: 'asc' }, { subsidiaryId: 'asc' }],
    });
    if (denoms.length === 0) return empty;

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

    // One summary per subsidiary, however many metrics it has a denominator
    // for, each bounded like a report's (LP4-05 PR C): a subsidiary-year past
    // REPORT_RECORD_LIMIT is 422 query_too_broad for the whole answer, never an
    // intensity computed from part of its records.
    const summaries = new Map<string, Awaited<ReturnType<EmissionsService['summary']>>>();
    const summaryOf = async (sid: string) => {
      let summary = summaries.get(sid);
      if (!summary) {
        summary = await this.emissions.summary(user, { ...context, subsidiaryId: sid }, this.limits.REPORT_RECORD_LIMIT);
        summaries.set(sid, summary);
      }
      return summary;
    };
    const metrics: ReportingIntensityMetric[] = [];
    for (const e of byMetricUnit.values()) {
      // Emissions numerator: only the subsidiaries that have this denominator.
      let emissionsTotal = 0;
      let uncalculatedRecordCount = 0;
      for (const sid of e.subIds) {
        const summary = await summaryOf(sid);
        emissionsTotal += summary.totals.total;
        uncalculatedRecordCount += summary.uncalculatedRecordCount;
      }
      metrics.push({
        contributingSubsidiaryIds: [...e.subIds].sort(),
        uncalculatedRecordCount,
        metric: e.metric as IntensityMetricKey,
        unit: e.unit,
        emissionsTotal,
        denominatorTotal: e.denominatorTotal,
        intensity:
          e.denominatorTotal > 0 ? emissionsTotal / e.denominatorTotal : 0,
      });
    }
    return { selectedSubsidiaryIds, metrics };
  }

}
