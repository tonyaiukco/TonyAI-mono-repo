import { describe, it, expect, beforeEach } from 'vitest';
import { KpiService } from './kpi.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  createPrismaMock,
  makeSubsidiary,
  makeSuperAdmin,
  makeDataEntry,
  type PrismaMock,
} from '../../test/helpers';

describe('KpiService.summary', () => {
  let prisma: PrismaMock;
  let service: KpiService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.location.count.mockResolvedValue(0);
    service = new KpiService(prisma as unknown as PrismaService);
  });

  it('scopes the queries to the caller\'s accessible subsidiary ids', async () => {
    const user = makeDataEntry({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });
    prisma.subsidiary.findMany.mockResolvedValue([]);

    await service.summary(user);

    expect(prisma.subsidiary.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['sub-1', 'sub-2'] } },
      select: { reportingStatus: true, geographyCode: true },
    });
    expect(prisma.location.count).toHaveBeenCalledWith({
      where: { subsidiaryId: { in: ['sub-1', 'sub-2'] } },
    });
  });

  it('counts locations across the accessible subsidiaries', async () => {
    const user = makeDataEntry({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });
    prisma.subsidiary.findMany.mockResolvedValue([]);
    prisma.location.count.mockResolvedValue(7);

    const kpi = await service.summary(user);

    expect(kpi.totalLocations).toBe(7);
  });

  it('counts total/active/pending and breaks down geography (known input -> known output)', async () => {
    const user = makeSuperAdmin();
    prisma.subsidiary.findMany.mockResolvedValue([
      makeSubsidiary({ reportingStatus: 'active', geographyCode: 'UK' }),
      makeSubsidiary({ reportingStatus: 'active', geographyCode: 'UK' }),
      makeSubsidiary({ reportingStatus: 'pending', geographyCode: 'TR' }),
      makeSubsidiary({ reportingStatus: 'inactive', geographyCode: 'EU' }),
      makeSubsidiary({ reportingStatus: 'pending', geographyCode: 'UK' }),
    ]);

    const kpi = await service.summary(user);

    expect(kpi.totalSubsidiaries).toBe(5);
    expect(kpi.activeSubsidiaries).toBe(2);
    expect(kpi.pendingSubsidiaries).toBe(2);
    // inactive is neither active nor pending — verify it is not miscounted
    expect(kpi.activeSubsidiaries + kpi.pendingSubsidiaries).toBe(4);

    const breakdown = Object.fromEntries(
      kpi.geographyBreakdown.map((g) => [g.geographyCode, g.count]),
    );
    expect(breakdown).toEqual({ UK: 3, TR: 1, EU: 1 });
  });

  it('returns all-zero KPIs for an empty accessible set', async () => {
    const user = makeDataEntry({ accessibleSubsidiaryIds: [] });
    prisma.subsidiary.findMany.mockResolvedValue([]);

    const kpi = await service.summary(user);

    expect(kpi).toEqual({
      totalSubsidiaries: 0,
      activeSubsidiaries: 0,
      pendingSubsidiaries: 0,
      totalLocations: 0,
      geographyBreakdown: [],
    });
  });

  it('reflects tenant scope: a data_entry user only sees their own subset counts', async () => {
    // Data-entry user can see 2 of the org's subsidiaries — KPIs must reflect
    // only those, never the full org.
    const user = makeDataEntry({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });
    prisma.subsidiary.findMany.mockResolvedValue([
      makeSubsidiary({ reportingStatus: 'active', geographyCode: 'UK' }),
      makeSubsidiary({ reportingStatus: 'pending', geographyCode: 'TR' }),
    ]);

    const kpi = await service.summary(user);

    expect(kpi.totalSubsidiaries).toBe(2);
    expect(kpi.activeSubsidiaries).toBe(1);
    expect(kpi.pendingSubsidiaries).toBe(1);
  });
});
