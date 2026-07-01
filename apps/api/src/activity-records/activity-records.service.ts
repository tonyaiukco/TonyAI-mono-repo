import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivityRecordStatus,
  Prisma,
  type ActivityRecord,
} from '@tonyai/db';
import {
  CATEGORY_SCOPE_MAP,
  type ActivityRecordDTO,
  type CalculationResult,
  type Category,
  type ReportingPeriod,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { CalculationsService } from '../calculations/calculations.service';
import type { RequestUser } from '../auth/auth.types';
import { CreateActivityRecordDto } from './dto/create-activity-record.dto';
import { UpdateActivityRecordDto } from './dto/update-activity-record.dto';
import { ListActivityRecordsQueryDto } from './dto/list-activity-records-query.dto';

// Roles allowed to create/update/delete their own records.
const WRITE_ROLES = new Set(['data_entry', 'consultant', 'super_admin']);
// Roles allowed to approve/reject a record under review.
const REVIEW_ROLES = new Set(['consultant', 'super_admin']);
// Statuses in which a record may still be edited or deleted by an author.
const EDITABLE_STATUSES = new Set<ActivityRecordStatus>([
  ActivityRecordStatus.draft,
  ActivityRecordStatus.rejected,
]);

@Injectable()
export class ActivityRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calculations: CalculationsService,
  ) {}

  private toDTO(r: ActivityRecord): ActivityRecordDTO {
    return {
      id: r.id,
      subsidiaryId: r.subsidiaryId,
      reportingYear: r.reportingYear,
      reportingPeriod: r.reportingPeriod as ReportingPeriod,
      periodValue: r.periodValue,
      category: r.category as Category,
      scope: r.scope,
      status: r.status,
      activityValue: r.activityValue,
      activityUnit: r.activityUnit,
      input: (r.input as Record<string, unknown> | null) ?? null,
      calculation: r.calculation as unknown as CalculationResult,
      createdBy: r.createdBy,
      anomalyFlag: r.anomalyFlag,
      varianceReason: r.varianceReason,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  /**
   * Load a record and enforce tenant isolation: ids whose subsidiary is outside
   * the caller's accessible set are treated as not found (never leak existence).
   */
  private async loadScoped(
    user: RequestUser,
    id: string,
  ): Promise<ActivityRecord> {
    const record = await this.prisma.activityRecord.findUnique({ where: { id } });
    if (!record || !user.accessibleSubsidiaryIds.includes(record.subsidiaryId)) {
      throw new NotFoundException('Activity record not found');
    }
    return record;
  }

  /** Author-or-super_admin gate for edit/delete on a mutable record. */
  private assertCanMutate(user: RequestUser, record: ActivityRecord): void {
    if (!WRITE_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Your role may not modify activity records',
      );
    }
    if (user.role !== 'super_admin' && record.createdBy !== user.id) {
      throw new ForbiddenException(
        'You may only modify activity records you created',
      );
    }
    if (!EDITABLE_STATUSES.has(record.status)) {
      throw new BadRequestException(
        `Cannot modify a record in status "${record.status}"`,
      );
    }
  }

  /**
   * Produce the immutable calculation snapshot for a record by resolving the
   * subsidiary's geography and the category's scope, then calling the calc
   * engine. Returns both the snapshot and the derived scope.
   */
  private async computeSnapshot(
    subsidiaryId: string,
    accessibleSubsidiaryIds: string[],
    category: Category,
    reportingYear: number,
    activityValue: number,
    activityUnit: string,
  ): Promise<{ calculation: CalculationResult; scope: number }> {
    if (!accessibleSubsidiaryIds.includes(subsidiaryId)) {
      // Tenant isolation: cannot attach a record to an inaccessible subsidiary.
      throw new NotFoundException('Subsidiary not found');
    }
    const subsidiary = await this.prisma.subsidiary.findUnique({
      where: { id: subsidiaryId },
    });
    if (!subsidiary) throw new NotFoundException('Subsidiary not found');

    const scope = CATEGORY_SCOPE_MAP[category];
    const calculation = await this.calculations.compute({
      category,
      geographyCode: subsidiary.geographyCode,
      reportingYear,
      value: activityValue,
      unit: activityUnit,
    });
    return { calculation, scope };
  }

  async list(
    user: RequestUser,
    query: ListActivityRecordsQueryDto,
  ): Promise<ActivityRecordDTO[]> {
    // Tenant scope: intersect any requested subsidiaryId with the accessible set.
    let subsidiaryFilter: Prisma.StringFilter | string;
    if (query.subsidiaryId) {
      if (!user.accessibleSubsidiaryIds.includes(query.subsidiaryId)) {
        return []; // requested a subsidiary the caller cannot see -> empty
      }
      subsidiaryFilter = query.subsidiaryId;
    } else {
      subsidiaryFilter = { in: user.accessibleSubsidiaryIds };
    }

    const rows = await this.prisma.activityRecord.findMany({
      where: {
        subsidiaryId: subsidiaryFilter,
        reportingYear: query.year,
        reportingPeriod: query.period,
        category: query.category,
        status: query.status,
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDTO(r));
  }

  async get(user: RequestUser, id: string): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    return this.toDTO(record);
  }

  async create(
    user: RequestUser,
    dto: CreateActivityRecordDto,
  ): Promise<ActivityRecordDTO> {
    if (!WRITE_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Your role may not create activity records',
      );
    }

    const { calculation, scope } = await this.computeSnapshot(
      dto.subsidiaryId,
      user.accessibleSubsidiaryIds,
      dto.category,
      dto.reportingYear,
      dto.activityValue,
      dto.activityUnit,
    );

    const created = await this.prisma.activityRecord.create({
      data: {
        subsidiaryId: dto.subsidiaryId,
        reportingYear: dto.reportingYear,
        reportingPeriod: dto.reportingPeriod,
        periodValue: dto.periodValue,
        category: dto.category,
        scope,
        status: ActivityRecordStatus.draft,
        activityValue: dto.activityValue,
        activityUnit: dto.activityUnit,
        input: (dto.input ?? undefined) as Prisma.InputJsonValue | undefined,
        calculation: calculation as unknown as Prisma.InputJsonValue,
        createdBy: user.id,
        varianceReason: dto.varianceReason ?? null,
      },
    });
    await this.audit(user.id, 'create', created.id, {
      after: this.toDTO(created),
    });
    return this.toDTO(created);
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateActivityRecordDto,
  ): Promise<ActivityRecordDTO> {
    const existing = await this.loadScoped(user, id);
    this.assertCanMutate(user, existing);

    // Resolve the effective values (dto overrides existing) so we can recompute.
    const category = (dto.category ?? existing.category) as Category;
    const reportingYear = dto.reportingYear ?? existing.reportingYear;
    const activityValue = dto.activityValue ?? existing.activityValue;
    const activityUnit = dto.activityUnit ?? existing.activityUnit;

    const { calculation, scope } = await this.computeSnapshot(
      existing.subsidiaryId,
      user.accessibleSubsidiaryIds,
      category,
      reportingYear,
      activityValue,
      activityUnit,
    );

    const data: Prisma.ActivityRecordUpdateInput = {
      reportingYear,
      category,
      scope,
      activityValue,
      activityUnit,
      calculation: calculation as unknown as Prisma.InputJsonValue,
    };
    if (dto.reportingPeriod !== undefined) data.reportingPeriod = dto.reportingPeriod;
    if (dto.periodValue !== undefined) data.periodValue = dto.periodValue;
    if (dto.input !== undefined) {
      data.input = (dto.input ?? Prisma.JsonNull) as Prisma.InputJsonValue;
    }
    if (dto.varianceReason !== undefined) data.varianceReason = dto.varianceReason;

    const updated = await this.prisma.activityRecord.update({
      where: { id },
      data,
    });
    await this.audit(user.id, 'update', id, {
      before: this.toDTO(existing),
      after: this.toDTO(updated),
    });
    return this.toDTO(updated);
  }

  async remove(
    user: RequestUser,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    const existing = await this.loadScoped(user, id);
    this.assertCanMutate(user, existing);
    await this.prisma.activityRecord.delete({ where: { id } });
    await this.audit(user.id, 'delete', id, { before: this.toDTO(existing) });
    return { id, deleted: true };
  }

  // --- Workflow transitions --------------------------------------------------

  async submit(user: RequestUser, id: string): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    if (!WRITE_ROLES.has(user.role)) {
      throw new ForbiddenException('Your role may not submit activity records');
    }
    if (record.status !== ActivityRecordStatus.draft) {
      throw new BadRequestException(
        `Only a draft record can be submitted (current status "${record.status}")`,
      );
    }
    return this.transition(user, record, ActivityRecordStatus.submitted);
  }

  async approve(user: RequestUser, id: string): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    if (!REVIEW_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only a consultant or super_admin may approve records',
      );
    }
    if (
      record.status !== ActivityRecordStatus.submitted &&
      record.status !== ActivityRecordStatus.under_review
    ) {
      throw new BadRequestException(
        `Only a submitted or under_review record can be approved (current status "${record.status}")`,
      );
    }
    return this.transition(user, record, ActivityRecordStatus.approved);
  }

  async reject(
    user: RequestUser,
    id: string,
    varianceReason: string,
  ): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    if (!REVIEW_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only a consultant or super_admin may reject records',
      );
    }
    if (
      record.status !== ActivityRecordStatus.submitted &&
      record.status !== ActivityRecordStatus.under_review
    ) {
      throw new BadRequestException(
        `Only a submitted or under_review record can be rejected (current status "${record.status}")`,
      );
    }
    return this.transition(user, record, ActivityRecordStatus.rejected, {
      varianceReason,
    });
  }

  /** Apply a status change + optional field patch, and audit it. */
  private async transition(
    user: RequestUser,
    record: ActivityRecord,
    status: ActivityRecordStatus,
    extra: { varianceReason?: string } = {},
  ): Promise<ActivityRecordDTO> {
    const updated = await this.prisma.activityRecord.update({
      where: { id: record.id },
      data: {
        status,
        ...(extra.varianceReason !== undefined
          ? { varianceReason: extra.varianceReason }
          : {}),
      },
    });
    await this.audit(user.id, 'update', record.id, {
      transition: { from: record.status, to: status },
      ...(extra.varianceReason !== undefined
        ? { varianceReason: extra.varianceReason }
        : {}),
    });
    return this.toDTO(updated);
  }

  private async audit(
    userId: string,
    action: 'create' | 'update' | 'delete',
    entityId: string,
    diff: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        userId,
        action,
        entity: 'activity_record',
        entityId,
        diff: diff as Prisma.InputJsonValue,
      },
    });
  }
}
