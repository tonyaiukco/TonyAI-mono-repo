import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ActivityRecordStatus,
  type ActivityRecord,
  type Subsidiary,
} from '@tonyai/db';
import { EmissionsService } from './emissions.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';

// --- Local, DB-free mocks --------------------------------------------------

function createPrismaMock() {
  return {
    activityRecord: {
      findMany: vi.fn(),
    },
    subsidiary: {
      findMany: vi.fn(),
    },
  };
}
type PrismaMock = ReturnType<typeof createPrismaMock>;

let seq = 0;
function makeRecord(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  seq += 1;
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: `rec-${seq}`,
    subsidiaryId: 'sub-1',
    reportingYear: 2024,
    reportingPeriod: 'monthly',
    periodValue: 'January',
    category: 'Electricity',
    scope: 2,
    status: ActivityRecordStatus.approved,
    activityValue: 1000,
    activityUnit: 'kWh',
    input: null,
    calculation: { tCo2e: 10 } as unknown,
    createdBy: 'user-entry',
    anomalyFlag: false,
    varianceReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ActivityRecord;
}

function makeSubsidiary(overrides: Partial<Subsidiary> = {}): Subsidiary {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'sub-1',
    organisationId: 'org-1',
    legalName: 'Sub One Legal',
    tradingName: 'Sub One',
    location: null,
    geographyCode: 'TR',
    businessArea: null,
    sector: null,
    designatedPerson: null,
    reportingStatus: 'active',
    includedScopes: [1, 2],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Subsidiary;
}

function superAdmin(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-admin',
    email: 'admin@tonyai.local',
    role: 'super_admin',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
    ...overrides,
  };
}

function dataEntry(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-entry',
    email: 'entry@tonyai.local',
    role: 'data_entry',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
    ...overrides,
  };
}

describe('EmissionsService.summary', () => {
  let prisma: PrismaMock;
  let service: EmissionsService;

  beforeEach(() => {
    seq = 0;
    prisma = createPrismaMock();
    service = new EmissionsService(prisma as unknown as PrismaService);
  });

  it('scopes the record query to the accessible set and only counts committed statuses', async () => {
    const user = dataEntry({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.subsidiary.findMany.mockResolvedValue([]);

    await service.summary(user, {});

    const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
    expect(where.subsidiaryId).toEqual({ in: ['sub-1', 'sub-2'] });
    expect(where.status).toEqual({
      in: [
        ActivityRecordStatus.submitted,
        ActivityRecordStatus.under_review,
        ActivityRecordStatus.approved,
        ActivityRecordStatus.locked,
      ],
    });
  });

  it('returns an empty summary for an inaccessible subsidiary without hitting the DB', async () => {
    const user = dataEntry({ accessibleSubsidiaryIds: ['sub-1'] });

    const summary = await service.summary(user, { subsidiaryId: 'sub-999' });

    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
    expect(summary.recordCount).toBe(0);
    expect(summary.totals.total).toBe(0);
  });

  it('returns an empty summary for an empty accessible set', async () => {
    const user = dataEntry({ accessibleSubsidiaryIds: [] });

    const summary = await service.summary(user, {});

    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
    expect(summary).toEqual({
      totals: { scope1: 0, scope2: 0, scope3: 0, total: 0 },
      byCategory: [],
      bySubsidiary: [],
      trend: { monthly: [], quarterly: [], yearly: [] },
      recordCount: 0,
      statusesIncluded: [
        ActivityRecordStatus.submitted,
        ActivityRecordStatus.under_review,
        ActivityRecordStatus.approved,
        ActivityRecordStatus.locked,
      ],
    });
  });

  it('aggregates scope totals, category and subsidiary breakdowns (known input -> known output)', async () => {
    const user = superAdmin();
    prisma.activityRecord.findMany.mockResolvedValue([
      makeRecord({ subsidiaryId: 'sub-1', category: 'Electricity', scope: 2, calculation: { tCo2e: 60 } }),
      makeRecord({ subsidiaryId: 'sub-1', category: 'Natural Gas', scope: 1, calculation: { tCo2e: 30 } }),
      makeRecord({ subsidiaryId: 'sub-2', category: 'Electricity', scope: 2, calculation: { tCo2e: 10 } }),
    ]);
    prisma.subsidiary.findMany.mockResolvedValue([
      makeSubsidiary({ id: 'sub-1', tradingName: 'Energy Co' }),
      makeSubsidiary({ id: 'sub-2', tradingName: 'Gas Co' }),
    ]);

    const s = await service.summary(user, {});

    // Totals: scope2 = 60 + 10 = 70, scope1 = 30, total = 100.
    expect(s.totals).toEqual({ scope1: 30, scope2: 70, scope3: 0, total: 100 });
    expect(s.recordCount).toBe(3);

    // Category breakdown, sorted by tCo2e desc, with percentages of 100.
    expect(s.byCategory.map((c) => [c.category, c.tCo2e, c.percentOfTotal])).toEqual([
      ['Electricity', 70, 70],
      ['Natural Gas', 30, 30],
    ]);

    // Subsidiary breakdown resolves names and shares.
    expect(s.bySubsidiary).toEqual([
      { subsidiaryId: 'sub-1', subsidiaryName: 'Energy Co', tCo2e: 90, recordCount: 2, percentOfTotal: 90 },
      { subsidiaryId: 'sub-2', subsidiaryName: 'Gas Co', tCo2e: 10, recordCount: 1, percentOfTotal: 10 },
    ]);
  });

  it('buckets monthly records into monthly, quarterly and yearly trends', async () => {
    const user = superAdmin();
    prisma.activityRecord.findMany.mockResolvedValue([
      makeRecord({ reportingPeriod: 'monthly', periodValue: 'January', scope: 2, calculation: { tCo2e: 5 } }),
      makeRecord({ reportingPeriod: 'monthly', periodValue: 'February', scope: 1, calculation: { tCo2e: 7 } }),
      makeRecord({ reportingPeriod: 'monthly', periodValue: 'April', scope: 2, calculation: { tCo2e: 3 } }),
    ]);
    prisma.subsidiary.findMany.mockResolvedValue([makeSubsidiary({ id: 'sub-1' })]);

    const s = await service.summary(user, {});

    // Monthly: three points in chronological order.
    expect(s.trend.monthly.map((p) => [p.period, p.total])).toEqual([
      ['January 2024', 5],
      ['February 2024', 7],
      ['April 2024', 3],
    ]);
    // Quarterly: Jan+Feb -> Q1 (12), Apr -> Q2 (3).
    expect(s.trend.quarterly.map((p) => [p.period, p.total])).toEqual([
      ['2024-Q1', 12],
      ['2024-Q2', 3],
    ]);
    // Yearly: everything folds into 2024.
    expect(s.trend.yearly.map((p) => [p.period, p.scope1, p.scope2, p.total])).toEqual([
      ['2024', 7, 8, 15],
    ]);
  });

  it('includes annual records in the yearly trend but not monthly/quarterly', async () => {
    const user = superAdmin();
    prisma.activityRecord.findMany.mockResolvedValue([
      makeRecord({ reportingPeriod: 'annual', periodValue: 'Annual', scope: 1, calculation: { tCo2e: 40 } }),
    ]);
    prisma.subsidiary.findMany.mockResolvedValue([makeSubsidiary({ id: 'sub-1' })]);

    const s = await service.summary(user, {});

    expect(s.trend.monthly).toEqual([]);
    expect(s.trend.quarterly).toEqual([]);
    expect(s.trend.yearly.map((p) => [p.period, p.total])).toEqual([['2024', 40]]);
  });
});
