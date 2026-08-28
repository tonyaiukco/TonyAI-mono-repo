import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { COUNTED_STATUSES } from '@tonyai/shared-types';
import { TargetsService } from './targets.service';
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

function makeTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tgt-1',
    subsidiaryId: 'sub-1',
    name: 'Net-zero 2030',
    basis: 'science_based',
    scope: 'all',
    baselineYear: 2023,
    baselineTCo2e: 1600,
    targetYear: 2030,
    targetTCo2e: 900,
    createdBy: 'admin-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    target: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    target: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
    activityRecord: {
      // Default: no post-baseline committed year → progress n/a.
      findFirst: vi.fn().mockResolvedValue(null),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
}
type PrismaMock = ReturnType<typeof createPrismaMock>;

const admin: RequestUser = {
  id: 'admin-1',
  email: 'admin@tonyai.local',
  fullName: 'Admin User',
  role: 'super_admin',
  accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
} as RequestUser;

const entry: RequestUser = {
  id: 'entry-1',
  email: 'entry@tonyai.local',
  fullName: 'Entry User',
  role: 'data_entry',
  accessibleSubsidiaryIds: ['sub-1'],
} as RequestUser;

const validInput = {
  subsidiaryId: 'sub-1',
  name: 'Net-zero 2030',
  basis: 'science_based' as const,
  scope: 'all' as const,
  baselineYear: 2023,
  baselineTCo2e: 1600,
  targetYear: 2030,
  targetTCo2e: 900,
};

describe('TargetsService', () => {
  let prisma: PrismaMock;
  let emissions: { summary: ReturnType<typeof vi.fn> };
  let service: TargetsService;

  beforeEach(() => {

    audit.record.mockClear();
    prisma = createPrismaMock();
    emissions = { summary: vi.fn() };
    service = new TargetsService(
      prisma as unknown as PrismaService,
      emissions as unknown as EmissionsService,
      auditMock(),
    );
  });

  it('counts exactly what the dashboard counts — one list, not a copy', async () => {
    // This is WP18 PR 2a's own headline claim, and nothing tested it. The
    // statuses a target measures progress against were a standalone literal
    // here: a status added to the dashboard's list and forgotten in this one
    // would have a target reporting progress against a different number from
    // the dashboard showing that progress, with no test failing.
    prisma.target.findMany.mockResolvedValue([makeTarget()]);
    prisma.activityRecord.findFirst.mockResolvedValue(null);

    await service.progress(admin);

    const where = prisma.activityRecord.findFirst.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: [...COUNTED_STATUSES] });
    // ...and a withdrawn figure is not one of them.
    expect(where.status.in).not.toContain('voided');
  });

  it('list is tenant-scoped to the accessible subsidiaries', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget()]);
    await service.list(admin);
    expect(prisma.target.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subsidiaryId: { in: ['sub-1', 'sub-2'] } },
      }),
    );
  });

  it('list returns [] for a requested subsidiary the caller cannot see', async () => {
    const rows = await service.list(admin, 'sub-999');
    expect(rows).toEqual([]);
    expect(prisma.target.findMany).not.toHaveBeenCalled();
  });

  it('derives reductionPercent in the DTO', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget()]); // 1600 -> 900
    const [dto] = await service.list(admin);
    expect(dto.reductionPercent).toBeCloseTo(43.75, 2);
  });

  it('create is forbidden for non-super_admin (and writes nothing)', async () => {
    await expect(service.create(entry, validInput)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('create rejects a subsidiary outside the accessible set (404)', async () => {
    await expect(
      service.create(admin, { ...validInput, subsidiaryId: 'sub-999' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('create rejects an incoherent target (target year not after baseline)', async () => {
    await expect(
      service.create(admin, { ...validInput, targetYear: 2023 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create rejects a target above the baseline (not a reduction)', async () => {
    await expect(
      service.create(admin, { ...validInput, targetTCo2e: 2000 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create rejects a zero-reduction target (baseline == target)', async () => {
    await expect(
      service.create(admin, { ...validInput, targetTCo2e: validInput.baselineTCo2e }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create writes the target and an audit row (entity target)', async () => {
    prisma.tx.target.create.mockResolvedValue(makeTarget());
    await service.create(admin, validInput);
    expect(prisma.tx.target.create).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ action: 'create', entity: 'target' }),
      prisma.tx,
    );
  });

  it('update/remove reject an out-of-scope target id (404)', async () => {
    prisma.target.findUnique.mockResolvedValue(makeTarget({ subsidiaryId: 'sub-999' }));
    await expect(service.update(admin, 'tgt-1', { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.remove(admin, 'tgt-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('progress is n/a when no committed year exists after the baseline', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget()]);
    prisma.activityRecord.findFirst.mockResolvedValue(null);
    const [p] = await service.progress(admin);
    expect(p.currentTCo2e).toBeNull();
    expect(p.progressPercent).toBeNull();
    expect(p.status).toBeNull();
    expect(emissions.summary).not.toHaveBeenCalled();
  });

  it('progress computes at_risk from committed emissions after the baseline', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget({ baselineTCo2e: 900, targetTCo2e: 350 })]);
    prisma.activityRecord.findFirst.mockResolvedValue({ reportingYear: 2024 });
    emissions.summary.mockResolvedValue({ totals: { total: 582 }, calculatedRecordCount: 3 });
    const [p] = await service.progress(admin);
    // (900-582)/(900-350)*100 = 57.8% → at_risk
    expect(p.currentYear).toBe(2024);
    expect(p.progressPercent).toBeCloseTo(57.8, 1);
    expect(p.status).toBe('at_risk');
  });

  it('progress clamps to 100 and reports on_track when already past target', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget({ baselineTCo2e: 5000, targetTCo2e: 2000 })]);
    prisma.activityRecord.findFirst.mockResolvedValue({ reportingYear: 2024 });
    emissions.summary.mockResolvedValue({ totals: { total: 1000 }, calculatedRecordCount: 3 });
    const [p] = await service.progress(admin);
    expect(p.progressPercent).toBe(100);
    expect(p.status).toBe('on_track');
  });

  it('progress stays n/a when the only records in scope carry no figure', async () => {
    prisma.target.findMany.mockResolvedValue([
      makeTarget({ scope: 'scope3', baselineYear: 2025, baselineTCo2e: 900, targetTCo2e: 350 }),
    ]);
    // A factor-less Water invoice is scope 3, so it satisfies "records exist in
    // this scope" — the guard the year lookup relies on — while contributing
    // nothing to the total. Before WP17 no scope-3 record could exist at all,
    // which is why that guard was sufficient.
    prisma.activityRecord.findFirst.mockResolvedValue({ reportingYear: 2026 });
    emissions.summary.mockResolvedValue({
      totals: { total: 0 },
      recordCount: 1,
      calculatedRecordCount: 0,
      uncalculatedRecordCount: 1,
    });

    const [p] = await service.progress(admin);

    // Without the second guard this reports 0 tCO₂e against a 900 baseline:
    // 100% complete, "on_track", from a single water bill.
    expect(p.currentTCo2e).toBeNull();
    expect(p.progressPercent).toBeNull();
    expect(p.status).toBeNull();
    expect(p.currentYear).toBe(2025); // falls back to the baseline year
  });

  it('progress filters the current-year lookup by the target scope (no fabricated zero)', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget({ scope: 'scope1' })]);
    prisma.activityRecord.findFirst.mockResolvedValue(null); // no scope-1 data after baseline
    const [p] = await service.progress(admin);
    expect(p.progressPercent).toBeNull();
    expect(prisma.activityRecord.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ scope: 1 }) }),
    );
    expect(emissions.summary).not.toHaveBeenCalled();
  });

  it('progress passes the target scope through to the summary query', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget({ scope: 'scope1' })]);
    prisma.activityRecord.findFirst.mockResolvedValue({ reportingYear: 2024 });
    emissions.summary.mockResolvedValue({ totals: { total: 100 }, calculatedRecordCount: 3 });
    await service.progress(admin);
    expect(emissions.summary).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ subsidiaryId: 'sub-1', year: 2024, scope: 1 }),
    );
  });
});
