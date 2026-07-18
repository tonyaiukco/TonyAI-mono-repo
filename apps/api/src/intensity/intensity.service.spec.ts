import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import { IntensityService } from './intensity.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmissionsService } from '../emissions/emissions.service';
import type { RequestUser } from '../auth/auth.types';

const now = new Date('2026-01-01T00:00:00.000Z');

function makeDenominator(overrides: Record<string, unknown> = {}) {
  return {
    id: 'den-1',
    subsidiaryId: 'sub-1',
    year: 2024,
    metric: 'revenue',
    value: 320,
    unit: 'M EUR',
    createdBy: 'admin-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    subsidiaryDenominator: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    subsidiaryDenominator: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
}
type PrismaMock = ReturnType<typeof createPrismaMock>;

const admin: RequestUser = {
  id: 'admin-1',
  role: 'super_admin',
  accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
} as RequestUser;

const entry: RequestUser = {
  id: 'entry-1',
  role: 'data_entry',
  accessibleSubsidiaryIds: ['sub-1'],
} as RequestUser;

const createInput = {
  subsidiaryId: 'sub-1',
  year: 2024,
  metric: 'revenue' as const,
  value: 320,
  unit: 'M EUR',
};

describe('IntensityService', () => {
  let prisma: PrismaMock;
  let emissions: { summary: ReturnType<typeof vi.fn> };
  let service: IntensityService;

  beforeEach(() => {
    prisma = createPrismaMock();
    emissions = { summary: vi.fn() };
    service = new IntensityService(
      prisma as unknown as PrismaService,
      emissions as unknown as EmissionsService,
    );
  });

  it('listDenominators is tenant-scoped', async () => {
    prisma.subsidiaryDenominator.findMany.mockResolvedValue([makeDenominator()]);
    await service.listDenominators(admin, undefined, 2024);
    expect(prisma.subsidiaryDenominator.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subsidiaryId: { in: ['sub-1', 'sub-2'] }, year: 2024 },
      }),
    );
  });

  it('createDenominator is forbidden for non-super_admin', async () => {
    await expect(
      service.createDenominator(entry, createInput),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('createDenominator rejects a subsidiary outside the accessible set (404)', async () => {
    await expect(
      service.createDenominator(admin, { ...createInput, subsidiaryId: 'sub-999' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('createDenominator maps a unique clash to 409', async () => {
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    await expect(
      service.createDenominator(admin, createInput),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('createDenominator writes the row and an audit row (entity denominator)', async () => {
    prisma.tx.subsidiaryDenominator.create.mockResolvedValue(makeDenominator());
    await service.createDenominator(admin, createInput);
    expect(prisma.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'create', entity: 'denominator' }),
      }),
    );
  });

  it('intensity returns no metrics when the year is omitted', async () => {
    const res = await service.intensity(admin, undefined);
    expect(res.metrics).toEqual([]);
    expect(prisma.subsidiaryDenominator.findMany).not.toHaveBeenCalled();
  });

  it('intensity returns no metrics when nothing is configured', async () => {
    prisma.subsidiaryDenominator.findMany.mockResolvedValue([]);
    const res = await service.intensity(admin, 2024);
    expect(res.metrics).toEqual([]);
  });

  it('intensity divides emissions of the configured subsidiaries by their denominators', async () => {
    // revenue on sub-1 (320) and sub-2 (480) → denominatorTotal 800
    prisma.subsidiaryDenominator.findMany.mockResolvedValue([
      makeDenominator({ subsidiaryId: 'sub-1', value: 320 }),
      makeDenominator({ id: 'den-2', subsidiaryId: 'sub-2', value: 480 }),
    ]);
    // emissions: sub-1 = 200, sub-2 = 600 → total 800
    emissions.summary
      .mockResolvedValueOnce({ totals: { total: 200 } })
      .mockResolvedValueOnce({ totals: { total: 600 } });
    const res = await service.intensity(admin, 2024);
    expect(res.metrics).toHaveLength(1);
    const revenue = res.metrics[0];
    expect(revenue.metric).toBe('revenue');
    expect(revenue.denominatorTotal).toBe(800);
    expect(revenue.emissionsTotal).toBe(800);
    expect(revenue.intensity).toBeCloseTo(1, 5); // 800 / 800
  });

  it('intensity keeps mixed units for the same metric as separate entries', async () => {
    prisma.subsidiaryDenominator.findMany.mockResolvedValue([
      makeDenominator({ subsidiaryId: 'sub-1', value: 320, unit: 'M EUR' }),
      makeDenominator({ id: 'den-2', subsidiaryId: 'sub-2', value: 480, unit: 'M USD' }),
    ]);
    emissions.summary.mockResolvedValue({ totals: { total: 100 } });
    const res = await service.intensity(admin, 2024);
    expect(res.metrics).toHaveLength(2);
    expect(new Set(res.metrics.map((m) => m.unit))).toEqual(new Set(['M EUR', 'M USD']));
  });
});
