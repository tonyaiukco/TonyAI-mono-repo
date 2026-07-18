import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ActivityRecordStatus, Prisma, type Target } from '@tonyai/db';
import type {
  EmissionsScope,
  TargetBasis,
  TargetDTO,
  TargetProgressDTO,
  TargetStatus,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { EmissionsService } from '../emissions/emissions.service';
import { CreateTargetDto } from './dto/create-target.dto';
import { UpdateTargetDto } from './dto/update-target.dto';

// Statuses that count as "committed" emissions (mirrors EmissionsService).
const COMMITTED_STATUSES: ActivityRecordStatus[] = [
  ActivityRecordStatus.submitted,
  ActivityRecordStatus.under_review,
  ActivityRecordStatus.approved,
  ActivityRecordStatus.locked,
];

// Target scope filter → the numeric scope the emissions summary understands.
const SCOPE_TO_NUMBER: Record<EmissionsScope, number | undefined> = {
  all: undefined,
  scope1: 1,
  scope2: 2,
  scope3: 3,
};

@Injectable()
export class TargetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emissions: EmissionsService,
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
      throw new BadRequestException('targetYear must be after baselineYear');
    }
    if (targetTCo2e >= baselineTCo2e) {
      throw new BadRequestException(
        'targetTCo2e must be below baselineTCo2e (a target is a strict reduction)',
      );
    }
  }

  async list(user: RequestUser, subsidiaryId?: string): Promise<TargetDTO[]> {
    let subsidiaryFilter: Prisma.StringFilter | string;
    if (subsidiaryId) {
      if (!user.accessibleSubsidiaryIds.includes(subsidiaryId)) return [];
      subsidiaryFilter = subsidiaryId;
    } else {
      subsidiaryFilter = { in: user.accessibleSubsidiaryIds };
    }
    const rows = await this.prisma.target.findMany({
      where: { subsidiaryId: subsidiaryFilter },
      orderBy: [{ targetYear: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map((t) => this.toDTO(t));
  }

  async create(user: RequestUser, dto: CreateTargetDto): Promise<TargetDTO> {
    this.assertCanManage(user);
    if (!user.accessibleSubsidiaryIds.includes(dto.subsidiaryId)) {
      throw new NotFoundException('Subsidiary not found');
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
      await this.audit(tx, user.id, 'create', row.id, {
        target: this.toDTO(row),
      });
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
      throw new NotFoundException('Target not found');
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
      await this.audit(tx, user.id, 'update', row.id, {
        before: this.toDTO(existing),
        after: this.toDTO(row),
      });
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
      throw new NotFoundException('Target not found');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.target.delete({ where: { id } });
      await this.audit(tx, user.id, 'delete', id, {
        target: this.toDTO(existing),
      });
    });
    return { id, deleted: true };
  }

  /** Live progress for the caller's accessible targets (or one subsidiary). */
  async progress(
    user: RequestUser,
    subsidiaryId?: string,
  ): Promise<TargetProgressDTO[]> {
    const targets = await this.list(user, subsidiaryId);
    return Promise.all(targets.map((t) => this.progressForTarget(user, t)));
  }

  /**
   * Compute progress from committed emissions. `baselineTCo2e` is the declared
   * baseline stored on the target (not recomputed). "Current" = the most recent
   * committed year strictly AFTER the baseline year; if none exists yet, progress
   * is `null` (honest "n/a", never a placeholder 0%). Formula mirrors the design
   * reference (actualReduction / neededReduction), clamped 0-100.
   */
  private async progressForTarget(
    user: RequestUser,
    t: TargetDTO,
  ): Promise<TargetProgressDTO> {
    // Pick the current year from records IN THE TARGET'S SCOPE (Prisma treats
    // `undefined` as no filter, so an 'all' target is unaffected). Without this a
    // scoped target could resolve to a year that only has other-scope data and
    // then report a fabricated 0 tCO₂e / 100% "on track" — a placeholder value.
    const latest = await this.prisma.activityRecord.findFirst({
      where: {
        subsidiaryId: t.subsidiaryId,
        reportingYear: { gt: t.baselineYear },
        scope: SCOPE_TO_NUMBER[t.scope],
        status: { in: COMMITTED_STATUSES },
      },
      orderBy: { reportingYear: 'desc' },
      select: { reportingYear: true },
    });
    if (!latest) {
      return {
        targetId: t.id,
        currentYear: t.baselineYear,
        currentTCo2e: null,
        progressPercent: null,
        status: null,
      };
    }

    const summary = await this.emissions.summary(user, {
      subsidiaryId: t.subsidiaryId,
      year: latest.reportingYear,
      scope: SCOPE_TO_NUMBER[t.scope],
    });
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
        entity: 'target',
        entityId,
        diff: diff as Prisma.InputJsonValue,
      },
    });
  }
}
