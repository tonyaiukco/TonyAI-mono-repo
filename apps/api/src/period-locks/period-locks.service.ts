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
  type PeriodLock,
} from '@tonyai/db';
import { PENDING_REVIEW_STATUSES as SHARED_PENDING_REVIEW } from '@tonyai/shared-types';
import { canonicalPeriodValue } from '@tonyai/shared-types';
import type { PeriodLockDTO, ReportingPeriod } from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { quoteCallerText } from '../common/caller-text';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import {
  LIFECYCLE_TX,
  asLostRace,
  lockPeriodExclusive,
  type PeriodKey,
} from '../activity-records/lifecycle-lock';
import { CreatePeriodLockDto } from './dto/create-period-lock.dto';

// Closing a period is only allowed once every record in it has been reviewed:
// locking with `submitted`/`under_review` rows present is rejected (409), so
// the flip is strictly `approved` → `locked` and unlock restores exactly
// `approved`. This keeps lock/unlock from ever promoting unreviewed data past
// the consultant review workflow, and makes the bulk flip fully reconstructible
// from the audit row (period tuple + count). Drafts keep their status (the
// record gate blocks them anyway).
// Derived from the shared list rather than restated, so the reviewer queue and
// the lock gate cannot drift: any status added to one is a status the other
// starts refusing to lock past.
//
// A plain assignment, NOT `SHARED_PENDING_REVIEW.map(s => ActivityRecordStatus[s])`
// — that form's guard is TS7053, which only fires under `noImplicitAny`, and this
// package has it OFF (tsconfig.json). It would have compiled clean and produced
// `['submitted', undefined]` at runtime, silently disarming the gate below.
// Assignability is checked regardless of that flag, and names the bad status.
const PENDING_REVIEW_STATUSES: ActivityRecordStatus[] = [...SHARED_PENDING_REVIEW];

// What a lock refuses to close over: the review queue, and a `rejected` record
// (decision D03, 2026-09-29). A rejected record is waiting for its author, who
// cannot edit or resubmit it once the period is closed — locking over it
// strands it, outside the inventory and with no path back except an unlock
// nobody knows to ask for. The reviewer queue itself stays as it is: a
// rejected record is the author's to act on, not the reviewer's.
const LOCK_BLOCKING_STATUSES: ActivityRecordStatus[] = [
  ...PENDING_REVIEW_STATUSES,
  ActivityRecordStatus.rejected,
];

@Injectable()
export class PeriodLocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private toDTO(l: PeriodLock): PeriodLockDTO {
    return {
      id: l.id,
      subsidiaryId: l.subsidiaryId,
      reportingYear: l.reportingYear,
      reportingPeriod: l.reportingPeriod as ReportingPeriod,
      periodValue: l.periodValue,
      lockedBy: l.lockedBy,
      createdAt: l.createdAt.toISOString(),
    };
  }

  /** Closing/reopening a period is org structure — super_admin only (perm §5.3). */
  private assertCanLock(user: RequestUser): void {
    if (user.role !== 'super_admin') {
      throw new ForbiddenException(
        'Only super_admin may lock or unlock reporting periods',
      );
    }
  }

  async list(
    user: RequestUser,
    subsidiaryId?: string,
    year?: number,
  ): Promise<PeriodLockDTO[]> {
    // Tenant scope: intersect any requested subsidiaryId with the accessible set.
    let subsidiaryFilter: Prisma.StringFilter | string;
    if (subsidiaryId) {
      if (!user.accessibleSubsidiaryIds.includes(subsidiaryId)) {
        return [];
      }
      subsidiaryFilter = subsidiaryId;
    } else {
      subsidiaryFilter = { in: user.accessibleSubsidiaryIds };
    }

    const rows = await this.prisma.periodLock.findMany({
      where: { subsidiaryId: subsidiaryFilter, reportingYear: year },
      orderBy: [{ reportingYear: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((l) => this.toDTO(l));
  }

  /**
   * Close a reporting period (FR §4.2). Creates the lock row and, in the same
   * transaction, flips the period's committed records to `locked` status so
   * the UI reflects the closed state. Audited as `lock`.
   *
   * Under the lifecycle protocol (`lifecycle-lock.ts`) it first takes the
   * period's EXCLUSIVE lock, which waits for every record and evidence
   * writer of the period to commit and holds off new ones until this commits
   * — a create into an empty period included. Only then does it count what
   * blocks the lock, so a record submitted a moment ago is counted, and none
   * can be submitted between the count and the lock row.
   */
  async lock(user: RequestUser, dto: CreatePeriodLockDto): Promise<PeriodLockDTO> {
    this.assertCanLock(user);
    if (!user.accessibleSubsidiaryIds.includes(dto.subsidiaryId)) {
      throw new NotFoundException('Subsidiary not found');
    }
    // Canonicalised before anything looks a record up. Every query below
    // compares `period_value` with raw Postgres equality, so a lock stored as
    // `"january"` used to leave every `"January"` record open — it neither
    // counted them as pending nor flipped them to `locked`. A period a
    // super_admin believes is closed that still accepts writes is the sharpest
    // consequence of storing the caller's spelling.
    const periodValue = canonicalPeriodValue(dto.reportingPeriod, dto.periodValue);
    if (periodValue === null) {
      throw new BadRequestException(
        // Quoted through the one rule, like its twin on the record path: the
        // value is capped at 32 by the DTO, but a U+202E in it still reverses
        // the rest of the sentence in the toast that shows it.
        `"${quoteCallerText(dto.periodValue)}" is not a valid period for a ${dto.reportingPeriod} lock.`,
      );
    }

    const period: PeriodKey = {
      subsidiaryId: dto.subsidiaryId,
      reportingYear: dto.reportingYear,
      reportingPeriod: dto.reportingPeriod,
      periodValue,
    };

    let created: PeriodLock;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        await lockPeriodExclusive(tx, period);
        // A period with unreviewed records cannot be closed — approving via a
        // lock/unlock round-trip would bypass the consultant review workflow.
        // Nor with rejected ones (D03), which the lock would strand.
        const blocking = await tx.activityRecord.groupBy({
          by: ['status'],
          where: { ...period, status: { in: LOCK_BLOCKING_STATUSES } },
          _count: { _all: true },
        });
        const count = (statuses: ActivityRecordStatus[]) =>
          blocking
            .filter((g) => statuses.includes(g.status))
            .reduce((n, g) => n + g._count._all, 0);
        const pendingReview = count(PENDING_REVIEW_STATUSES);
        const rejected = count([ActivityRecordStatus.rejected]);
        if (pendingReview > 0 || rejected > 0) {
          const parts = [
            ...(pendingReview > 0
              ? [`${pendingReview} record(s) in this period are still awaiting review — approve or reject them`]
              : []),
            ...(rejected > 0
              ? [`${rejected} rejected record(s) are waiting for their authors — have them corrected and resubmitted, or deleted`]
              : []),
          ];
          throw new ConflictException(`${parts.join('; ')} before locking.`);
        }
        const row = await tx.periodLock.create({
          data: {
            subsidiaryId: dto.subsidiaryId,
            reportingYear: dto.reportingYear,
            reportingPeriod: dto.reportingPeriod,
            periodValue,
            lockedBy: user.id,
          },
        });
        const flipped = await tx.activityRecord.updateMany({
          where: {
            subsidiaryId: dto.subsidiaryId,
            reportingYear: dto.reportingYear,
            reportingPeriod: dto.reportingPeriod,
            periodValue,
            status: ActivityRecordStatus.approved,
          },
          data: { status: ActivityRecordStatus.locked },
        });
        // Audit inside the transaction so a bulk flip can never go unaudited.
        await this.audit.record(
          user,
          {
            action: 'lock',
            entity: 'period_lock',
            entityId: row.id,
            diff: { lock: this.toDTO(row), recordsLocked: flipped.count },
          },
          tx,
        );
        return row;
      }, LIFECYCLE_TX);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('This reporting period is already locked.');
      }
      throw asLostRace(e);
    }

    return this.toDTO(created);
  }

  /**
   * Reopen a period: delete the lock row and revert its `locked` records to
   * `approved` in the same transaction. Audited as `unlock`.
   */
  async unlock(
    user: RequestUser,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    this.assertCanLock(user);
    const existing = await this.prisma.periodLock.findUnique({ where: { id } });
    if (
      !existing ||
      !user.accessibleSubsidiaryIds.includes(existing.subsidiaryId)
    ) {
      throw new NotFoundException('Period lock not found');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // The period's exclusive lock, as `lock` takes it: one serialisation
        // point for every writer of the period. A second unlock of the same row
        // waits here and then finds it gone.
        await lockPeriodExclusive(tx, existing);
        const { count } = await tx.periodLock.deleteMany({ where: { id } });
        if (count === 0) throw new NotFoundException('Period lock not found');
        // Strictly the inverse of lock: `locked` → `approved` (lock only ever
        // flips approved records, since pending-review periods cannot be locked).
        const flipped = await tx.activityRecord.updateMany({
          where: {
            subsidiaryId: existing.subsidiaryId,
            reportingYear: existing.reportingYear,
            reportingPeriod: existing.reportingPeriod,
            periodValue: existing.periodValue,
            status: ActivityRecordStatus.locked,
          },
          data: { status: ActivityRecordStatus.approved },
        });
        // Audit inside the transaction so a bulk flip can never go unaudited.
        await this.audit.record(
          user,
          {
            action: 'unlock',
            entity: 'period_lock',
            entityId: id,
            diff: { lock: this.toDTO(existing), recordsReverted: flipped.count },
          },
          tx,
        );
      }, LIFECYCLE_TX);
    } catch (e) {
      throw asLostRace(e);
    }

    return { id, deleted: true };
  }
}
