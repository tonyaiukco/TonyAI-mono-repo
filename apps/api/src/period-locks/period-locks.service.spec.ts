import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ActivityRecordStatus, Prisma } from '@tonyai/db';
import { PeriodLocksService } from './period-locks.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';

import { AuditService } from '../audit/audit.service';

/**
 * Audit writes go through the shared AuditService. A single shared spy lets the
 * specs assert WHAT was audited; the row shape it stamps (actor role +
 * organisation) is covered by audit.service.spec.ts.
 */
const audit = { record: vi.fn() };
const auditMock = () => audit as unknown as AuditService;

// --- Local, DB-free mocks --------------------------------------------------

function createPrismaMock() {
  const tx = {
    // The period's exclusive advisory lock (`lifecycle-lock.ts`).
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn(),
    periodLock: {
      create: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    activityRecord: {
      // Default: nothing blocks the lock.
      groupBy: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    periodLock: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
    activityRecord: {
      // Counted inside the transaction now (tx.activityRecord.groupBy); a
      // count on the root client would run outside the period's lock.
      count: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    // $transaction(fn) runs the callback against the tx mock.
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
}
type PrismaMock = ReturnType<typeof createPrismaMock>;

const now = new Date('2026-01-01T00:00:00.000Z');
const LOCK_ROW = {
  id: 'lock-1',
  subsidiaryId: 'sub-1',
  reportingYear: 2024,
  reportingPeriod: 'quarterly',
  periodValue: 'Q1',
  lockedBy: 'user-admin',
  createdAt: now,
};

function superAdmin(over: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-admin',
    email: 'admin@tonyai.local',
    fullName: 'Admin User',
    role: 'super_admin',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
    ...over,
  };
}

function dataEntry(over: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-entry',
    email: 'entry@tonyai.local',
    fullName: 'Entry User',
    role: 'data_entry',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1'],
    ...over,
  };
}

const CREATE_DTO = {
  subsidiaryId: 'sub-1',
  reportingYear: 2024,
  reportingPeriod: 'quarterly' as const,
  periodValue: 'Q1',
};

describe('PeriodLocksService', () => {
  let prisma: PrismaMock;
  let service: PeriodLocksService;

  beforeEach(() => {

    audit.record.mockClear();
    prisma = createPrismaMock();
    service = new PeriodLocksService(prisma as unknown as PrismaService, auditMock());
  });

  it('only super_admin may lock (RBAC 403, nothing written)', async () => {
    await expect(service.lock(dataEntry(), CREATE_DTO)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('only super_admin may unlock (RBAC 403)', async () => {
    await expect(service.unlock(dataEntry(), 'lock-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('cannot lock a period of an inaccessible subsidiary (404)', async () => {
    await expect(
      service.lock(superAdmin(), { ...CREATE_DTO, subsidiaryId: 'sub-999' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a non-canonical periodValue (400)', async () => {
    await expect(
      service.lock(superAdmin(), { ...CREATE_DTO, periodValue: 'Quarter1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('quotes the value it refuses, naming what it cannot show', async () => {
    // The same rule as the record path's twin of this sentence: the DTO caps
    // the value at 32, but a U+202E in it reverses the rest of the toast that
    // shows it. Built from a code point, never typed.
    const rlo = String.fromCharCode(0x202e);

    await expect(
      service.lock(superAdmin(), {
        ...CREATE_DTO,
        periodValue: `Quarter${rlo}${'x'.repeat(60)}`,
      }),
    ).rejects.toThrow(`"Quarter<U+202E>${'x'.repeat(32)}…" is not a valid period`);
  });

  it('canonicalises the periodValue before it looks anything up', async () => {
    // Raw Postgres equality all the way down: a lock stored as `"q1"` counted
    // no `"Q1"` record as pending, flipped none to `locked`, and left the
    // period open to writes while the UI showed it closed. The lock row itself
    // is the smallest part of that; the two queries around it are the hole.
    prisma.tx.periodLock.create.mockResolvedValue(LOCK_ROW);
    prisma.tx.activityRecord.updateMany.mockResolvedValue({ count: 1 });

    await service.lock(superAdmin(), { ...CREATE_DTO, periodValue: '  q1  ' });

    expect(prisma.tx.activityRecord.groupBy.mock.calls[0][0].where).toMatchObject({
      periodValue: 'Q1',
    });
    expect(prisma.tx.periodLock.create.mock.calls[0][0].data).toMatchObject({
      periodValue: 'Q1',
    });
    expect(prisma.tx.activityRecord.updateMany.mock.calls[0][0].where).toMatchObject({
      periodValue: 'Q1',
    });
  });

  it('lock creates the row, flips committed records to locked, and audits', async () => {
    prisma.tx.periodLock.create.mockResolvedValue(LOCK_ROW);
    prisma.tx.activityRecord.updateMany.mockResolvedValue({ count: 3 });

    const dto = await service.lock(superAdmin(), CREATE_DTO);

    expect(dto.periodValue).toBe('Q1');
    // Committed → locked, scoped to the exact period tuple.
    expect(prisma.tx.activityRecord.updateMany).toHaveBeenCalledWith({
      where: {
        subsidiaryId: 'sub-1',
        reportingYear: 2024,
        reportingPeriod: 'quarterly',
        periodValue: 'Q1',
        status: ActivityRecordStatus.approved,
      },
      data: { status: ActivityRecordStatus.locked },
    });
    // Audit is written INSIDE the transaction (bulk flip can never go unaudited).
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ action: 'lock', entity: 'period_lock' }),
      prisma.tx,
    );
  });

  it('cannot lock a period with records still awaiting review (409, nothing written)', async () => {
    prisma.tx.activityRecord.groupBy.mockResolvedValue([
      { status: 'submitted', _count: { _all: 1 } },
      { status: 'under_review', _count: { _all: 1 } },
    ]);

    await expect(service.lock(superAdmin(), CREATE_DTO)).rejects.toThrow(
      /^2 record\(s\) in this period are still awaiting review/,
    );
    expect(prisma.tx.periodLock.create).not.toHaveBeenCalled();
    expect(prisma.tx.activityRecord.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();

    // Assert WHICH statuses were counted, not just that a count happened. With
    // the count mocked, an empty or truncated status list still produced a
    // green suite — and an empty one means a super_admin can close a period
    // holding undecided records, flipping them to the immutable `locked`
    // state unreviewed. That is the exact failure this gate exists to stop.
    expect(prisma.tx.activityRecord.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['submitted', 'under_review', 'rejected'] },
        }),
      }),
    );
  });

  it('counts what blocks the lock only once it holds the period exclusively', async () => {
    // F03: counted before the lock, a submit landing between the count and
    // the lock row put an unreviewed record inside a closed period.
    prisma.tx.periodLock.create.mockResolvedValue(LOCK_ROW);

    await service.lock(superAdmin(), CREATE_DTO);

    expect((prisma.tx.$executeRaw.mock.calls[0][0] as string[]).join('?')).toMatch(
      /pg_advisory_xact_lock\(/,
    );
    expect(prisma.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.tx.activityRecord.groupBy.mock.invocationCallOrder[0],
    );
    expect(prisma.activityRecord.count).not.toHaveBeenCalled();
  });

  it('cannot lock a period holding a rejected record — the lock would strand it (D03)', async () => {
    prisma.tx.activityRecord.groupBy.mockResolvedValue([
      { status: 'rejected', _count: { _all: 1 } },
    ]);

    await expect(service.lock(superAdmin(), CREATE_DTO)).rejects.toThrow(
      /^1 rejected record\(s\) are waiting for their authors/,
    );
    await expect(service.lock(superAdmin(), CREATE_DTO)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tx.periodLock.create).not.toHaveBeenCalled();
  });

  it('names both kinds when both block the lock', async () => {
    prisma.tx.activityRecord.groupBy.mockResolvedValue([
      { status: 'submitted', _count: { _all: 2 } },
      { status: 'rejected', _count: { _all: 1 } },
    ]);

    await expect(service.lock(superAdmin(), CREATE_DTO)).rejects.toThrow(
      /2 record\(s\).*awaiting review.*; 1 rejected record\(s\).* before locking\.$/,
    );
  });

  it('locking an already-locked period maps P2002 to 409', async () => {
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(service.lock(superAdmin(), CREATE_DTO)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('unlock deletes the row, reverts locked records to approved, and audits', async () => {
    prisma.periodLock.findUnique.mockResolvedValue(LOCK_ROW);
    prisma.tx.activityRecord.updateMany.mockResolvedValue({ count: 3 });

    const res = await service.unlock(superAdmin(), 'lock-1');

    expect(res).toEqual({ id: 'lock-1', deleted: true });
    // The period held exclusively before the row goes.
    expect(prisma.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.tx.periodLock.deleteMany.mock.invocationCallOrder[0],
    );
    expect(prisma.tx.periodLock.deleteMany).toHaveBeenCalledWith({ where: { id: 'lock-1' } });
    expect(prisma.tx.activityRecord.updateMany).toHaveBeenCalledWith({
      where: {
        subsidiaryId: 'sub-1',
        reportingYear: 2024,
        reportingPeriod: 'quarterly',
        periodValue: 'Q1',
        status: ActivityRecordStatus.locked,
      },
      data: { status: ActivityRecordStatus.approved },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ action: 'unlock', entity: 'period_lock' }),
      prisma.tx,
    );
  });

  it('unlock that wakes to the row already gone is NotFound, with no audit row', async () => {
    // A concurrent unlock held the period first and deleted the row.
    prisma.periodLock.findUnique.mockResolvedValue(LOCK_ROW);
    prisma.tx.periodLock.deleteMany.mockResolvedValue({ count: 0 });

    await expect(service.unlock(superAdmin(), 'lock-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.tx.activityRecord.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('unlock of an out-of-scope lock is NotFound (no leak)', async () => {
    prisma.periodLock.findUnique.mockResolvedValue({
      ...LOCK_ROW,
      subsidiaryId: 'sub-999',
    });
    await expect(
      service.unlock(superAdmin(), 'lock-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('list scopes to the accessible set and returns [] for a foreign subsidiary', async () => {
    const user = dataEntry();
    await service.list(user, undefined, undefined);
    expect(prisma.periodLock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ subsidiaryId: { in: ['sub-1'] } }),
      }),
    );

    const foreign = await service.list(user, 'sub-999');
    expect(foreign).toEqual([]);
  });
});
