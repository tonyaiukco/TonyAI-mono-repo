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

// --- Local, DB-free mocks --------------------------------------------------

function createPrismaMock() {
  const tx = {
    periodLock: {
      create: vi.fn(),
      delete: vi.fn(),
    },
    activityRecord: {
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
      // Default: no records awaiting review, so locking is allowed.
      count: vi.fn().mockResolvedValue(0),
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
    prisma = createPrismaMock();
    service = new PeriodLocksService(prisma as unknown as PrismaService);
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
    expect(prisma.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'lock', entity: 'period_lock' }),
      }),
    );
  });

  it('cannot lock a period with records still awaiting review (409, no transaction)', async () => {
    prisma.activityRecord.count.mockResolvedValue(2);

    await expect(service.lock(superAdmin(), CREATE_DTO)).rejects.toThrow(
      /awaiting review/i,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
    prisma.tx.periodLock.delete.mockResolvedValue(LOCK_ROW);
    prisma.tx.activityRecord.updateMany.mockResolvedValue({ count: 3 });

    const res = await service.unlock(superAdmin(), 'lock-1');

    expect(res).toEqual({ id: 'lock-1', deleted: true });
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
    expect(prisma.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'unlock', entity: 'period_lock' }),
      }),
    );
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
