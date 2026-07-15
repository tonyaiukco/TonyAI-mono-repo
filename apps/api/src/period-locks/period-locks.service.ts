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
import type { PeriodLockDTO, ReportingPeriod } from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { CreatePeriodLockDto } from './dto/create-period-lock.dto';
import { isValidPeriodValue } from '../activity-records/activity-records.service';

// Closing a period is only allowed once every record in it has been reviewed:
// locking with `submitted`/`under_review` rows present is rejected (409), so
// the flip is strictly `approved` → `locked` and unlock restores exactly
// `approved`. This keeps lock/unlock from ever promoting unreviewed data past
// the consultant review workflow, and makes the bulk flip fully reconstructible
// from the audit row (period tuple + count). Drafts/rejected keep their status
// (the record gate blocks them anyway).
const PENDING_REVIEW_STATUSES: ActivityRecordStatus[] = [
  ActivityRecordStatus.submitted,
  ActivityRecordStatus.under_review,
];

@Injectable()
export class PeriodLocksService {
  constructor(private readonly prisma: PrismaService) {}

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
   */
  async lock(user: RequestUser, dto: CreatePeriodLockDto): Promise<PeriodLockDTO> {
    this.assertCanLock(user);
    if (!user.accessibleSubsidiaryIds.includes(dto.subsidiaryId)) {
      throw new NotFoundException('Subsidiary not found');
    }
    if (!isValidPeriodValue(dto.reportingPeriod, dto.periodValue)) {
      throw new BadRequestException(
        `"${dto.periodValue}" is not a valid period for a ${dto.reportingPeriod} lock.`,
      );
    }

    // A period with unreviewed records cannot be closed — approving via a
    // lock/unlock round-trip would bypass the consultant review workflow.
    const pendingReview = await this.prisma.activityRecord.count({
      where: {
        subsidiaryId: dto.subsidiaryId,
        reportingYear: dto.reportingYear,
        reportingPeriod: dto.reportingPeriod,
        periodValue: dto.periodValue,
        status: { in: PENDING_REVIEW_STATUSES },
      },
    });
    if (pendingReview > 0) {
      throw new ConflictException(
        `${pendingReview} record(s) in this period are still awaiting review — approve or reject them before locking.`,
      );
    }

    let created: PeriodLock;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.periodLock.create({
          data: {
            subsidiaryId: dto.subsidiaryId,
            reportingYear: dto.reportingYear,
            reportingPeriod: dto.reportingPeriod,
            periodValue: dto.periodValue,
            lockedBy: user.id,
          },
        });
        const flipped = await tx.activityRecord.updateMany({
          where: {
            subsidiaryId: dto.subsidiaryId,
            reportingYear: dto.reportingYear,
            reportingPeriod: dto.reportingPeriod,
            periodValue: dto.periodValue,
            status: ActivityRecordStatus.approved,
          },
          data: { status: ActivityRecordStatus.locked },
        });
        // Audit inside the transaction so a bulk flip can never go unaudited.
        await tx.auditLog.create({
          data: {
            userId: user.id,
            action: 'lock',
            entity: 'period_lock',
            entityId: row.id,
            diff: {
              lock: this.toDTO(row),
              recordsLocked: flipped.count,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        return row;
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('This reporting period is already locked.');
      }
      throw e;
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

    await this.prisma.$transaction(async (tx) => {
      await tx.periodLock.delete({ where: { id } });
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
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: 'unlock',
          entity: 'period_lock',
          entityId: id,
          diff: {
            lock: this.toDTO(existing),
            recordsReverted: flipped.count,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    });

    return { id, deleted: true };
  }
}
