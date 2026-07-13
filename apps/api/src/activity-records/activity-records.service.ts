import {
  BadRequestException,
  ConflictException,
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
  isEvidenceRequired,
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

// --- Anomaly detection (VAR §4) --------------------------------------------
// A value is anomalous when it deviates > ±50% from the rolling average of the
// previous (up to) 3 comparable periods for the same reporting entity, measured
// on calculated tCO₂e. Only committed rows feed the baseline (unreviewed drafts
// would add noise). Warning-based, never auto-rejection (VAR §8).
const ANOMALY_THRESHOLD = 0.5;
const BASELINE_MAX_PERIODS = 3;
const BASELINE_STATUSES: ActivityRecordStatus[] = [
  ActivityRecordStatus.submitted,
  ActivityRecordStatus.under_review,
  ActivityRecordStatus.approved,
  ActivityRecordStatus.locked,
];

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** Position of a period within its year, so records can be ordered despite
 * `periodValue` being a free string. Only compared within the same granularity
 * (monthly 0–11, quarterly 1–4, annual single). */
function periodOrdinal(reportingPeriod: string, periodValue: string): number {
  const v = periodValue.trim().toLowerCase();
  if (reportingPeriod === 'monthly') {
    const i = MONTHS.indexOf(v);
    return i < 0 ? 0 : i;
  }
  if (reportingPeriod === 'quarterly') {
    const m = /^q([1-4])$/.exec(v);
    return m ? Number(m[1]) : 0;
  }
  return 0; // annual: one period per year
}

/** True when `periodValue` is a canonical token for its granularity. Guards the
 * baseline ordering (periodOrdinal) against silent miscalculation from a
 * non-web client sending e.g. "Mar" or "2024-03". */
function isValidPeriodValue(reportingPeriod: string, periodValue: string): boolean {
  const v = periodValue.trim().toLowerCase();
  if (reportingPeriod === 'monthly') return MONTHS.includes(v);
  if (reportingPeriod === 'quarterly') return /^q[1-4]$/.test(v);
  if (reportingPeriod === 'annual') return v === 'annual';
  return false;
}

@Injectable()
export class ActivityRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calculations: CalculationsService,
  ) {}

  private toDTO(r: ActivityRecord, evidenceCount = 0): ActivityRecordDTO {
    return {
      id: r.id,
      subsidiaryId: r.subsidiaryId,
      locationId: r.locationId,
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
      evidenceCount,
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
    locationId?: string | null,
  ): Promise<{ calculation: CalculationResult; scope: number }> {
    if (!accessibleSubsidiaryIds.includes(subsidiaryId)) {
      // Tenant isolation: cannot attach a record to an inaccessible subsidiary.
      throw new NotFoundException('Subsidiary not found');
    }
    const subsidiary = await this.prisma.subsidiary.findUnique({
      where: { id: subsidiaryId },
    });
    if (!subsidiary) throw new NotFoundException('Subsidiary not found');

    // Reporting entity (FR §5.2): when a location is targeted, it drives the
    // factor geography; otherwise the subsidiary does. A location must belong to
    // the same (accessible) subsidiary, else it is treated as not found.
    let geographyCode = subsidiary.geographyCode;
    if (locationId) {
      const location = await this.prisma.location.findUnique({
        where: { id: locationId },
      });
      if (!location || location.subsidiaryId !== subsidiaryId) {
        throw new NotFoundException('Location not found');
      }
      geographyCode = location.geographyCode;
    }

    const scope = CATEGORY_SCOPE_MAP[category];
    const calculation = await this.calculations.compute({
      category,
      geographyCode,
      reportingYear,
      value: activityValue,
      unit: activityUnit,
    });
    return { calculation, scope };
  }

  /**
   * Anomaly check (VAR §4): true when `currentTCo2e` deviates > ±50% from the
   * rolling average of the previous (up to 3) committed periods for the same
   * reporting entity (subsidiary + location + category) at the same granularity.
   * No prior periods (or a zero baseline) → not anomalous. Warning-only.
   */
  private async detectAnomaly(params: {
    subsidiaryId: string;
    locationId: string | null;
    category: string;
    reportingPeriod: string;
    reportingYear: number;
    periodValue: string;
    currentTCo2e: number;
    excludeId?: string;
  }): Promise<boolean> {
    const rows = await this.prisma.activityRecord.findMany({
      where: {
        subsidiaryId: params.subsidiaryId,
        locationId: params.locationId,
        category: params.category,
        reportingPeriod: params.reportingPeriod,
        status: { in: BASELINE_STATUSES },
        ...(params.excludeId ? { id: { not: params.excludeId } } : {}),
      },
    });

    const currentKey =
      params.reportingYear * 100 +
      periodOrdinal(params.reportingPeriod, params.periodValue);
    const priorValues = rows
      .map((r) => ({
        key: r.reportingYear * 100 + periodOrdinal(r.reportingPeriod, r.periodValue),
        calc: r.calculation as unknown as CalculationResult | null,
      }))
      .filter((x) => x.key < currentKey) // strictly earlier periods only
      .sort((a, b) => b.key - a.key)
      .slice(0, BASELINE_MAX_PERIODS)
      .map((x) => (x.calc && Number.isFinite(x.calc.tCo2e) ? x.calc.tCo2e : null))
      // Drop (rather than zero-fill) priors without a usable tCO₂e so they don't
      // deflate the average and manufacture false anomalies.
      .filter((v): v is number => v !== null);

    if (priorValues.length === 0) return false; // no baseline to deviate from
    const baseline =
      priorValues.reduce((sum, v) => sum + v, 0) / priorValues.length;
    if (baseline === 0) return false;
    return Math.abs(params.currentTCo2e - baseline) / baseline > ANOMALY_THRESHOLD;
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
      include: { _count: { select: { evidence: true } } },
    });
    return rows.map((r) => this.toDTO(r, r._count.evidence));
  }

  async get(user: RequestUser, id: string): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    const evidenceCount = await this.prisma.evidence.count({
      where: { activityRecordId: id },
    });
    return this.toDTO(record, evidenceCount);
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
    if (!isValidPeriodValue(dto.reportingPeriod, dto.periodValue)) {
      throw new BadRequestException(
        `"${dto.periodValue}" is not a valid period for a ${dto.reportingPeriod} record.`,
      );
    }

    const { calculation, scope } = await this.computeSnapshot(
      dto.subsidiaryId,
      user.accessibleSubsidiaryIds,
      dto.category,
      dto.reportingYear,
      dto.activityValue,
      dto.activityUnit,
      dto.locationId,
    );

    const anomalyFlag = await this.detectAnomaly({
      subsidiaryId: dto.subsidiaryId,
      locationId: dto.locationId ?? null,
      category: dto.category,
      reportingPeriod: dto.reportingPeriod,
      reportingYear: dto.reportingYear,
      periodValue: dto.periodValue,
      currentTCo2e: calculation.tCo2e,
    });

    let created: ActivityRecord;
    try {
      created = await this.prisma.activityRecord.create({
        data: {
          subsidiaryId: dto.subsidiaryId,
          locationId: dto.locationId ?? null,
          reportingYear: dto.reportingYear,
          reportingPeriod: dto.reportingPeriod,
          periodValue: dto.periodValue,
          category: dto.category,
          scope,
          status: ActivityRecordStatus.draft,
          anomalyFlag,
          activityValue: dto.activityValue,
          activityUnit: dto.activityUnit,
          input: (dto.input ?? undefined) as Prisma.InputJsonValue | undefined,
          calculation: calculation as unknown as Prisma.InputJsonValue,
          createdBy: user.id,
          varianceReason: dto.varianceReason ?? null,
        },
      });
    } catch (e) {
      // Unique constraint (subsidiary, location, year, period, periodValue,
      // category) is a user-actionable conflict, not a server error.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          'An activity record already exists for this reporting entity, period and category.',
        );
      }
      throw e;
    }
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
    // `locationId` may be re-targeted (string), detached (null), or left as-is
    // (undefined) — distinguish "not provided" from an explicit null.
    const locationId =
      dto.locationId !== undefined ? dto.locationId : existing.locationId;

    const reportingPeriod = dto.reportingPeriod ?? existing.reportingPeriod;
    const periodValue = dto.periodValue ?? existing.periodValue;
    if (!isValidPeriodValue(reportingPeriod, periodValue)) {
      throw new BadRequestException(
        `"${periodValue}" is not a valid period for a ${reportingPeriod} record.`,
      );
    }

    const { calculation, scope } = await this.computeSnapshot(
      existing.subsidiaryId,
      user.accessibleSubsidiaryIds,
      category,
      reportingYear,
      activityValue,
      activityUnit,
      locationId,
    );

    const anomalyFlag = await this.detectAnomaly({
      subsidiaryId: existing.subsidiaryId,
      locationId,
      category,
      reportingPeriod,
      reportingYear,
      periodValue,
      currentTCo2e: calculation.tCo2e,
      excludeId: id, // the record's own row must not seed its baseline
    });

    const data: Prisma.ActivityRecordUpdateInput = {
      reportingYear,
      category,
      scope,
      activityValue,
      activityUnit,
      anomalyFlag,
      calculation: calculation as unknown as Prisma.InputJsonValue,
    };
    if (dto.locationId !== undefined) {
      data.location = dto.locationId
        ? { connect: { id: dto.locationId } }
        : { disconnect: true };
    }
    if (dto.reportingPeriod !== undefined) data.reportingPeriod = dto.reportingPeriod;
    if (dto.periodValue !== undefined) data.periodValue = dto.periodValue;
    if (dto.input !== undefined) {
      data.input = (dto.input ?? Prisma.JsonNull) as Prisma.InputJsonValue;
    }
    if (dto.varianceReason !== undefined) data.varianceReason = dto.varianceReason;

    let updated: ActivityRecord & { _count: { evidence: number } };
    try {
      updated = await this.prisma.activityRecord.update({
        where: { id },
        data,
        include: { _count: { select: { evidence: true } } },
      });
    } catch (e) {
      // Re-targeting can collide with an existing record for the new entity.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          'An activity record already exists for this reporting entity, period and category.',
        );
      }
      throw e;
    }
    await this.audit(user.id, 'update', id, {
      before: this.toDTO(existing),
      after: this.toDTO(updated, updated._count.evidence),
    });
    return this.toDTO(updated, updated._count.evidence);
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
    // Evidence gate (FR §4.1 / §5.4): categories configured as evidence-required
    // cannot be submitted without at least one supporting file.
    if (isEvidenceRequired(record.category)) {
      const evidenceCount = await this.prisma.evidence.count({
        where: { activityRecordId: id },
      });
      if (evidenceCount === 0) {
        throw new BadRequestException(
          `Category "${record.category}" requires at least one evidence file before submitting.`,
        );
      }
    }
    // Anomaly gate (VAR §2.2 / §4.3 / §8): re-evaluate against the baseline as of
    // submit time — a comparable period may have been committed since the draft
    // was saved. The API is the final enforcement layer, so it recomputes rather
    // than trusting the write-time flag, and persists the fresh value.
    const calc = record.calculation as unknown as CalculationResult | null;
    const anomalous = await this.detectAnomaly({
      subsidiaryId: record.subsidiaryId,
      locationId: record.locationId,
      category: record.category,
      reportingPeriod: record.reportingPeriod,
      reportingYear: record.reportingYear,
      periodValue: record.periodValue,
      currentTCo2e: calc && Number.isFinite(calc.tCo2e) ? calc.tCo2e : 0,
      excludeId: record.id,
    });
    if (anomalous && !record.varianceReason?.trim()) {
      throw new BadRequestException(
        'This value deviates significantly from the historical average — add a variance comment before submitting.',
      );
    }
    return this.transition(user, record, ActivityRecordStatus.submitted, {
      anomalyFlag: anomalous,
    });
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
    extra: { varianceReason?: string; anomalyFlag?: boolean } = {},
  ): Promise<ActivityRecordDTO> {
    const updated = await this.prisma.activityRecord.update({
      where: { id: record.id },
      data: {
        status,
        ...(extra.varianceReason !== undefined
          ? { varianceReason: extra.varianceReason }
          : {}),
        ...(extra.anomalyFlag !== undefined
          ? { anomalyFlag: extra.anomalyFlag }
          : {}),
      },
      include: { _count: { select: { evidence: true } } },
    });
    await this.audit(user.id, 'update', record.id, {
      transition: { from: record.status, to: status },
      ...(extra.varianceReason !== undefined
        ? { varianceReason: extra.varianceReason }
        : {}),
    });
    return this.toDTO(updated, updated._count.evidence);
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
