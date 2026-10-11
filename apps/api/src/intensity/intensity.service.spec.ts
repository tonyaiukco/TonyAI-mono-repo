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

import { AuditService } from '../audit/audit.service';

/**
 * Audit writes go through the shared AuditService. A single shared spy lets the
 * specs assert WHAT was audited; the row shape it stamps (actor role +
 * organisation) is covered by audit.service.spec.ts.
 */
const audit = { record: vi.fn() };
const auditMock = () => audit as unknown as AuditService;

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

    audit.record.mockClear();
    prisma = createPrismaMock();
    emissions = { summary: vi.fn() };
    service = new IntensityService(
      prisma as unknown as PrismaService,
      emissions as unknown as EmissionsService,
      auditMock(),
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
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ action: 'create', entity: 'denominator' }),
      prisma.tx,
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
      .mockResolvedValueOnce({ totals: { total: 200 }, uncalculatedRecordCount: 0 })
      .mockResolvedValueOnce({ totals: { total: 600 }, uncalculatedRecordCount: 0 });
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
    emissions.summary.mockResolvedValue({ totals: { total: 100 }, uncalculatedRecordCount: 0 });
    const res = await service.intensity(admin, 2024);
    expect(res.metrics).toHaveLength(2);
    expect(new Set(res.metrics.map((m) => m.unit))).toEqual(new Set(['M EUR', 'M USD']));
  });
  it.each([{ ids: [] }, { ids: ['sub-1'] }])('keeps empty or inaccessible context selections empty (%j)', async ({ ids }) => {
    const context = { year: 2027, subsidiaryId: 'foreign', scope: 1 as const, category: 'Fuel' as const };
    expect(await service.contextIntensity({ ...admin, accessibleSubsidiaryIds: ids }, context)).toEqual({
      context, data: { selectedSubsidiaryIds: [], metrics: [] },
    });
    expect(prisma.subsidiaryDenominator.findMany).not.toHaveBeenCalled();
    expect(emissions.summary).not.toHaveBeenCalled();
  });

  it('discloses the authorized selection even with no configured denominator', async () => {
    expect(await service.contextIntensity(admin, { year: 2027 })).toEqual({
      context: { year: 2027 }, data: { selectedSubsidiaryIds: ['sub-1', 'sub-2'], metrics: [] },
    });
  });

  it('restricts group intensity to revenue, including a single accessible subsidiary and the legacy route', async () => {
    const user = { ...admin, accessibleSubsidiaryIds: ['sub-1'] };
    await service.contextIntensity(user, { year: 2027 });
    await service.intensity(user, 2027);
    await service.intensity(user, 2027, '');
    expect(prisma.subsidiaryDenominator.findMany).toHaveBeenCalledTimes(3);
    for (const [query] of prisma.subsidiaryDenominator.findMany.mock.calls) {
      expect(query.where).toEqual({ subsidiaryId: { in: ['sub-1'] }, year: 2027, metric: { in: ['revenue'] } });
    }
  });

  it.each(['', '  '])('uses the group predicate consistently for a blank internal selector %j', async (subsidiaryId) => {
    await service.contextIntensity(admin, { year: 2027, subsidiaryId });
    expect(prisma.subsidiaryDenominator.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { subsidiaryId: { in: ['sub-1', 'sub-2'] }, year: 2027, metric: { in: ['revenue'] } },
    }));
  });

  it('keeps denominators annual and numerator coverage specific to each unit and contributing set', async () => {
    prisma.subsidiaryDenominator.findMany.mockResolvedValue([
      makeDenominator({ value: 20, unit: 'M EUR' }),
      makeDenominator({ id: 'den-2', subsidiaryId: 'sub-2', value: 40, unit: 'M USD' }),
    ]);
    emissions.summary
      .mockResolvedValueOnce({ totals: { total: 100 }, uncalculatedRecordCount: 2 })
      .mockResolvedValueOnce({ totals: { total: 120 }, uncalculatedRecordCount: 1 });
    const context = { year: 2027, scope: 1 as const, category: 'Fuel' as const };
    const result = await service.contextIntensity({ ...admin, accessibleSubsidiaryIds: ['sub-1', 'sub-2', 'sub-3'] }, context);
    expect(result).toEqual({ context, data: {
      selectedSubsidiaryIds: ['sub-1', 'sub-2', 'sub-3'],
      metrics: [
        { metric: 'revenue', unit: 'M EUR', denominatorTotal: 20, emissionsTotal: 100, intensity: 5, contributingSubsidiaryIds: ['sub-1'], uncalculatedRecordCount: 2 },
        { metric: 'revenue', unit: 'M USD', denominatorTotal: 40, emissionsTotal: 120, intensity: 3, contributingSubsidiaryIds: ['sub-2'], uncalculatedRecordCount: 1 },
      ],
    } });
    expect(emissions.summary.mock.calls.map(([, query]) => query)).toEqual([
      { ...context, subsidiaryId: 'sub-1' }, { ...context, subsidiaryId: 'sub-2' },
    ]);
  });

  it('permits physical intensity only for an explicit subsidiary', async () => {
    prisma.subsidiaryDenominator.findMany.mockResolvedValue([makeDenominator({ metric: 'employees', value: 10, unit: 'FTE' })]);
    emissions.summary.mockResolvedValue({ totals: { total: 30 }, uncalculatedRecordCount: 0 });
    const result = await service.contextIntensity(admin, { year: 2027, subsidiaryId: 'sub-1', scope: 2 });
    expect(prisma.subsidiaryDenominator.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { subsidiaryId: { in: ['sub-1'] }, year: 2027 },
    }));
    expect(result.data.selectedSubsidiaryIds).toEqual(['sub-1']);
    expect(result.data.metrics[0]).toMatchObject({ metric: 'employees', intensity: 3, contributingSubsidiaryIds: ['sub-1'] });
  });

});
