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
  type AuditAction,
  type Category,
  type ReportingPeriod,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { CalculationsService } from '../calculations/calculations.service';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { CreateActivityRecordDto } from './dto/create-activity-record.dto';
import { UpdateActivityRecordDto } from './dto/update-activity-record.dto';
import { ListActivityRecordsQueryDto } from './dto/list-activity-records-query.dto';

// Roles allowed to create/update/delete/submit their own records.
// A consultant is NOT among them (decision 2026-07-30): the permissions matrix
// defines the seat as advisory — review, anomaly flagging, guidance — and it is
// typically filled by someone outside the holding company. Data preparation
// belongs to the tenant's own data_entry staff.
const WRITE_ROLES = new Set(['data_entry', 'super_admin']);
// Roles allowed to take a record into review and to reject it ("flag for
// revision" in permissions_and_roles.md §3).
const REVIEW_ROLES = new Set(['consultant', 'super_admin']);
// Roles allowed to APPROVE — narrower than REVIEW_ROLES on purpose. A
// consultant reviews and can send a record back ("flag for revision"), but the
// act of accepting a figure into the inventory stays with the holding company's
// own super_admin: an external advisor should not be able to sign off the
// numbers their client will report. Matches permissions_and_roles.md §3.
const APPROVE_ROLES = new Set(['super_admin']);
// Statuses in which a record may still be edited or deleted by an author.
// Exported so the subsidiary delete guard can tell a removable draft from a
// committed record it must refuse over — if the two lists drifted, that guard
// would start offering advice ("delete the drafts first") that the record
// endpoint refuses to carry out.
export const EDITABLE_STATUSES = new Set<ActivityRecordStatus>([
  ActivityRecordStatus.draft,
  ActivityRecordStatus.rejected,
]);

// A rejected record must be able to come BACK. Rejecting is the reviewer's
// routine action, editing a rejected record is already allowed, and `rejected`
// is excluded from the counted statuses — so if `submitted` were reachable only
// from `draft`, every rejection would strand a record permanently outside the
// inventory with no API path back, while pinning its report to
// `contains_incomplete_data`. Found by review before the reviewer UI made
// rejection a one-click action.
const SUBMITTABLE_STATUSES = new Set<ActivityRecordStatus>([
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
 * non-web client sending e.g. "Mar" or "2024-03". Exported for period locks,
 * which share the same period vocabulary. */
export function isValidPeriodValue(reportingPeriod: string, periodValue: string): boolean {
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
    private readonly audit: AuditService,
  ) {}

  /**
   * The record's own persisted columns, and nothing resolved by a join. This is
   * the audit snapshot, and `audit_log` is append-only: whatever goes in here is
   * permanent and has no correction path.
   *
   * `locationName` is carried by an `include` that only some queries ask for, so
   * feeding the read DTO straight to the audit trail wrote falsehoods — a create
   * whose `locationId` was set the whole time logged `locationName: null`, and
   * the next unrelated edit logged `null → "Site A"`, dating a geography
   * decision to a day on which nothing about the location changed.
   *
   * Resolved fields belong in `toDTO`, which builds on this — so a field added
   * to `ActivityRecordDTO` has to be placed on one side or the other instead of
   * silently reaching the audit log.
   */
  private toAuditSnapshot(
    r: ActivityRecord,
    evidenceCount = 0,
  ): Omit<ActivityRecordDTO, 'locationName'> {
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
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
      reviewNote: r.reviewNote,
      evidenceCount,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private toDTO(
    r: ActivityRecord & { location?: { name: string } | null },
    evidenceCount = 0,
  ): ActivityRecordDTO {
    return {
      ...this.toAuditSnapshot(r, evidenceCount),
      // Resolved at read time, the same way the audit trail resolves an actor's
      // name: uniqueness includes `location_id`, so two pending records in the
      // same subsidiary/period/category can differ ONLY by location — and the
      // reviewer saw two identical-looking rows with no way to tell them apart.
      locationName: r.location?.name ?? null,
    };
  }

  /**
   * Load a record and enforce tenant isolation: ids whose subsidiary is outside
   * the caller's accessible set are treated as not found (never leak existence).
   *
   * The location include is not optional: every read path has to agree on
   * `locationName`, and the contract documents `null` as "subsidiary-level, or
   * the location has since been removed" — the second half being exactly the
   * state this work package made impossible. A `GET /:id` that answered `null`
   * for a located record would therefore read as "orphaned, investigate".
   */
  private async loadScoped(
    user: RequestUser,
    id: string,
  ): Promise<ActivityRecord & { location: { name: string } | null }> {
    const record = await this.prisma.activityRecord.findUnique({
      where: { id },
      include: { location: { select: { name: true } } },
    });
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
    /** False when `activityUnit` came from the stored record, not this request. */
    unitChosenNow = true,
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
    const calculation = await this.calculations.compute(
      {
        category,
        geographyCode,
        reportingYear,
        value: activityValue,
        unit: activityUnit,
      },
      { enforceCategoryUnit: unitChosenNow },
    );
    return { calculation, scope };
  }

  /**
   * Period-lock gate (FR §4.2): while a `period_locks` row exists for the
   * record's (subsidiary, year, period, periodValue), NO create/update/delete/
   * submit is allowed — the period is closed. super_admin must unlock first.
   */
  private async assertPeriodNotLocked(
    subsidiaryId: string,
    reportingYear: number,
    reportingPeriod: string,
    periodValue: string,
  ): Promise<void> {
    const lock = await this.prisma.periodLock.findFirst({
      where: { subsidiaryId, reportingYear, reportingPeriod, periodValue },
    });
    if (lock) {
      throw new ConflictException(
        `Reporting period ${periodValue} ${reportingYear} is locked — a super_admin must unlock it before records can change.`,
      );
    }
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
        status: query.status ? { in: query.status } : undefined,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { evidence: true } },
        location: { select: { name: true } },
      },
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
    // Period-lock gate (FR §4.2): no new records in a closed period.
    await this.assertPeriodNotLocked(
      dto.subsidiaryId,
      dto.reportingYear,
      dto.reportingPeriod,
      dto.periodValue,
    );

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

    let created: ActivityRecord & { location: { name: string } | null };
    try {
      created = await this.prisma.activityRecord.create({
        // Same include as every other read path — the create response is what
        // the subsidiary create flow renders, and it must not claim the record
        // has no location seconds after being handed one.
        include: { location: { select: { name: true } } },
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
    await this.auditCreateUpdateDelete(user, 'create', created.id, {
      after: this.toAuditSnapshot(created),
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
    // Period-lock gate (FR §4.2): the record's current period must be open, and
    // it cannot be re-targeted INTO a locked period either.
    await this.assertPeriodNotLocked(
      existing.subsidiaryId,
      existing.reportingYear,
      existing.reportingPeriod,
      existing.periodValue,
    );
    if (
      reportingYear !== existing.reportingYear ||
      reportingPeriod !== existing.reportingPeriod ||
      periodValue !== existing.periodValue
    ) {
      await this.assertPeriodNotLocked(
        existing.subsidiaryId,
        reportingYear,
        reportingPeriod,
        periodValue,
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
      dto.activityUnit !== undefined,
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

    let updated: ActivityRecord & {
      _count: { evidence: number };
      location: { name: string } | null;
    };
    try {
      updated = await this.prisma.activityRecord.update({
        where: { id },
        data,
        include: {
          _count: { select: { evidence: true } },
          location: { select: { name: true } },
        },
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
    await this.auditCreateUpdateDelete(user, 'update', id, {
      before: this.toAuditSnapshot(existing),
      after: this.toAuditSnapshot(updated, updated._count.evidence),
    });
    return this.toDTO(updated, updated._count.evidence);
  }

  async remove(
    user: RequestUser,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    const existing = await this.loadScoped(user, id);
    this.assertCanMutate(user, existing);
    // Period-lock gate (FR §4.2): no deletions in a closed period.
    await this.assertPeriodNotLocked(
      existing.subsidiaryId,
      existing.reportingYear,
      existing.reportingPeriod,
      existing.periodValue,
    );
    await this.prisma.activityRecord.delete({ where: { id } });
    await this.auditCreateUpdateDelete(user, 'delete', id, {
      before: this.toAuditSnapshot(existing),
    });
    return { id, deleted: true };
  }

  // --- Workflow transitions --------------------------------------------------

  async submit(user: RequestUser, id: string): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    if (!WRITE_ROLES.has(user.role)) {
      throw new ForbiddenException('Your role may not submit activity records');
    }
    if (!SUBMITTABLE_STATUSES.has(record.status)) {
      throw new BadRequestException(
        `Only a draft or rejected record can be submitted (current status "${record.status}")`,
      );
    }
    const isResubmission = record.status === ActivityRecordStatus.rejected;
    // Resubmitting REVERSES a reviewer's decision, so it needs the author gate
    // that `update`/`remove` already apply. Without it, any data_entry user who
    // can merely SEE the subsidiary could overturn a rejection — while still
    // being forbidden from editing the number, so the only thing the capability
    // could be used for is making the rejection go away.
    if (
      isResubmission &&
      user.role !== 'super_admin' &&
      record.createdBy !== user.id
    ) {
      throw new ForbiddenException(
        'You may only resubmit activity records you created',
      );
    }
    // Period-lock gate (FR §4.2): no submissions into a closed period.
    await this.assertPeriodNotLocked(
      record.subsidiaryId,
      record.reportingYear,
      record.reportingPeriod,
      record.periodValue,
    );
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
    // The note is deliberately KEPT. Clearing it on resubmit was the first cut,
    // and it was wrong twice over: `reviewedBy`/`reviewedAt` survived anyway, so
    // the review stamp was only half-cleared, and it dead-coded the reviewer
    // sheet's "Previous review note" — a consultant re-reviewing a bounced-back
    // record would see something indistinguishable from a first submission. The
    // stale-note problem it was meant to solve is a RENDERING one, fixed where
    // it belongs: `/emissions` shows the note only on a `rejected` record.
    return this.transition(user, record, ActivityRecordStatus.submitted, {
      anomalyFlag: anomalous,
    });
  }

  /**
   * Take a submitted record into review (FR §6.3): submitted → under_review.
   * Marks that a reviewer is actively looking at it; approve/reject remain the
   * only exits. Same reviewer RBAC + period-lock gate as approve/reject.
   */
  async startReview(user: RequestUser, id: string): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    if (!REVIEW_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only a consultant or super_admin may review records',
      );
    }
    if (record.status !== ActivityRecordStatus.submitted) {
      throw new BadRequestException(
        `Only a submitted record can be taken into review (current status "${record.status}")`,
      );
    }
    await this.assertPeriodNotLocked(
      record.subsidiaryId,
      record.reportingYear,
      record.reportingPeriod,
      record.periodValue,
    );
    return this.transition(user, record, ActivityRecordStatus.under_review);
  }

  async approve(user: RequestUser, id: string): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    if (!APPROVE_ROLES.has(user.role)) {
      throw new ForbiddenException('Only a super_admin may approve records');
    }
    if (
      record.status !== ActivityRecordStatus.submitted &&
      record.status !== ActivityRecordStatus.under_review
    ) {
      throw new BadRequestException(
        `Only a submitted or under_review record can be approved (current status "${record.status}")`,
      );
    }
    // Period-lock gate (defense-in-depth): no review transitions in a closed
    // period, even for a record that slipped in around the lock (race).
    await this.assertPeriodNotLocked(
      record.subsidiaryId,
      record.reportingYear,
      record.reportingPeriod,
      record.periodValue,
    );
    // Clear any earlier rejection note: an approved record showing last
    // round's rejection reason would misread as "approved, but rejected".
    return this.transition(user, record, ActivityRecordStatus.approved, {
      reviewNote: null,
    });
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
    // Period-lock gate (defense-in-depth): symmetric with approve.
    await this.assertPeriodNotLocked(
      record.subsidiaryId,
      record.reportingYear,
      record.reportingPeriod,
      record.periodValue,
    );
    // The reviewer's reason goes in reviewNote — overwriting varianceReason
    // would destroy the author's own anomaly justification (VAR §4).
    return this.transition(user, record, ActivityRecordStatus.rejected, {
      reviewNote: varianceReason,
    });
  }

  /**
   * Which status a transition lands on decides the audit action. Before WP7
   * every transition logged `update` with the real move buried in the diff,
   * which made the audit trail unreadable and unfilterable.
   */
  private static readonly TRANSITION_ACTIONS: Record<string, AuditAction> = {
    [ActivityRecordStatus.submitted]: 'submit',
    [ActivityRecordStatus.under_review]: 'review',
    [ActivityRecordStatus.approved]: 'approve',
    [ActivityRecordStatus.rejected]: 'reject',
  };

  private async auditCreateUpdateDelete(
    user: RequestUser,
    action: 'create' | 'update' | 'delete',
    entityId: string,
    diff: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(user, { action, entity: 'activity_record', entityId, diff });
  }

  /** Apply a status change + optional field patch, and audit it. */
  private async transition(
    user: RequestUser,
    record: ActivityRecord,
    status: ActivityRecordStatus,
    extra: {
      varianceReason?: string;
      anomalyFlag?: boolean;
      reviewNote?: string | null;
    } = {},
  ): Promise<ActivityRecordDTO> {
    // A review outcome records WHO decided and WHEN, so the reviewer screen
    // does not have to reconstruct it from the audit log.
    const isReviewOutcome =
      status === ActivityRecordStatus.approved ||
      status === ActivityRecordStatus.rejected ||
      status === ActivityRecordStatus.under_review;

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
        ...(extra.reviewNote !== undefined ? { reviewNote: extra.reviewNote } : {}),
        ...(isReviewOutcome ? { reviewedBy: user.id, reviewedAt: new Date() } : {}),
      },
      include: {
        _count: { select: { evidence: true } },
        location: { select: { name: true } },
      },
    });
    await this.audit.record(user, {
      action: ActivityRecordsService.TRANSITION_ACTIONS[status] ?? 'update',
      entity: 'activity_record',
      entityId: record.id,
      diff: {
        transition: { from: record.status, to: status },
        ...(extra.reviewNote !== undefined ? { reviewNote: extra.reviewNote } : {}),
        ...(extra.varianceReason !== undefined
          ? { varianceReason: extra.varianceReason }
          : {}),
      },
    });
    return this.toDTO(updated, updated._count.evidence);
  }
}
