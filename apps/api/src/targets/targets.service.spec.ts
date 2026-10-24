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

const IDS = { targetIds: ['tgt-1'] };

/** The batched latest-year query's answer: one subsidiary's latest committed year per scope. */
const latestYears = (rows: { scope: number; year: number; subsidiaryId?: string }[]) =>
  rows.map((r) => ({ subsidiaryId: r.subsidiaryId ?? 'sub-1', scope: r.scope, _max: { reportingYear: r.year } }));

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
      // Default: no committed year anywhere.
      groupBy: vi.fn().mockResolvedValue([]),
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
    await service.progress(admin, IDS);

    const where = prisma.activityRecord.groupBy.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: [...COUNTED_STATUSES] });
    // ...and a withdrawn figure is not one of them.
    expect(where.status.in).not.toContain('voided');
  });

  it('a page is tenant-scoped, by target year then newest, and fetches one row more', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget()]);
    await service.listPage(admin, {});
    expect(prisma.target.findMany).toHaveBeenCalledWith({
      where: { subsidiaryId: { in: ['sub-1', 'sub-2'] } },
      orderBy: [{ targetYear: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
  });

  it('a page for a requested subsidiary the caller cannot see is empty, without a query', async () => {
    const page = await service.listPage(admin, { subsidiaryId: 'sub-999' });
    expect(page).toEqual({ items: [], limit: 50, nextCursor: null });
    expect(prisma.target.findMany).not.toHaveBeenCalled();
  });

  it('derives reductionPercent in the DTO', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget()]); // 1600 -> 900
    const [dto] = (await service.listPage(admin, {})).items;
    expect(dto.reductionPercent).toBeCloseTo(43.75, 2);
  });

  it('progress reads only the requested ids inside the access, answering in request order and omitting the rest alike', async () => {
    const a = '00000000-0000-4000-8000-00000000000a';
    const b = '00000000-0000-4000-8000-00000000000b';
    const missing = '00000000-0000-4000-8000-00000000000c';
    prisma.target.findMany.mockResolvedValue([makeTarget({ id: a }), makeTarget({ id: b })]);
        const rows = await service.progress(admin, { targetIds: [b, missing, a] });
    expect(prisma.target.findMany).toHaveBeenCalledWith({
      where: { id: { in: [b, missing, a] }, subsidiaryId: { in: ['sub-1', 'sub-2'] } },
    });
    expect(rows.map((r) => r.targetId)).toEqual([b, a]);
  });

  it('a target cursor is bound to its subsidiary filter (qa-auditor P2-1)', async () => {
    prisma.target.findMany.mockResolvedValueOnce([1, 2].map((n) => makeTarget({ id: `00000000-0000-4000-8000-00000000000${n}` })));
    const { nextCursor } = await service.listPage(admin, { subsidiaryId: 'sub-1', limit: 1 });
    await expect(service.listPage(admin, { limit: 1, cursor: nextCursor! })).rejects.toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'validation_failed' }) }),
    );
  });

  it('progress keeps one summary per scope: two targets of one subsidiary and year never share a figure (qa-auditor P2-2)', async () => {
    const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b'];
    prisma.target.findMany.mockResolvedValue([
      makeTarget({ id: ids[0], scope: 'scope1', baselineTCo2e: 1000, targetTCo2e: 500 }),
      makeTarget({ id: ids[1], scope: 'scope2', baselineTCo2e: 1000, targetTCo2e: 500 }),
    ]);
    prisma.activityRecord.groupBy.mockResolvedValue(latestYears([{ scope: 1, year: 2025 }, { scope: 2, year: 2025 }]));
    emissions.summary.mockImplementation(async (_u: unknown, q: { scope?: number }) => ({
      totals: { total: q.scope === 1 ? 900 : 600 },
      calculatedRecordCount: 1,
    }));
    const rows = await service.progress(admin, { targetIds: ids });
    expect(emissions.summary.mock.calls.map(([, q]) => (q as { scope?: number }).scope)).toEqual([1, 2]);
    expect(rows.map((r) => r.currentTCo2e)).toEqual([900, 600]);
  });

  it('progress for a caller with no access reads nothing', async () => {
    expect(await service.progress({ ...admin, accessibleSubsidiaryIds: [] }, IDS)).toEqual([]);
    expect(prisma.target.findMany).not.toHaveBeenCalled();
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
    await expect(
      service.create(admin, { ...validInput, subsidiaryId: 'sub-999' }),
    ).rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
  });

  it('create rejects an incoherent target (target year not after baseline)', async () => {
    await expect(
      service.create(admin, { ...validInput, targetYear: 2023 }),
    ).rejects.toMatchObject({
      response: { code: 'target_year_order', message: 'targetYear must be after baselineYear' },
    });
  });

  it('create rejects a target above the baseline (not a reduction)', async () => {
    await expect(
      service.create(admin, { ...validInput, targetTCo2e: 2000 }),
    ).rejects.toMatchObject({ response: { code: 'target_not_reduction' } });
  });

  it('create rejects a zero-reduction target (baseline == target)', async () => {
    await expect(
      service.create(admin, { ...validInput, targetTCo2e: validInput.baselineTCo2e }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(admin, { ...validInput, targetTCo2e: validInput.baselineTCo2e }),
    ).rejects.toMatchObject({ response: { code: 'target_not_reduction' } });
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
    // A foreign id and a missing one answer the same coded body.
    const foreign = await service.remove(admin, 'tgt-1').catch((e: NotFoundException) => e.getResponse());
    prisma.target.findUnique.mockResolvedValue(null);
    const missing = await service.update(admin, 'tgt-1', { name: 'x' }).catch((e: NotFoundException) => e.getResponse());
    expect(foreign).toEqual({ statusCode: 404, error: 'Not Found', message: 'Target not found', code: 'target_not_found' });
    expect(missing).toEqual(foreign);
  });

  it('progress is n/a when no committed year exists after the baseline', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget()]);
        const [p] = await service.progress(admin, IDS);
    expect(p.currentTCo2e).toBeNull();
    expect(p.progressPercent).toBeNull();
    expect(p.status).toBeNull();
    expect(emissions.summary).not.toHaveBeenCalled();
  });

  it('progress computes at_risk from committed emissions after the baseline', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget({ baselineTCo2e: 900, targetTCo2e: 350 })]);
    prisma.activityRecord.groupBy.mockResolvedValue(latestYears([{ scope: 1, year: 2024 }]));
    emissions.summary.mockResolvedValue({ totals: { total: 582 }, calculatedRecordCount: 3 });
    const [p] = await service.progress(admin, IDS);
    // (900-582)/(900-350)*100 = 57.8% → at_risk
    expect(p.currentYear).toBe(2024);
    expect(p.progressPercent).toBeCloseTo(57.8, 1);
    expect(p.status).toBe('at_risk');
  });

  it('progress clamps to 100 and reports on_track when already past target', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget({ baselineTCo2e: 5000, targetTCo2e: 2000 })]);
    prisma.activityRecord.groupBy.mockResolvedValue(latestYears([{ scope: 1, year: 2024 }]));
    emissions.summary.mockResolvedValue({ totals: { total: 1000 }, calculatedRecordCount: 3 });
    const [p] = await service.progress(admin, IDS);
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
    prisma.activityRecord.groupBy.mockResolvedValue(latestYears([{ scope: 3, year: 2026 }]));
    emissions.summary.mockResolvedValue({
      totals: { total: 0 },
      recordCount: 1,
      calculatedRecordCount: 0,
      uncalculatedRecordCount: 1,
    });

    const [p] = await service.progress(admin, IDS);

    // Without the second guard this reports 0 tCO₂e against a 900 baseline:
    // 100% complete, "on_track", from a single water bill.
    expect(p.currentTCo2e).toBeNull();
    expect(p.progressPercent).toBeNull();
    expect(p.status).toBeNull();
    expect(p.currentYear).toBe(2025); // falls back to the baseline year
  });

  it('progress filters the current-year lookup by the target scope (no fabricated zero)', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget({ scope: 'scope1' })]);
    // Only scope-2 data after the baseline: a scope-1 target has nothing to compare.
    prisma.activityRecord.groupBy.mockResolvedValue(latestYears([{ scope: 2, year: 2026 }]));
    const [p] = await service.progress(admin, IDS);
    expect(p.progressPercent).toBeNull();
    expect(prisma.activityRecord.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['subsidiaryId', 'scope'], where: expect.objectContaining({ subsidiaryId: { in: ['sub-1'] } }) }),
    );
    expect(emissions.summary).not.toHaveBeenCalled();
  });

  it('progress takes the latest committed year only when it is after the baseline', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget({ baselineYear: 2024 })]);
    prisma.activityRecord.groupBy.mockResolvedValue(latestYears([{ scope: 1, year: 2024 }, { scope: 2, year: 2023 }]));
    const [p] = await service.progress(admin, IDS);
    expect(p.currentTCo2e).toBeNull();
    expect(emissions.summary).not.toHaveBeenCalled();
  });

  it('progress batches: one latest-year query and one summary per distinct subsidiary, year and scope', async () => {
    const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c'];
    prisma.target.findMany.mockResolvedValue([
      makeTarget({ id: ids[0] }),
      makeTarget({ id: ids[1] }), // same subsidiary and scope: the same summary
      makeTarget({ id: ids[2], subsidiaryId: 'sub-2' }),
    ]);
    prisma.activityRecord.groupBy.mockResolvedValue(latestYears([{ scope: 1, year: 2024 }, { scope: 1, year: 2025, subsidiaryId: 'sub-2' }]));
    emissions.summary.mockResolvedValue({ totals: { total: 100 }, calculatedRecordCount: 3 });
    const rows = await service.progress(admin, { targetIds: ids });
    expect(rows.map((r) => [r.targetId, r.currentYear])).toEqual([[ids[0], 2024], [ids[1], 2024], [ids[2], 2025]]);
    expect(prisma.activityRecord.groupBy).toHaveBeenCalledTimes(1);
    expect(emissions.summary).toHaveBeenCalledTimes(2);
  });

  it('progress passes the target scope through to the summary query', async () => {
    prisma.target.findMany.mockResolvedValue([makeTarget({ scope: 'scope1' })]);
    prisma.activityRecord.groupBy.mockResolvedValue(latestYears([{ scope: 1, year: 2024 }]));
    emissions.summary.mockResolvedValue({ totals: { total: 100 }, calculatedRecordCount: 3 });
    await service.progress(admin, IDS);
    expect(emissions.summary).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ subsidiaryId: 'sub-1', year: 2024, scope: 1 }),
      5_000, // bounded like a report's (LP4-05 PR C)
    );
  });
});
