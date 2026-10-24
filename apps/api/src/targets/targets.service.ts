import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { errorBody, ResourceNotFoundError } from '../common/api-error';
import { ActivityRecordStatus, Prisma, type Target } from '@tonyai/db';
import { COUNTED_STATUSES as SHARED_COUNTED_STATUSES } from '@tonyai/shared-types';
import type {
  CursorPage,
  EmissionsScope,
  EmissionsSummary,
  TargetBasis,
  TargetDTO,
  TargetProgressDTO,
  TargetStatus,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { EmissionsService } from '../emissions/emissions.service';
import { CreateTargetDto } from './dto/create-target.dto';
import { UpdateTargetDto } from './dto/update-target.dto';
import { TargetPageQueryDto, TargetProgressQueryDto } from './dto/target-page-query.dto';
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

/** GET /targets: by target year, then newest first, the id breaking ties. */
export const TARGET_SORT: KeysetSort = {
  endpoint: 'targets',
  table: 'targets',
  name: 'default',
  keys: [
    { field: 'targetYear', kind: 'int', direction: 'asc' },
    { field: 'createdAt', kind: 'timestamp3', direction: 'desc' },
    { field: 'id', kind: 'uuid', direction: 'desc' },
  ],
};

// Statuses that count as "committed" emissions (mirrors EmissionsService).
// The SAME list the dashboard counts, not a second copy of it. This was a
// standalone literal; a status added to one and forgotten in the other would
// have a target reporting progress against a different number from the
// dashboard showing that progress.
const COMMITTED_STATUSES: ActivityRecordStatus[] = [...SHARED_COUNTED_STATUSES];

// Target scope filter → the numeric scope the emissions summary understands.
const SCOPE_TO_NUMBER: Record<EmissionsScope, number | undefined> = {
  all: undefined,
  scope1: 1,
  scope2: 2,
  scope3: 3,
};

@Injectable()
export class TargetsService {
  private readonly limits = readRuntimeConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly emissions: EmissionsService,
    private readonly audit: AuditService,
  ) {}

  private toDTO(t: Target): TargetDTO {
    const reductionPercent =
      t.baselineTCo2e > 0
        ? ((t.baselineTCo2e - t.targetTCo2e) / t.baselineTCo2e) * 100
        : 0;
    return {
      id: t.id,
      subsidiaryId: t.subsidiaryId,
      name: t.name,
      basis: t.basis as TargetBasis,
      scope: t.scope as EmissionsScope,
      baselineYear: t.baselineYear,
      baselineTCo2e: t.baselineTCo2e,
      targetYear: t.targetYear,
      targetTCo2e: t.targetTCo2e,
      reductionPercent,
      createdBy: t.createdBy,
      createdAt: t.createdAt.toISOString(),
    };
  }

  /** Targets are org configuration — super_admin only (perm §5.3). */
  private assertCanManage(user: RequestUser): void {
    if (user.role !== 'super_admin') {
      throw new ForbiddenException('Only super_admin may manage targets');
    }
  }

  private assertCoherent(
    baselineYear: number,
    targetYear: number,
    baselineTCo2e: number,
    targetTCo2e: number,
  ): void {
    if (targetYear <= baselineYear) {
      throw new BadRequestException(errorBody('target_year_order', 'targetYear must be after baselineYear'));
    }
    if (targetTCo2e >= baselineTCo2e) {
      throw new BadRequestException(
        errorBody(
          'target_not_reduction',
          'targetTCo2e must be below baselineTCo2e (a target is a strict reduction)',
        ),
      );
    }
  }

  /** One `CursorPage` of the caller's targets, inside their current access. */
  async listPage(user: RequestUser, query: TargetPageQueryDto): Promise<CursorPage<TargetDTO>> {
    const limit = pageLimit(query.limit);
    const binding = cursorBinding(TARGET_SORT, { subsidiaryId: query.subsidiaryId });
    const after = query.cursor !== undefined ? decodeCursor(TARGET_SORT, binding, query.cursor) : null;
    const subsidiaryIds = scopedSubsidiaryIds(user, query.subsidiaryId);
    if (subsidiaryIds.length === 0) return { items: [], limit, nextCursor: null };
    const where: Prisma.TargetWhereInput = { subsidiaryId: { in: subsidiaryIds } };
    const rows = await this.prisma.target.findMany({
      where: after ? { AND: [where, keysetWhere(TARGET_SORT, after) as Prisma.TargetWhereInput] } : where,
      orderBy: keysetOrderBy(TARGET_SORT) as Prisma.TargetOrderByWithRelationInput[],
      take: limit + 1,
    });
    return toCursorPage(rows, limit, TARGET_SORT, binding, (t) => [t.targetYear, t.createdAt, t.id], (t) => this.toDTO(t));
  }

  async create(user: RequestUser, dto: CreateTargetDto): Promise<TargetDTO> {
    this.assertCanManage(user);
    if (!user.accessibleSubsidiaryIds.includes(dto.subsidiaryId)) {
      throw new ResourceNotFoundError('subsidiary_not_found');
    }
    this.assertCoherent(
      dto.baselineYear,
      dto.targetYear,
      dto.baselineTCo2e,
      dto.targetTCo2e,
    );

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.target.create({
        data: {
          subsidiaryId: dto.subsidiaryId,
          name: dto.name,
          basis: dto.basis,
          scope: dto.scope,
          baselineYear: dto.baselineYear,
          baselineTCo2e: dto.baselineTCo2e,
          targetYear: dto.targetYear,
          targetTCo2e: dto.targetTCo2e,
          createdBy: user.id,
        },
      });
      await this.audit.record(
        user,
        { action: 'create', entity: 'target', entityId: row.id, diff: { target: this.toDTO(row) } },
        tx,
      );
      return row;
    });
    return this.toDTO(created);
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateTargetDto,
  ): Promise<TargetDTO> {
    this.assertCanManage(user);
    const existing = await this.prisma.target.findUnique({ where: { id } });
    if (
      !existing ||
      !user.accessibleSubsidiaryIds.includes(existing.subsidiaryId)
    ) {
      throw new ResourceNotFoundError('target_not_found');
    }
    this.assertCoherent(
      dto.baselineYear ?? existing.baselineYear,
      dto.targetYear ?? existing.targetYear,
      dto.baselineTCo2e ?? existing.baselineTCo2e,
      dto.targetTCo2e ?? existing.targetTCo2e,
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.target.update({
        where: { id },
        data: {
          name: dto.name,
          basis: dto.basis,
          scope: dto.scope,
          baselineYear: dto.baselineYear,
          baselineTCo2e: dto.baselineTCo2e,
          targetYear: dto.targetYear,
          targetTCo2e: dto.targetTCo2e,
        },
      });
      await this.audit.record(
        user,
        {
          action: 'update',
          entity: 'target',
          entityId: row.id,
          diff: { before: this.toDTO(existing), after: this.toDTO(row) },
        },
        tx,
      );
      return row;
    });
    return this.toDTO(updated);
  }

  async remove(
    user: RequestUser,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    this.assertCanManage(user);
    const existing = await this.prisma.target.findUnique({ where: { id } });
    if (
      !existing ||
      !user.accessibleSubsidiaryIds.includes(existing.subsidiaryId)
    ) {
      throw new ResourceNotFoundError('target_not_found');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.target.delete({ where: { id } });
      await this.audit.record(
        user,
        { action: 'delete', entity: 'target', entityId: id, diff: { target: this.toDTO(existing) } },
        tx,
      );
    });
    return { id, deleted: true };
  }

  /**
   * Live progress for an explicit set of targets — never every target: one
   * page of ids, answered in request order, a missing id and another tenant's
   * omitted alike. Batched: one query for every target's latest committed year
   * (per subsidiary and scope), and one bounded summary per distinct
   * subsidiary, year and scope — computed one at a time, so a page of a
   * hundred holds one pooled connection, not a hundred.
   */
  async progress(user: RequestUser, query: TargetProgressQueryDto): Promise<TargetProgressDTO[]> {
    if (user.accessibleSubsidiaryIds.length === 0) return [];
    const rows = await this.prisma.target.findMany({
      where: { id: { in: query.targetIds }, subsidiaryId: { in: [...user.accessibleSubsidiaryIds] } },
    });
    if (rows.length === 0) return [];
    const years = await this.prisma.activityRecord.groupBy({
      by: ['subsidiaryId', 'scope'],
      where: { subsidiaryId: { in: [...new Set(rows.map((t) => t.subsidiaryId))] }, status: { in: COMMITTED_STATUSES } },
      _max: { reportingYear: true },
    });
    // The latest committed year of a subsidiary's records in one scope, or in
    // every scope for an 'all' target.
    const latestYear = (subsidiaryId: string, scope: number | undefined): number | null =>
      years
        .filter((g) => g.subsidiaryId === subsidiaryId && (scope === undefined || g.scope === scope))
        .reduce<number | null>((max, g) => {
          const year = g._max.reportingYear;
          return year !== null && (max === null || year > max) ? year : max;
        }, null);
    const summaries = new Map<string, EmissionsSummary>();
    const summaryOf = async (subsidiaryId: string, year: number, scope: number | undefined) => {
      const key = `${subsidiaryId}|${year}|${scope ?? 'all'}`;
      let summary = summaries.get(key);
      if (!summary) {
        // Bounded like a report's: a year past the budget is 422
        // query_too_broad for the whole answer, never a figure from part of it.
        summary = await this.emissions.summary(user, { subsidiaryId, year, scope }, this.limits.REPORT_RECORD_LIMIT);
        summaries.set(key, summary);
      }
      return summary;
    };
    const byId = new Map(rows.map((t) => [t.id, t]));
    const progress: TargetProgressDTO[] = [];
    for (const id of query.targetIds) {
      const target = byId.get(id);
      if (!target) continue;
      const dto = this.toDTO(target);
      const scope = SCOPE_TO_NUMBER[dto.scope];
      progress.push(await this.progressForTarget(dto, latestYear(dto.subsidiaryId, scope), (year) => summaryOf(dto.subsidiaryId, year, scope)));
    }
    return progress;
  }

  /**
   * Compute progress from committed emissions. `baselineTCo2e` is the declared
   * baseline stored on the target (not recomputed). "Current" = the most recent
   * committed year strictly AFTER the baseline year; if none exists yet, progress
   * is `null` (honest "n/a", never a placeholder 0%). Formula mirrors the design
   * reference (actualReduction / neededReduction), clamped 0-100.
   */
  private async progressForTarget(
    t: TargetDTO,
    latestCommittedYear: number | null,
    summaryFor: (year: number) => Promise<EmissionsSummary>,
  ): Promise<TargetProgressDTO> {
    // The current year comes from records IN THE TARGET'S SCOPE (an 'all'
    // target reads every scope). Without that a scoped target could resolve to
    // a year that only has other-scope data and then report a fabricated
    // 0 tCO₂e / 100% "on track" — a placeholder value. The latest committed
    // year after the baseline is the latest committed year, when that is
    // after the baseline at all.
    const latest =
      latestCommittedYear !== null && latestCommittedYear > t.baselineYear ? { reportingYear: latestCommittedYear } : null;
    if (!latest) {
      return {
        targetId: t.id,
        currentYear: t.baselineYear,
        currentTCo2e: null,
        progressPercent: null,
        status: null,
      };
    }

    const summary = await summaryFor(latest.reportingYear);

    // The scope filter above answers "are there records in this scope?", which
    // stopped being the same question as "is there anything to compare?" once a
    // record could exist without a figure. A single factor-less Water invoice
    // (scope 3) satisfies the query, contributes nothing to the total, and the
    // arithmetic below then reports 0 tCO₂e → 100% → "on_track" against a
    // declared baseline: exactly the fabricated placeholder the guard above was
    // written to prevent, reached through a new door.
    if (summary.calculatedRecordCount === 0) {
      return {
        targetId: t.id,
        currentYear: t.baselineYear,
        currentTCo2e: null,
        progressPercent: null,
        status: null,
      };
    }

    const current = summary.totals.total;

    const neededReduction = t.baselineTCo2e - t.targetTCo2e;
    const actualReduction = t.baselineTCo2e - current;
    const raw = neededReduction > 0 ? (actualReduction / neededReduction) * 100 : 0;
    const status: TargetStatus =
      raw < 50 ? 'off_track' : raw < 80 ? 'at_risk' : 'on_track';

    return {
      targetId: t.id,
      currentYear: latest.reportingYear,
      currentTCo2e: current,
      progressPercent: Math.min(100, Math.max(0, raw)),
      status,
    };
  }

}
