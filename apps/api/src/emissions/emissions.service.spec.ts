import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import {
  ActivityRecordStatus,
  type ActivityRecord,
  type Subsidiary,
} from '@tonyai/db';
import { ACCEPTED_STATUSES, COUNTED_STATUSES } from '@tonyai/shared-types';
import {
  computeInvoiceCoverage,
  deriveCellStatus,
  EmissionsService,
} from './emissions.service';
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
      findUnique: vi.fn(),
    },
    location: {
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
    calculation: { tCo2e: 10, factorId: 'f-1' } as unknown,
    createdBy: 'user-entry',
    anomalyFlag: false,
    // Defaulted to an EVALUATED verdict, the common case for a committed record
    // with a figure. Left undefined these read as "the rule never ran", which
    // silently turns every fixture in the file into a not-evaluated record.
    anomalyBaselinePriorCount: 3,
    anomalyBaselineTCo2e: 10,
    varianceReason: null,
    // Prisma `_count` from the matrix query's evidence include. Default 1
    // ("has evidence") so committed records satisfy the FR §2.2 evidence rule.
    _count: { evidence: 1 },
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
    // The matrix selects both of these now: the granularity decides which rule
    // a row is measured by, and `_count.locations` is the denominator's
    // multiplier. Defaulted to what every seeded row actually holds — the
    // historic behaviour — so a spec that means "measured by location" has to
    // say so out loud.
    trackingGranularity: 'subsidiary',
    // The matrix selects the location IDS now, not a count: the numerator is
    // restricted to the same set the denominator is built from.
    locations: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Subsidiary;
}

function superAdmin(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-admin',
    email: 'admin@tonyai.local',
    fullName: 'Admin User',
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
    fullName: 'Entry User',
    role: 'data_entry',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
    ...overrides,
  };
}

describe('EmissionsService.completeness (drill-down)', () => {
  let prisma: PrismaMock;
  let service: EmissionsService;

  const LOCATIONS = [
    { id: 'loc-1', name: 'Ankara Power Plant' },
    { id: 'loc-2', name: 'Istanbul HQ' },
  ];

  beforeEach(() => {
    seq = 0;
    prisma = createPrismaMock();
    service = new EmissionsService(prisma as unknown as PrismaService);
    prisma.location.findMany.mockResolvedValue(LOCATIONS);
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.subsidiary.findUnique.mockResolvedValue({ trackingGranularity: 'location' });
  });

  const invoice = (locationId: string, periodValue: string, over: Partial<ActivityRecord> = {}) =>
    makeRecord({
      subsidiaryId: 'sub-1',
      category: 'Electricity',
      reportingPeriod: 'monthly',
      periodValue,
      locationId,
      status: ActivityRecordStatus.approved,
      _count: { evidence: 1 },
      ...over,
    } as Partial<ActivityRecord>);

  it('is not found for a subsidiary outside the access set, and never queries', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });

    await expect(
      service.completeness(user, { subsidiaryId: 'sub-999', year: 2024 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Not found rather than forbidden, and refused before any query, so the
    // response cannot confirm the row exists.
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
    expect(prisma.location.findMany).not.toHaveBeenCalled();
  });

  it('returns no categories for a subsidiary measured as a whole', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    prisma.subsidiary.findUnique.mockResolvedValue({ trackingGranularity: 'subsidiary' });

    const d = await service.completeness(user, { subsidiaryId: 'sub-1', year: 2024 });

    // Empty is the honest answer, not zeroes: the rule does not apply, and the
    // granularity comes back so a caller can say which of those it is seeing.
    expect(d.categories).toEqual([]);
    expect(d.trackingGranularity).toBe('subsidiary');
    expect(d.locationCount).toBe(2);
  });

  it('marks each (location, month) slot, closed and open', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    prisma.activityRecord.findMany.mockResolvedValue([
      invoice('loc-1', 'January'),
      invoice('loc-1', 'March'),
      invoice('loc-2', 'January'),
    ]);

    const d = await service.completeness(user, { subsidiaryId: 'sub-1', year: 2024 });
    const electricity = d.categories.find((c) => c.category === 'Electricity')!;
    const ankara = electricity.locations.find((l) => l.locationId === 'loc-1')!;

    expect(ankara.locationName).toBe('Ankara Power Plant');
    expect(ankara.months).toHaveLength(12);
    expect(ankara.months.filter((m) => m.covered).map((m) => m.month)).toEqual([
      'January',
      'March',
    ]);
    // The open months are what the drawer renders; February must be one of them.
    expect(ankara.months.find((m) => m.month === 'February')!.covered).toBe(false);
  });

  it('agrees with the matrix about a cell whose only records were voided', async () => {
    // Both surfaces answer from `deriveCellStatus`, but they build its inputs
    // separately — so "one rule, two readings" only holds if both feed it the
    // same records. Reading a voided row as presence here (and its stale
    // anomaly flag) put `incomplete` on this panel against `missing` on the
    // dashboard, for the same cell.
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    prisma.activityRecord.findMany.mockResolvedValue([
      invoice('loc-1', 'January', {
        status: ActivityRecordStatus.voided,
        anomalyFlag: true,
      } as Partial<ActivityRecord>),
    ]);

    const d = await service.completeness(user, { subsidiaryId: 'sub-1', year: 2024 });
    const electricity = d.categories.find((c) => c.category === 'Electricity')!;

    expect(electricity.status).toBe('missing');
    expect(electricity.covered).toBe(0);
  });

  it('separates a month awaiting review from one that is accepted (DE-2)', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    prisma.activityRecord.findMany.mockResolvedValue([
      invoice('loc-1', 'January'),
      invoice('loc-1', 'February', {
        status: ActivityRecordStatus.submitted,
      } as Partial<ActivityRecord>),
    ]);

    const d = await service.completeness(user, { subsidiaryId: 'sub-1', year: 2024 });
    const electricity = d.categories.find((c) => c.category === 'Electricity')!;
    const ankara = electricity.locations.find((l) => l.locationId === 'loc-1')!;
    const month = (name: string) => ankara.months.find((m) => m.month === name)!;

    // Three states off two booleans — the entry screen needs to tell a user
    // which specific month is sitting in a review queue, not merely that one is.
    expect(month('January')).toMatchObject({ covered: true, awaitingReview: false });
    expect(month('February')).toMatchObject({ covered: true, awaitingReview: true });
    // The fourth combination must be unreachable: nothing to review where there
    // is nothing keyed in.
    expect(month('March')).toMatchObject({ covered: false, awaitingReview: false });
    expect(electricity.awaitingReviewSlots).toBe(1);
    expect(ankara.months.every((m) => m.covered || !m.awaitingReview)).toBe(true);
    // The VERDICT, not only the flags. This fixture is the only one in the file
    // that held an unreviewed record, and it asserted everything about that
    // record except the thing the record changes — so zeroing the count the
    // panel gates on left the whole suite green.
    expect(electricity.awaitingReviewRecords).toBe(1);
    expect(electricity.status).toBe('incomplete');
  });

  it('reports the record count that holds a fully covered category amber (WP19)', async () => {
    // The case the slot counters cannot express. Both sites hold all twelve
    // months, approved — `covered` is 24 of 24 and `awaitingReviewSlots` is 0 —
    // and one whole-company record for the same category is still with a
    // reviewer while its tonnage already counts. Without `awaitingReviewRecords`
    // on this response the panel shows an amber verdict and every sentence it
    // can build would read identically if that record were approved.
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    prisma.activityRecord.findMany.mockResolvedValue([
      ...LOCATIONS.flatMap((l) => months.map((m) => invoice(l.id, m))),
      invoice(null as unknown as string, 'January', {
        status: ActivityRecordStatus.submitted,
      } as Partial<ActivityRecord>),
    ]);

    const d = await service.completeness(user, { subsidiaryId: 'sub-1', year: 2024 });
    const electricity = d.categories.find((c) => c.category === 'Electricity')!;

    expect(electricity).toMatchObject({
      required: 24,
      covered: 24,
      awaitingReviewSlots: 0,
      unattributedRecords: 1,
      awaitingReviewRecords: 1,
    });
    expect(electricity.status).toBe('incomplete');
  });

  it('agrees with the matrix cell it drills into', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    // One of the three is UNREVIEWED on purpose. With every fixture `approved`
    // the two endpoints agreed in the only case where they cannot disagree,
    // which is not a guarantee — it is a tautology with an assertion around it.
    const records = [
      invoice('loc-1', 'January'),
      invoice('loc-2', 'February'),
      invoice('loc-2', 'March', {
        status: ActivityRecordStatus.submitted,
      } as Partial<ActivityRecord>),
    ];
    prisma.activityRecord.findMany.mockResolvedValue(records);
    prisma.subsidiary.findMany.mockResolvedValue([
      makeSubsidiary({
        id: 'sub-1',
        trackingGranularity: 'location',
        locations: [{ id: 'loc-1' }, { id: 'loc-2' }],
      } as Partial<Subsidiary>),
    ]);

    const drill = await service.completeness(user, { subsidiaryId: 'sub-1', year: 2024 });
    const matrix = await service.trackingMatrix(user, { subsidiaryId: 'sub-1', year: 2024 });

    const drillElectricity = drill.categories.find((c) => c.category === 'Electricity')!;
    const cell = matrix.rows[0].cells.find((c) => c.category === 'Electricity')!;

    // Both read the same `computeInvoiceCoverage`. This assertion is what makes
    // that structural fact observable: a drill-down free to disagree with the
    // cell that opened it is a second implementation of a compliance
    // denominator, and the user would have no way to know which is right.
    expect(drillElectricity.covered).toBe(cell.coverage!.covered);
    // The PR added a second number and a verdict that must ALSO agree across
    // the two endpoints — the panel shows what the cell shows, so a drift here
    // is a user seeing "Complete" on one screen and "Partial" on the other for
    // the same subsidiary, category and year.
    expect(drillElectricity.awaitingReviewSlots).toBe(
      cell.coverage!.awaitingReviewSlots,
    );
    expect(drillElectricity.status).toBe(cell.status);
    expect(drillElectricity.awaitingReviewRecords).toBe(cell.awaitingReviewRecords);
    // …and that shared verdict is the amber one, so the agreement above is
    // about a state the two endpoints reach separately.
    expect(cell.status).toBe('incomplete');
    expect(cell.awaitingReviewRecords).toBe(1);
    // And the per-slot flags must sum to the aggregate, or the month strip
    // contradicts the fraction printed directly above it.
    expect(
      drillElectricity.locations
        .flatMap((l) => l.months)
        .filter((m) => m.awaitingReview).length,
    ).toBe(cell.coverage!.awaitingReviewSlots);
    expect(drillElectricity.required).toBe(cell.coverage!.required);
    // ...and the slot grid must sum to the same figure.
    const closedSlots = drillElectricity.locations
      .flatMap((l) => l.months)
      .filter((m) => m.covered).length;
    expect(closedSlots).toBe(cell.coverage!.covered);
  });

  it('counts only locations that existed by the end of the reported year', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });

    await service.completeness(user, { subsidiaryId: 'sub-1', year: 2024 });

    // Same rule as the matrix multiplier, for the same reason: a grid with a
    // row for a site that did not exist asks the user to explain an absence
    // that was never possible.
    expect(prisma.location.findMany.mock.calls[0][0].where).toEqual({
      subsidiaryId: 'sub-1',
      createdAt: { lte: new Date('2024-12-31T23:59:59.999Z') },
    });
  });

  it('queries only the reported year and only committed statuses', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });

    await service.completeness(user, { subsidiaryId: 'sub-1', year: 2024 });

    // Dropping the year folds every year's records into one grid — precisely
    // what the mandatory `year` param exists to prevent.
    const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
    expect(where.reportingYear).toBe(2024);
    expect(where.subsidiaryId).toBe('sub-1');
    // The status filter is deliberately ABSENT now, where it used to be
    // asserted here. The response carries FR §2.2's verdict, and two of the
    // three caps behind it — a draft in the cell, an anomaly flag — are
    // invisible to a query that has already dropped those rows. Committing to
    // the JS filter also ends the split this assertion was written to police:
    // both endpoints now take the committed subset the same way.
    expect(where.status).toBeUndefined();
  });

  it('still refuses to let a draft close a slot, now that SQL no longer filters', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    prisma.activityRecord.findMany.mockResolvedValue([
      invoice('loc-1', 'January', {
        status: ActivityRecordStatus.draft,
      } as Partial<ActivityRecord>),
    ]);

    const d = await service.completeness(user, { subsidiaryId: 'sub-1', year: 2024 });
    const electricity = d.categories.find((c) => c.category === 'Electricity')!;

    // The invariant the old query-shape assertion was really protecting. It is
    // proved behaviourally now, which survives a refactor of where the filter
    // lives — and the old assertion would not have.
    expect(electricity.covered).toBe(0);
    expect(electricity.awaitingReviewSlots).toBe(0);
    expect(
      electricity.locations.flatMap((l) => l.months).some((m) => m.covered),
    ).toBe(false);
    // A draft is exactly what the extra query is FOR: the cell is not
    // "missing", because a record does exist and someone is working on it.
    expect(electricity.status).toBe('incomplete');
  });

  it('does not warn about a whole-company month that is only a draft', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    prisma.activityRecord.findMany.mockResolvedValue([
      invoice(null as unknown as string, 'February', {
        status: ActivityRecordStatus.draft,
      } as Partial<ActivityRecord>),
    ]);

    const d = await service.completeness(user, { subsidiaryId: 'sub-1', year: 2024 });

    // A draft feeds no total, so keying a site invoice for that month would not
    // double-count anything. Warning about it would be warning about something
    // that has not happened and may never — a regression the unfiltered query
    // would otherwise have introduced.
    expect(
      d.categories.find((c) => c.category === 'Electricity')!.companyLevelMonths,
    ).toEqual([]);
  });

  it('names the months that already hold a whole-company entry', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    prisma.activityRecord.findMany.mockResolvedValue([
      invoice('loc-1', 'January'),
      // Company-level: closes no site slot, but the screen must not invite the
      // user to key a site invoice for a month that is already recorded — both
      // rows would feed the emissions total for that month.
      invoice(null as unknown as string, 'February'),
      invoice(null as unknown as string, 'February'),
    ]);

    const d = await service.completeness(user, { subsidiaryId: 'sub-1', year: 2024 });
    const electricity = d.categories.find((c) => c.category === 'Electricity')!;

    expect(electricity.companyLevelMonths).toEqual(['february']);
    expect(electricity.unattributedRecords).toBe(2);
    // ...and February is still an OPEN site slot, because the rule counts sites.
    const ankara = electricity.locations.find((l) => l.locationId === 'loc-1')!;
    expect(ankara.months.find((m) => m.month === 'February')!.covered).toBe(false);
  });

  it('never counts an invoice at a site outside the denominator', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    // A location created after the year ended is dropped from the denominator.
    // Its invoices used to count into the numerator anyway, giving
    // `covered 1, required 0` — a green "Complete" cell reading 1/0, over a
    // grid with no row to explain it.
    prisma.location.findMany.mockResolvedValue([]);
    prisma.activityRecord.findMany.mockResolvedValue([invoice('loc-future', 'January')]);

    const d = await service.completeness(user, { subsidiaryId: 'sub-1', year: 2024 });
    const electricity = d.categories.find((c) => c.category === 'Electricity')!;

    expect(electricity.required).toBe(0);
    expect(electricity.covered).toBe(0);
    expect(electricity.covered).toBeLessThanOrEqual(electricity.required);
    // Declared rather than silently dropped — it is the only trace of an
    // invoice the grid cannot draw a row for.
    expect(electricity.outOfScopeRecords).toBe(1);
  });

  it('reports every invoice-tracked category, including one with nothing recorded', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });

    const d = await service.completeness(user, { subsidiaryId: 'sub-1', year: 2024 });

    expect(d.categories.map((c) => c.category)).toEqual([
      'Electricity',
      'Natural Gas',
      'Water',
    ]);
    // A category nobody has started still shows its shape: 2 locations x 12
    // open months. "0 of 24" tells the user the size of the job.
    const water = d.categories.find((c) => c.category === 'Water')!;
    expect(water.required).toBe(24);
    expect(water.covered).toBe(0);
    expect(water.locations.flatMap((l) => l.months).every((m) => !m.covered)).toBe(true);
  });
});

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

  it('counts a VOIDED record towards nothing, anywhere (the void path)', async () => {
    // The central claim of WP18 PR 2a, asserted by name rather than left to the
    // shape of a status list. A voided record is a figure a reviewer once
    // ACCEPTED and someone later withdrew: if any total still included it, the
    // withdrawal would be cosmetic and the inventory would be overstated by
    // exactly the amount someone decided did not belong in it.
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.subsidiary.findMany.mockResolvedValue([]);

    await service.summary(user, {});

    const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
    expect(where.status.in).not.toContain(ActivityRecordStatus.voided);

    // ...and on the matrix, which queries ALL statuses and filters in memory,
    // so a voided record reaches the loop and must be excluded there instead.
    prisma.subsidiary.findMany.mockResolvedValue([
      makeSubsidiary({ id: 'sub-1', trackingGranularity: 'subsidiary' } as Partial<Subsidiary>),
    ]);
    prisma.activityRecord.findMany.mockResolvedValue([
      makeRecord({
        subsidiaryId: 'sub-1',
        category: 'Electricity',
        status: ActivityRecordStatus.voided,
        calculation: { tCo2e: 999, factorId: 'f-1' },
      }),
    ]);

    const m = await service.trackingMatrix(user, { year: 2024 });
    const cell = m.rows[0].cells.find((c) => c.category === 'Electricity')!;

    // No figure, and no contribution to the row total.
    expect(cell.tCo2e).toBeNull();
    expect(m.rows[0].totalTCo2e).toBe(0);
    // `missing`, and this is the assertion that caught the bug. The cell used
    // to read COMPLETE: `hasRecords` meant "a row exists", and a voided row is
    // a row — so a category whose only figure had been deliberately withdrawn
    // showed green. Nothing is reported for this cell, and that is what the
    // colour has to say.
    expect(cell.status).toBe('missing');
    // The row is still accounted for, so the cell can explain itself rather
    // than pretending nothing was ever there.
    expect(cell.voidedRecordCount).toBe(1);
    expect(cell.recordCount).toBe(1);
  });

  it('separates the live and withdrawn records in a cell that holds both', async () => {
    // The single-record test could not tell `recs.length - live.length` from
    // `recs.length` — both are 1 when the only record is voided. A mixed cell
    // is what distinguishes them, and it also pins the three things a voided
    // row must not leak into: the tonnage, the anomaly flag, and "Updated".
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    prisma.subsidiary.findMany.mockResolvedValue([
      makeSubsidiary({ id: 'sub-1', trackingGranularity: 'subsidiary' } as Partial<Subsidiary>),
    ]);
    prisma.activityRecord.findMany.mockResolvedValue([
      makeRecord({
        subsidiaryId: 'sub-1',
        category: 'Electricity',
        status: ActivityRecordStatus.approved,
        calculation: { tCo2e: 12, factorId: 'f-1' },
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      makeRecord({
        subsidiaryId: 'sub-1',
        category: 'Electricity',
        status: ActivityRecordStatus.voided,
        anomalyFlag: true,
        calculation: { tCo2e: 999, factorId: 'f-1' },
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
    ]);


      const m = await service.trackingMatrix(user, { year: 2024 });
    const cell = m.rows[0].cells.find((c) => c.category === 'Electricity')!;

    expect(cell.recordCount).toBe(2);
    expect(cell.voidedRecordCount).toBe(1);
    // Only the live figure.
    expect(cell.tCo2e).toBe(12);
    // A withdrawn record's anomaly flag describes data that no longer counts.
    expect(cell.anomaly).toBe(false);
    // ...and withdrawing something is not an update to what remains, so the
    // cell must not read "updated in June" because of it.
    expect(cell.lastUpdate).toBe('2026-01-01T00:00:00.000Z');
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
      calculatedRecordCount: 0,
      uncalculatedRecordCount: 0,
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
      makeRecord({ subsidiaryId: 'sub-1', category: 'Electricity', scope: 2, calculation: { tCo2e: 60, factorId: 'f-1' } }),
      makeRecord({ subsidiaryId: 'sub-1', category: 'Natural Gas', scope: 1, calculation: { tCo2e: 30, factorId: 'f-1' } }),
      makeRecord({ subsidiaryId: 'sub-2', category: 'Electricity', scope: 2, calculation: { tCo2e: 10, factorId: 'f-1' } }),
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

  it('excludes a record with no calculated figure from every total, and declares it', async () => {
    const user = superAdmin();
    prisma.activityRecord.findMany.mockResolvedValue([
      makeRecord({ subsidiaryId: 'sub-1', category: 'Electricity', scope: 2, calculation: { tCo2e: 60, factorId: 'f-1' } }),
      // An invoice-tracked category with no factor (WP17 — Water): the snapshot
      // carries no tCO₂e at all.
      makeRecord({
        subsidiaryId: 'sub-1',
        category: 'Water',
        scope: 3,
        calculation: {
          category: 'Water',
          scope: 3,
          inputValue: 250,
          inputUnit: 'cubic_metres',
          reasonCode: 'no_emission_factor',
          reason: 'No emission factor is available for "Water"',
        },
      }),
    ]);
    prisma.subsidiary.findMany.mockResolvedValue([
      makeSubsidiary({ id: 'sub-1', tradingName: 'Energy Co' }),
    ]);

    const s = await service.summary(user, {});

    expect(s.totals).toEqual({ scope1: 0, scope2: 60, scope3: 0, total: 60 });
    // The assertion that matters: NO Water row. A `Water, 0 tCO₂e, 1 record`
    // entry in the breakdown reads as "we measured water and it was zero",
    // which is a claim nobody made.
    expect(s.byCategory.map((c) => c.category)).toEqual(['Electricity']);
    // recordCount stays the true committed-row count (the report tile and the
    // generation audit row both read it), and the split is explicit.
    expect(s.recordCount).toBe(2);
    expect(s.calculatedRecordCount).toBe(1);
    expect(s.recordCount).toBe(s.calculatedRecordCount + s.uncalculatedRecordCount);
    // ...and the excluded entry is declared rather than silently dropped, so
    // "2 committed records" and "1 counted" stay reconcilable.
    expect(s.uncalculatedRecordCount).toBe(1);
    expect(s.bySubsidiary[0].recordCount).toBe(1);
  });

  it('buckets monthly records into monthly, quarterly and yearly trends', async () => {
    const user = superAdmin();
    prisma.activityRecord.findMany.mockResolvedValue([
      makeRecord({ reportingPeriod: 'monthly', periodValue: 'January', scope: 2, calculation: { tCo2e: 5, factorId: 'f-1' } }),
      makeRecord({ reportingPeriod: 'monthly', periodValue: 'February', scope: 1, calculation: { tCo2e: 7, factorId: 'f-1' } }),
      makeRecord({ reportingPeriod: 'monthly', periodValue: 'April', scope: 2, calculation: { tCo2e: 3, factorId: 'f-1' } }),
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
      makeRecord({ reportingPeriod: 'annual', periodValue: 'Annual', scope: 1, calculation: { tCo2e: 40, factorId: 'f-1' } }),
    ]);
    prisma.subsidiary.findMany.mockResolvedValue([makeSubsidiary({ id: 'sub-1' })]);

    const s = await service.summary(user, {});

    expect(s.trend.monthly).toEqual([]);
    expect(s.trend.quarterly).toEqual([]);
    expect(s.trend.yearly.map((p) => [p.period, p.total])).toEqual([['2024', 40]]);
  });
});

describe('EmissionsService.trackingMatrix', () => {
  let prisma: PrismaMock;
  let service: EmissionsService;

  beforeEach(() => {
    seq = 0;
    prisma = createPrismaMock();
    service = new EmissionsService(prisma as unknown as PrismaService);
  });

  it('counts committed records the anomaly rule never ran on, without capping the cell', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    prisma.subsidiary.findMany.mockResolvedValue([
      makeSubsidiary({ id: 'sub-1', trackingGranularity: 'subsidiary' } as Partial<Subsidiary>),
    ]);
    prisma.activityRecord.findMany.mockResolvedValue([
      // Evaluated and clean.
      makeRecord({ subsidiaryId: 'sub-1', category: 'Electricity' }),
      // A short window — the rule did not run. Before WP21 this was
      // indistinguishable from the row above on every surface.
      makeRecord({
        subsidiaryId: 'sub-1',
        category: 'Electricity',
        periodValue: 'February',
        anomalyBaselinePriorCount: 2,
        anomalyBaselineTCo2e: null,
      }),
      // A FULL window averaging zero: three priors, an average, and still no
      // ratio. The case a hand-written `priorCount === 3` check would miss.
      makeRecord({
        subsidiaryId: 'sub-1',
        category: 'Electricity',
        periodValue: 'March',
        anomalyBaselinePriorCount: 3,
        anomalyBaselineTCo2e: 0,
      }),
      // No figure at all: already reported as `uncalculatedRecordCount`, so it
      // must NOT also land here or the two stop reconciling.
      makeRecord({
        subsidiaryId: 'sub-1',
        category: 'Electricity',
        periodValue: 'April',
        calculation: { reasonCode: 'no_emission_factor' },
        anomalyBaselinePriorCount: null,
        anomalyBaselineTCo2e: null,
      }),
      // A draft is not committed, so it is nobody's verdict to report.
      makeRecord({
        subsidiaryId: 'sub-1',
        category: 'Electricity',
        periodValue: 'May',
        status: ActivityRecordStatus.draft,
        anomalyBaselinePriorCount: 0,
        anomalyBaselineTCo2e: null,
      }),
    ]);

    const m = await service.trackingMatrix(user, { year: 2024 });
    const cell = m.rows[0].cells.find((c) => c.category === 'Electricity')!;

    expect(cell.notEvaluatedRecordCount).toBe(2);
    expect(cell.uncalculatedRecordCount).toBe(1);
    // Deliberately NOT a cap (decision 2026-08-27): a short window is the
    // normal state of a new series' first months, and amber-forever is not a
    // warning. The count is the disclosure; the colour is not.
    expect(cell.anomaly).toBe(false);
    expect(cell.status).not.toBe('missing');
  });

  it('returns an empty matrix for an empty accessible set without hitting the DB', async () => {
    const user = dataEntry({ accessibleSubsidiaryIds: [] });

    const m = await service.trackingMatrix(user, {});

    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
    expect(m).toEqual({
      reportingYear: null,
      rows: [],
      totals: { complete: 0, incomplete: 0, missing: 0 },
    });
  });

  it('scopes both queries to the accessible set and fetches ALL statuses', async () => {
    const user = dataEntry({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.subsidiary.findMany.mockResolvedValue([]);

    await service.trackingMatrix(user, { year: 2024 });

    const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
    expect(where.subsidiaryId).toEqual({ in: ['sub-1', 'sub-2'] });
    expect(where.reportingYear).toBe(2024);
    expect(where.status).toBeUndefined(); // drafts must be visible (yellow cells)
  });

  it('derives FR §2.2 cell statuses: missing / incomplete / complete', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    prisma.subsidiary.findMany.mockResolvedValue([
      makeSubsidiary({ id: 'sub-1', tradingName: 'Energy Co' }),
    ]);
    prisma.activityRecord.findMany.mockResolvedValue([
      // Electricity: one approved record -> complete, tCo2e counted
      makeRecord({ subsidiaryId: 'sub-1', category: 'Electricity', status: ActivityRecordStatus.approved, calculation: { tCo2e: 12, factorId: 'f-1' } }),
      // Natural Gas: approved + a draft -> incomplete; only approved tCo2e counted
      makeRecord({ subsidiaryId: 'sub-1', category: 'Natural Gas', status: ActivityRecordStatus.approved, calculation: { tCo2e: 5, factorId: 'f-1' } }),
      makeRecord({ subsidiaryId: 'sub-1', category: 'Natural Gas', status: ActivityRecordStatus.draft, calculation: { tCo2e: 999, factorId: 'f-1' } }),
      // Fuel: submitted but anomaly-flagged -> incomplete, tCo2e still counted
      makeRecord({ subsidiaryId: 'sub-1', category: 'Fuel', status: ActivityRecordStatus.submitted, anomalyFlag: true, calculation: { tCo2e: 7, factorId: 'f-1' } }),
    ]);

    const m = await service.trackingMatrix(user, {});
    const row = m.rows[0];
    const cell = (cat: string) => row.cells.find((c) => c.category === cat)!;

    expect(cell('Electricity').status).toBe('complete');
    expect(cell('Electricity').tCo2e).toBe(12);

    expect(cell('Natural Gas').status).toBe('incomplete');
    expect(cell('Natural Gas').tCo2e).toBe(5); // draft's 999 excluded
    expect(cell('Natural Gas').recordCount).toBe(2);

    expect(cell('Fuel').status).toBe('incomplete');
    expect(cell('Fuel').anomaly).toBe(true);
    expect(cell('Fuel').tCo2e).toBe(7);

    // Untouched category -> missing, no timestamp
    expect(cell('Waste').status).toBe('missing');
    expect(cell('Waste').lastUpdate).toBeNull();

    // Row rollups: 1 complete, 11 categories, total = 12 + 5 + 7
    expect(row.completeCount).toBe(1);
    expect(row.categoryCount).toBe(11);
    expect(row.totalTCo2e).toBe(24);

    // Matrix totals: 1 complete + 2 incomplete + 8 missing
    expect(m.totals).toEqual({ complete: 1, incomplete: 2, missing: 8 });
  });

  it('keeps an evidence-required cell incomplete until a file is attached (FR §2.2)', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    prisma.subsidiary.findMany.mockResolvedValue([makeSubsidiary({ id: 'sub-1' })]);
    prisma.activityRecord.findMany.mockResolvedValue([
      // Approved Electricity (evidence-required) with NO evidence -> incomplete.
      makeRecord({ subsidiaryId: 'sub-1', category: 'Electricity', status: ActivityRecordStatus.approved, calculation: { tCo2e: 12, factorId: 'f-1' }, _count: { evidence: 0 } } as Partial<ActivityRecord>),
      // Approved Purchased Goods (NOT evidence-required) with no evidence ->
      // still complete. Water used to play this role and no longer can: it is
      // evidence-required as of WP17, and it can no longer carry a tCO₂e at all.
      makeRecord({ subsidiaryId: 'sub-1', category: 'Purchased Goods', scope: 3, status: ActivityRecordStatus.approved, calculation: { tCo2e: 4, factorId: 'f-1' }, _count: { evidence: 0 } } as Partial<ActivityRecord>),
    ]);

    const m = await service.trackingMatrix(user, {});
    const cell = (cat: string) => m.rows[0].cells.find((c) => c.category === cat)!;

    expect(cell('Electricity').status).toBe('incomplete'); // evidence required, none attached
    expect(cell('Electricity').tCo2e).toBe(12); // tCo2e still counted
    expect(cell('Purchased Goods').status).toBe('complete'); // evidence not required
  });

  it('a factor-less record leaves its cell short of complete until the invoice is attached', async () => {
    const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
    prisma.subsidiary.findMany.mockResolvedValue([makeSubsidiary({ id: 'sub-1' })]);
    prisma.activityRecord.findMany.mockResolvedValue([
      // What a real Water record looks like post-WP17: approved, no figure.
      makeRecord({
        subsidiaryId: 'sub-1',
        category: 'Water',
        scope: 3,
        status: ActivityRecordStatus.approved,
        calculation: {
          snapshotSchema: 1,
          category: 'Water',
          scope: 3,
          inputValue: 250,
          inputUnit: 'cubic_metres',
          reasonCode: 'no_emission_factor',
          reason: 'No emission factor is available for "Water"',
        },
        _count: { evidence: 0 },
      } as Partial<ActivityRecord>),
    ]);

    const m = await service.trackingMatrix(user, {});
    const water = m.rows[0].cells.find((c) => c.category === 'Water')!;

    // Water joined EVIDENCE_REQUIRED_CATEGORIES precisely so this cell cannot
    // go green on an unverifiable number: no factor means no figure, and no
    // figure means the anomaly baseline never sees it either. The invoice is
    // the only check such a record can carry.
    expect(water.status).toBe('incomplete');
    // `null`, not `0` — this assertion said `0` when it was written, which is
    // the misstatement WP17 PR 2 closed at the contract level: a hard zero in a
    // `number`-typed field is indistinguishable from a measurement.
    expect(water.tCo2e).toBeNull();
    expect(water.recordCount).toBe(1);
    expect(water.uncalculatedRecordCount).toBe(1);
  });

  describe('location granularity — the invoice denominator (WP17 / DASH-3)', () => {
    const LOCATION_SUB = () =>
      makeSubsidiary({
        id: 'sub-1',
        trackingGranularity: 'location',
        locations: [{ id: 'loc-1' }, { id: 'loc-2' }],
      } as Partial<Subsidiary>);

    /** A committed monthly invoice for one location. */
    const invoice = (
      locationId: string,
      periodValue: string,
      over: Partial<ActivityRecord> = {},
    ) =>
      makeRecord({
        subsidiaryId: 'sub-1',
        category: 'Electricity',
        scope: 2,
        status: ActivityRecordStatus.approved,
        reportingPeriod: 'monthly',
        periodValue,
        locationId,
        _count: { evidence: 1 },
        ...over,
      } as Partial<ActivityRecord>);

    it('requires locations × 12 per invoice-tracked category, and reports the shortfall', async () => {
      const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.subsidiary.findMany.mockResolvedValue([LOCATION_SUB()]);
      prisma.activityRecord.findMany.mockResolvedValue([
        invoice('loc-1', 'January'),
        invoice('loc-1', 'February'),
        invoice('loc-2', 'January'),
      ]);

      const m = await service.trackingMatrix(user, { year: 2024 });
      const cell = (c: string) => m.rows[0].cells.find((x) => x.category === c)!;

      // 2 locations × 12 months = 24 slots per category; 3 are closed.
      expect(cell('Electricity').coverage).toMatchObject({ required: 24, covered: 3 });
      expect(cell('Electricity').status).toBe('incomplete');
      // The other two invoice categories have nothing at all — and they still
      // carry a denominator, which is what makes "0 of 24" expressible. A cell
      // that short-circuited on "no records" would report `missing` with no
      // numbers and the user could not tell 24 from 240.
      expect(cell('Water').coverage).toMatchObject({ required: 24, covered: 0 });
      expect(cell('Water').status).toBe('missing');
      expect(cell('Natural Gas').coverage).toMatchObject({ required: 24, covered: 0 });
      // A category outside the invoice rule keeps the yes/no shape — no
      // coverage object at all, so a UI cannot render "0/0" for it.
      expect(cell('Fuel').coverage).toBeUndefined();
      expect(m.rows[0].trackingGranularity).toBe('location');
      expect(m.rows[0].locationCount).toBe(2);
    });

    it('turns complete only when every location has all twelve months', async () => {
      const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.subsidiary.findMany.mockResolvedValue([
        makeSubsidiary({
          id: 'sub-1',
          trackingGranularity: 'location',
          locations: [{ id: 'loc-1' }],
        } as Partial<Subsidiary>),
      ]);
      const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ];
      prisma.activityRecord.findMany.mockResolvedValue(
        months.map((mth) => invoice('loc-1', mth)),
      );

      const m = await service.trackingMatrix(user, { year: 2024 });
      const electricity = m.rows[0].cells.find((c) => c.category === 'Electricity')!;

      expect(electricity.coverage).toMatchObject({ required: 12, covered: 12 });
      expect(electricity.status).toBe('complete');
      // Nothing is waiting on a reviewer, which is the other half of why this
      // cell may be green — see the DE-2 block below.
      expect(electricity.coverage).toMatchObject({ awaitingReviewSlots: 0 });
    });

    /**
     * Round-1 **DE-2**: "On submit for review, the data-collection status turns
     * green immediately."
     *
     * It did, and PRs 2–3 did not touch it — they fixed the DENOMINATOR. The
     * numerator counted a `submitted` record as a closed slot, because
     * `COUNTED_STATUSES` includes it (rightly — the inventory must not lose data
     * queued for review) while `PENDING_STATUSES` only catches draft/rejected.
     * So twelve invoices nobody had looked at turned the cell green.
     */
    describe('submitting is not finishing (DE-2)', () => {
      const ALL_MONTHS = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ];

      const oneLocationSub = () =>
        makeSubsidiary({
          id: 'sub-1',
          trackingGranularity: 'location',
          locations: [{ id: 'loc-1' }],
        } as Partial<Subsidiary>);

      const matrixFor = async (records: ActivityRecord[]) => {
        const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
        prisma.subsidiary.findMany.mockResolvedValue([oneLocationSub()]);
        prisma.activityRecord.findMany.mockResolvedValue(records);
        const m = await service.trackingMatrix(user, { year: 2024 });
        return m.rows[0].cells.find((c) => c.category === 'Electricity')!;
      };

      it('holds a fully-keyed year yellow while every invoice awaits review', async () => {
        const cell = await matrixFor(
          ALL_MONTHS.map((mth) =>
            invoice('loc-1', mth, {
              status: ActivityRecordStatus.submitted,
            } as Partial<ActivityRecord>),
          ),
        );

        // Every slot IS closed — the data is all in, and the coverage fraction
        // says so. What is not true is that the collection is finished.
        expect(cell.coverage).toMatchObject({
          required: 12,
          covered: 12,
          awaitingReviewSlots: 12,
        });
        expect(cell.status).toBe('incomplete');
      });

      it('holds it yellow for a single un-reviewed month among eleven approved', async () => {
        const cell = await matrixFor([
          ...ALL_MONTHS.slice(0, 11).map((mth) => invoice('loc-1', mth)),
          invoice('loc-1', 'December', {
            status: ActivityRecordStatus.submitted,
          } as Partial<ActivityRecord>),
        ]);

        // A count, not a flag: the screen has to be able to say "1 of 12 still
        // awaiting review" rather than just that something is.
        expect(cell.coverage).toMatchObject({ covered: 12, awaitingReviewSlots: 1 });
        expect(cell.status).toBe('incomplete');
      });

      it('counts under_review as awaiting and locked as accepted', async () => {
        const underReview = await matrixFor(
          ALL_MONTHS.map((mth) =>
            invoice('loc-1', mth, {
              status: ActivityRecordStatus.under_review,
            } as Partial<ActivityRecord>),
          ),
        );
        // A reviewer has opened it but not accepted it. Still not finished.
        expect(underReview.coverage).toMatchObject({ awaitingReviewSlots: 12 });
        expect(underReview.status).toBe('incomplete');

        const locked = await matrixFor(
          ALL_MONTHS.map((mth) =>
            invoice('loc-1', mth, {
              status: ActivityRecordStatus.locked,
            } as Partial<ActivityRecord>),
          ),
        );
        // A locked period is approved data that a lock froze — accepted, so the
        // cell is green. Reading the set as `approved` alone would have turned
        // every locked period yellow the moment this cap shipped.
        expect(locked.coverage).toMatchObject({ awaitingReviewSlots: 0 });
        expect(locked.status).toBe('complete');
      });

      it('never counts an un-reviewed record that closed no slot', async () => {
        const cell = await matrixFor([
          // Submitted, but with no invoice attached — it closes nothing, so it
          // is a missing-evidence record and NOT something awaiting review.
          // `awaitingReviewSlots` is a subset of `covered`; if it could exceed
          // it, a cell could report "0 covered, 1 awaiting review".
          invoice('loc-1', 'January', {
            status: ActivityRecordStatus.submitted,
            _count: { evidence: 0 },
          } as Partial<ActivityRecord>),
          // Submitted at company level: closes no site slot either.
          invoice(null as unknown as string, 'February', {
            status: ActivityRecordStatus.submitted,
          } as Partial<ActivityRecord>),
        ]);

        expect(cell.coverage).toMatchObject({
          covered: 0,
          awaitingReviewSlots: 0,
          missingEvidenceRecords: 1,
          unattributedRecords: 1,
        });
      });

      it('lets an approved invoice win over an un-reviewed one for the same slot', async () => {
        const cell = await matrixFor([
          invoice('loc-1', 'January', {
            status: ActivityRecordStatus.submitted,
          } as Partial<ActivityRecord>),
          invoice('loc-1', 'January'),
        ]);

        // One accepted invoice covers the month whatever else was filed against
        // it. Tracking "awaiting" directly instead of subtracting the accepted
        // set would have left this slot in both buckets at once.
        expect(cell.coverage).toMatchObject({ covered: 1, awaitingReviewSlots: 0 });
      });

      it('holds a fully covered cell amber for an unreviewed record that closed no slot', async () => {
        // WP19. Twelve approved invoices close every slot, and a thirteenth
        // record — company-level, so it closes nothing — is still waiting for a
        // reviewer while its tonnage is already inside the cell's figure. The
        // slot-level test alone could not see this: `awaitingReview` is
        // `covered` minus the accepted slots, and every covered slot here WAS
        // accepted. Same for an unreviewed duplicate filed against a month an
        // approved invoice already covers.
        const cell = await matrixFor([
          ...ALL_MONTHS.map((mth) => invoice('loc-1', mth)),
          invoice(null as unknown as string, 'January', {
            status: ActivityRecordStatus.submitted,
          } as Partial<ActivityRecord>),
        ]);

        expect(cell.coverage).toMatchObject({
          required: 12,
          covered: 12,
          awaitingReviewSlots: 0,
          unattributedRecords: 1,
        });
        expect(cell.awaitingReviewRecords).toBe(1);
        expect(cell.status).toBe('incomplete');
      });
    });

    /**
     * WP19 — the same gate on the branch WP17 deliberately left alone.
     *
     * The eight yes/no categories reach `deriveCellStatus` with `coverage:
     * null`, and so does EVERY invoice category on a subsidiary-measured row or
     * a year-less query — four of the five seeded subsidiaries are exactly
     * that. Until the 2026-08-21 decision this branch returned `complete` as
     * soon as a record existed and was neither draft nor rejected, so Fuel,
     * Waste, Business Travel and the rest went green the moment they were SENT
     * for review: round-1 DE-2's complaint, in the branch its fix skipped.
     *
     * Unobservable on seeded data — the seed hard-codes `approved` on every
     * record — so these specs are the only thing holding the behaviour.
     */
    describe('submitting is not finishing on the yes/no branch either (WP19)', () => {
      const plainSub = () =>
        makeSubsidiary({
          id: 'sub-1',
          trackingGranularity: 'subsidiary',
          locations: [],
        } as Partial<Subsidiary>);

      /** A committed record in a category outside the invoice rule. */
      const wasteRecord = (over: Partial<ActivityRecord> = {}) =>
        makeRecord({
          subsidiaryId: 'sub-1',
          category: 'Waste',
          scope: 3,
          status: ActivityRecordStatus.approved,
          reportingPeriod: 'monthly',
          periodValue: 'January',
          _count: { evidence: 0 },
          ...over,
        } as Partial<ActivityRecord>);

      const cellFor = async (records: ActivityRecord[], category = 'Waste') => {
        const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
        prisma.subsidiary.findMany.mockResolvedValue([plainSub()]);
        prisma.activityRecord.findMany.mockResolvedValue(records);
        const m = await service.trackingMatrix(user, { year: 2024 });
        return m.rows[0].cells.find((c) => c.category === category)!;
      };

      it('holds the cell amber while its only record awaits review', async () => {
        const cell = await cellFor([
          wasteRecord({
            status: ActivityRecordStatus.submitted,
          } as Partial<ActivityRecord>),
        ]);

        expect(cell.status).toBe('incomplete');
        expect(cell.awaitingReviewRecords).toBe(1);
        // No denominator on this branch, so the count is the entire explanation
        // a screen has to work with — which is why it is on the wire at all.
        expect(cell.coverage).toBeUndefined();
      });

      it('does not leak the count into a neighbouring category or row', async () => {
        // The accumulator is declared per CELL. Hoisting it one level — to the
        // row, or to the whole matrix — makes one unreviewed record turn every
        // later category amber, and every test that inspects only the cell it
        // wrote to stays green through it. Same shape as the leak WP18 found.
        const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });
        prisma.subsidiary.findMany.mockResolvedValue([
          plainSub(),
          makeSubsidiary({
            id: 'sub-2',
            trackingGranularity: 'subsidiary',
            locations: [],
          } as Partial<Subsidiary>),
        ]);
        prisma.activityRecord.findMany.mockResolvedValue([
          wasteRecord({
            status: ActivityRecordStatus.submitted,
          } as Partial<ActivityRecord>),
          // A neighbour in the same row, fully accepted.
          wasteRecord({
            category: 'Business Travel',
            status: ActivityRecordStatus.approved,
          } as Partial<ActivityRecord>),
        ]);

        const m = await service.trackingMatrix(user, { year: 2024 });
        const cellIn = (subId: string, category: string) =>
          m.rows
            .find((r) => r.subsidiaryId === subId)!
            .cells.find((c) => c.category === category)!;

        expect(cellIn('sub-1', 'Waste').awaitingReviewRecords).toBe(1);
        // Next category in the same row: accepted data, and it must stay green.
        expect(cellIn('sub-1', 'Business Travel').awaitingReviewRecords).toBe(0);
        expect(cellIn('sub-1', 'Business Travel').status).toBe('complete');
        // A category with nothing in it at all, after the amber one.
        expect(cellIn('sub-1', 'Commuting').awaitingReviewRecords).toBe(0);
        expect(cellIn('sub-1', 'Commuting').status).toBe('missing');
        // And the next subsidiary starts from zero.
        expect(cellIn('sub-2', 'Waste').awaitingReviewRecords).toBe(0);
        expect(cellIn('sub-2', 'Waste').status).toBe('missing');
        expect(m.totals.incomplete).toBe(1);
      });

      it('turns green once a human has accepted it', async () => {
        const cell = await cellFor([wasteRecord()]);

        expect(cell.status).toBe('complete');
        expect(cell.awaitingReviewRecords).toBe(0);
      });

      it('reads under_review as awaiting and locked as accepted', async () => {
        const under = await cellFor([
          wasteRecord({
            status: ActivityRecordStatus.under_review,
          } as Partial<ActivityRecord>),
        ]);
        expect(under.status).toBe('incomplete');
        expect(under.awaitingReviewRecords).toBe(1);

        // A locked period is approved data that a lock froze — accepted. Reading
        // the reviewed set as `approved` alone would turn every locked period
        // amber the moment this gate shipped.
        const locked = await cellFor([
          wasteRecord({
            status: ActivityRecordStatus.locked,
          } as Partial<ActivityRecord>),
        ]);
        expect(locked.status).toBe('complete');
        expect(locked.awaitingReviewRecords).toBe(0);
      });

      it('counts only the unreviewed records, and one is enough to hold the cell', async () => {
        const cell = await cellFor([
          wasteRecord({ periodValue: 'January' } as Partial<ActivityRecord>),
          wasteRecord({ periodValue: 'February' } as Partial<ActivityRecord>),
          wasteRecord({
            periodValue: 'March',
            status: ActivityRecordStatus.submitted,
          } as Partial<ActivityRecord>),
        ]);

        expect(cell.recordCount).toBe(3);
        expect(cell.awaitingReviewRecords).toBe(1);
        expect(cell.status).toBe('incomplete');
      });

      it('leaves draft and rejected records out of the count', async () => {
        // They hold the cell amber through `hasPending`, not through this
        // counter. A draft is not data anyone has been ASKED to review, and
        // counting it here would make the sentence on the cell untrue.
        const cell = await cellFor([
          wasteRecord({
            status: ActivityRecordStatus.draft,
          } as Partial<ActivityRecord>),
          wasteRecord({
            periodValue: 'February',
            status: ActivityRecordStatus.rejected,
          } as Partial<ActivityRecord>),
        ]);

        expect(cell.status).toBe('incomplete');
        expect(cell.awaitingReviewRecords).toBe(0);
      });

      it('keeps the draft cap and the review gate as separate facts', async () => {
        // Both true at once, and they are not the same claim: a draft is work
        // the author has not finished, an unreviewed record is work waiting on
        // someone else. A counter that folded them together would make the
        // cell's sentence — "2 entries are keyed in but nobody has reviewed
        // them yet" — untrue about the draft.
        const cell = await cellFor([
          wasteRecord({
            status: ActivityRecordStatus.draft,
          } as Partial<ActivityRecord>),
          wasteRecord({
            periodValue: 'February',
            status: ActivityRecordStatus.submitted,
          } as Partial<ActivityRecord>),
        ]);

        expect(cell.status).toBe('incomplete');
        expect(cell.recordCount).toBe(2);
        expect(cell.awaitingReviewRecords).toBe(1);
      });

      it('reports 0 on a cell holding no records at all', async () => {
        const cell = await cellFor([]);

        expect(cell.status).toBe('missing');
        expect(cell.awaitingReviewRecords).toBe(0);
      });

      it('ignores a voided record, which counts towards nothing', async () => {
        const cell = await cellFor([
          wasteRecord({
            status: ActivityRecordStatus.voided,
          } as Partial<ActivityRecord>),
        ]);

        expect(cell.status).toBe('missing');
        expect(cell.awaitingReviewRecords).toBe(0);
        expect(cell.voidedRecordCount).toBe(1);
      });

      it('gates an invoice category on a subsidiary-measured row as well', async () => {
        // The strict rule needs `byLocation && isInvoiceTracked && year`, so
        // Electricity on a subsidiary-measured entity has always been HERE.
        // Framing the decision as "the three utility categories are stricter"
        // would have been wrong about most of the matrix.
        const cell = await cellFor(
          [
            wasteRecord({
              category: 'Electricity',
              scope: 2,
              status: ActivityRecordStatus.submitted,
              _count: { evidence: 1 },
            } as Partial<ActivityRecord>),
          ],
          'Electricity',
        );

        expect(cell.coverage).toBeUndefined();
        expect(cell.status).toBe('incomplete');
        expect(cell.awaitingReviewRecords).toBe(1);
      });
    });

    it('counts a second invoice for the same location and month once', async () => {
      const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.subsidiary.findMany.mockResolvedValue([LOCATION_SUB()]);
      prisma.activityRecord.findMany.mockResolvedValue([
        invoice('loc-1', 'January'),
        // Same slot, different casing/whitespace — one month's coverage, not two.
        invoice('loc-1', ' january '),
      ]);

      const m = await service.trackingMatrix(user, { year: 2024 });
      expect(
        m.rows[0].cells.find((c) => c.category === 'Electricity')!.coverage,
      ).toMatchObject({ covered: 1 });
    });

    it('closes no slot without an invoice attached', async () => {
      const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.subsidiary.findMany.mockResolvedValue([LOCATION_SUB()]);
      prisma.activityRecord.findMany.mockResolvedValue([
        invoice('loc-1', 'January', { _count: { evidence: 0 } } as Partial<ActivityRecord>),
      ]);

      const m = await service.trackingMatrix(user, { year: 2024 });
      // The invoice IS the unit of completeness — a reading with no document
      // behind it is exactly what the rule exists to distinguish.
      expect(
        m.rows[0].cells.find((c) => c.category === 'Electricity')!.coverage,
      ).toMatchObject({ covered: 0 });
    });

    it('reports subsidiary-level and non-monthly records instead of silently ignoring them', async () => {
      const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.subsidiary.findMany.mockResolvedValue([LOCATION_SUB()]);
      prisma.activityRecord.findMany.mockResolvedValue([
        // Attached to no location: 96 of the 102 seeded records look like this.
        invoice(null as unknown as string, 'January'),
        // Quarterly: one invoice per MONTH cannot live inside a quarter.
        invoice('loc-1', 'Q1', { reportingPeriod: 'quarterly' } as Partial<ActivityRecord>),
      ]);

      const m = await service.trackingMatrix(user, { year: 2024 });
      const cell = m.rows[0].cells.find((c) => c.category === 'Electricity')!;

      expect(cell.coverage).toMatchObject({
        covered: 0,
        unattributedRecords: 1,
        nonMonthlyRecords: 1,
      });
      // Both are counted rather than dropped: a user looking at "0 of 24
      // covered" beside "2 records exist" needs the two numbers reconciled, or
      // the screen reads as data loss.
      expect(cell.recordCount).toBe(2);
    });

    it('keeps a subsidiary-granularity row off the invoice denominator, locations or not', async () => {
      const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.subsidiary.findMany.mockResolvedValue([
        makeSubsidiary({
        id: 'sub-1',
        locations: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }, { id: 'l4' }],
      } as Partial<Subsidiary>),
      ]);
      prisma.activityRecord.findMany.mockResolvedValue([
        // One committed record with its file — complete under the old rule,
        // and nowhere near 4 × 12 invoices under the new one.
        invoice(null as unknown as string, 'January'),
      ]);

      const m = await service.trackingMatrix(user, { year: 2024 });
      const electricity = m.rows[0].cells.find((c) => c.category === 'Electricity')!;

      // Owning locations must not switch the rule on by itself — that is the
      // whole reason granularity is an explicit setting.
      expect(electricity.status).toBe('complete');
      expect(electricity.coverage).toBeUndefined();
      expect(m.rows[0].trackingGranularity).toBe('subsidiary');
    });

    it('a DRAFT invoice closes no slot', async () => {
      const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.subsidiary.findMany.mockResolvedValue([LOCATION_SUB()]);
      prisma.activityRecord.findMany.mockResolvedValue([
        invoice('loc-1', 'January', {
          status: ActivityRecordStatus.draft,
        } as Partial<ActivityRecord>),
      ]);

      const m = await service.trackingMatrix(user, { year: 2024 });

      // An invoice nobody has submitted is not an invoice the inventory has
      // accepted. Letting drafts close slots was a surviving mutant.
      expect(
        m.rows[0].cells.find((c) => c.category === 'Electricity')!.coverage,
      ).toMatchObject({ covered: 0 });
    });

    it('caps a fully covered cell below complete when something is flagged or unfinished', async () => {
      const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
      const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ];
      const oneLocation = () =>
        makeSubsidiary({
          id: 'sub-1',
          trackingGranularity: 'location',
          _count: { locations: 1 },
        } as Partial<Subsidiary>);

      // (a) anomaly
      prisma.subsidiary.findMany.mockResolvedValue([oneLocation()]);
      prisma.activityRecord.findMany.mockResolvedValue([
        ...months.map((mth) => invoice('loc-1', mth)),
        invoice('loc-1', 'January', { anomalyFlag: true } as Partial<ActivityRecord>),
      ]);
      let m = await service.trackingMatrix(user, { year: 2024 });
      expect(m.rows[0].cells.find((c) => c.category === 'Electricity')!.status).toBe(
        'incomplete',
      );

      // (b) an unfinished record beside full coverage
      prisma.subsidiary.findMany.mockResolvedValue([oneLocation()]);
      prisma.activityRecord.findMany.mockResolvedValue([
        ...months.map((mth) => invoice('loc-1', mth)),
        invoice('loc-1', 'January', {
          status: ActivityRecordStatus.draft,
        } as Partial<ActivityRecord>),
      ]);
      m = await service.trackingMatrix(user, { year: 2024 });
      // Full invoice coverage does not answer "there is an unfinished record
      // here" — FR §2.2's yellow means exactly that something is left to look
      // at, and the yes/no branch has always said so. Both caps were surviving
      // mutants: the suite accepted either behaviour.
      expect(m.rows[0].cells.find((c) => c.category === 'Electricity')!.status).toBe(
        'incomplete',
      );
    });

    it('counts a committed monthly record with no file, so the numbers reconcile', async () => {
      const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.subsidiary.findMany.mockResolvedValue([LOCATION_SUB()]);
      prisma.activityRecord.findMany.mockResolvedValue([
        invoice('loc-1', 'January', { _count: { evidence: 0 } } as Partial<ActivityRecord>),
      ]);

      const cov = (await service.trackingMatrix(user, { year: 2024 })).rows[0].cells.find(
        (c) => c.category === 'Electricity',
      )!.coverage!;

      // Without this counter the record fell through every bucket: not
      // covered, not unattributed, not non-monthly — and the coverage object
      // could not explain its own shortfall, which is the only thing it is for.
      expect(cov.missingEvidenceRecords).toBe(1);
      expect(
        cov.covered + cov.unattributedRecords + cov.nonMonthlyRecords + cov.missingEvidenceRecords,
      ).toBe(1);
    });

    it('emits no coverage for a year-less query, because the denominator is per-year', async () => {
      const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.subsidiary.findMany.mockResolvedValue([LOCATION_SUB()]);
      prisma.activityRecord.findMany.mockResolvedValue([invoice('loc-1', 'January')]);

      const m = await service.trackingMatrix(user, {});

      // `required` is twelve months' worth. Unscoped, every year's records fold
      // into one cell, so twelve invoices from 2023 would satisfy a 2026 cell.
      // The rule falls back to yes/no rather than answering a question the
      // numbers cannot support.
      expect(m.rows[0].cells.find((c) => c.category === 'Electricity')!.coverage).toBeUndefined();
    });

    it('counts only locations that existed by the end of the reported year', async () => {
      const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.subsidiary.findMany.mockResolvedValue([LOCATION_SUB()]);
      prisma.activityRecord.findMany.mockResolvedValue([]);

      await service.trackingMatrix(user, { year: 2024 });

      // Otherwise opening a third site in 2027 makes the 2024 matrix demand 36
      // invoices instead of 24 — twelve slots that could never have been
      // filled — and a closed year turns red with nobody having decided
      // anything.
      const select = prisma.subsidiary.findMany.mock.calls[0][0].select;
      expect(select.locations).toEqual({
        select: { id: true },
        where: { createdAt: { lte: new Date('2024-12-31T23:59:59.999Z') } },
      });
    });

    it('scopes to one subsidiary, and returns empty for one outside the access set', async () => {
      const user = superAdmin({ accessibleSubsidiaryIds: ['sub-1'] });
      prisma.subsidiary.findMany.mockResolvedValue([LOCATION_SUB()]);
      prisma.activityRecord.findMany.mockResolvedValue([]);

      await service.trackingMatrix(user, { year: 2024, subsidiaryId: 'sub-1' });
      expect(prisma.activityRecord.findMany.mock.calls[0][0].where.subsidiaryId).toBe('sub-1');

      prisma.activityRecord.findMany.mockClear();
      const denied = await service.trackingMatrix(user, { year: 2024, subsidiaryId: 'sub-999' });
      expect(denied.rows).toEqual([]);
      // Never a 403, and never a query: the response cannot confirm the row exists.
      expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
    });
  });

  it('gives every accessible subsidiary a row even with zero records', async () => {
    const user = dataEntry({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] });
    prisma.subsidiary.findMany.mockResolvedValue([
      makeSubsidiary({ id: 'sub-1', tradingName: 'Energy Co' }),
      makeSubsidiary({ id: 'sub-2', tradingName: null, legalName: 'Gas Legal Ltd.' }),
    ]);
    prisma.activityRecord.findMany.mockResolvedValue([]);

    const m = await service.trackingMatrix(user, {});

    expect(m.rows).toHaveLength(2);
    expect(m.rows[1].subsidiaryName).toBe('Gas Legal Ltd.'); // legalName fallback
    expect(m.rows.every((r) => r.cells.every((c) => c.status === 'missing'))).toBe(true);
    expect(m.totals).toEqual({ complete: 0, incomplete: 0, missing: 22 });
  });
});

/**
 * The two exported pure functions behind every completeness surface.
 *
 * Tested directly because both carry guards that neither endpoint can reach
 * today: `trackingMatrix` and `completeness` both pre-filter to committed
 * records, and neither seeds a zero denominator. Both guards survived mutation
 * testing through the endpoints — deleting either changed no test — which is
 * exactly the state in which a later refactor removes them as dead weight.
 */
describe('the shared completeness primitives', () => {
  const coverage = (over: Partial<ReturnType<typeof computeInvoiceCoverage>> = {}) => ({
    required: 12,
    covered: new Set<string>(),
    unattributedRecords: 0,
    nonMonthlyRecords: 0,
    missingEvidenceRecords: 0,
    outOfScopeRecords: 0,
    awaitingReview: new Set<string>(),
    ...over,
  });

  const verdict = (over = {}) =>
    deriveCellStatus({
      hasRecords: true,
      hasPending: false,
      anomaly: false,
      evidenceMissing: false,
      awaitingReviewRecords: 0,
      coverage: null,
      ...over,
    });

  describe('deriveCellStatus', () => {
    it('refuses to call a zero denominator complete', () => {
      // Reachable: a location-measured subsidiary whose sites all postdate the
      // reported year has `required === 0`, and `0 >= 0` reported `complete` —
      // a green tick over a year in which nothing was tracked, sitting next to
      // records that closed nothing.
      expect(
        verdict({ coverage: coverage({ required: 0 }), evidenceMissing: false }),
      ).toBe('incomplete');
    });

    it('is missing only when no record exists at all', () => {
      expect(verdict({ hasRecords: false, coverage: coverage() })).toBe('missing');
      // Twelve approved evidence-backed records whose slots are not closed is
      // INCOMPLETE. The seed produced exactly that, and an earlier cut rendered
      // a red "Missing" cell displaying 198 tCO2e.
      expect(verdict({ coverage: coverage({ covered: new Set(['a']) }) })).toBe(
        'incomplete',
      );
    });

    it('applies the three shared caps to a fully covered cell', () => {
      const full = coverage({
        required: 1,
        covered: new Set(['loc-1\u0000january']),
      });
      expect(verdict({ coverage: full })).toBe('complete');
      expect(verdict({ coverage: full, hasPending: true })).toBe('incomplete');
      expect(verdict({ coverage: full, anomaly: true })).toBe('incomplete');
      expect(verdict({ coverage: full, evidenceMissing: true })).toBe('incomplete');
    });

    it('holds a yes/no cell amber while committed data awaits review', () => {
      // WP19. Until the 2026-08-21 decision this branch returned `complete` the
      // moment a record was SENT for review — round-1 DE-2's own complaint,
      // applying to the eight yes/no categories AND to every invoice category
      // on a subsidiary-measured row or a year-less query. FR §2.2 now requires
      // `approved`/`locked` for green everywhere.
      expect(verdict({ coverage: null })).toBe('complete');
      expect(verdict({ coverage: null, awaitingReviewRecords: 1 })).toBe('incomplete');
      expect(verdict({ coverage: null, awaitingReviewRecords: 12 })).toBe('incomplete');
      // The three shared caps still stand on their own.
      expect(verdict({ coverage: null, hasPending: true })).toBe('incomplete');
      expect(verdict({ coverage: null, anomaly: true })).toBe('incomplete');
      expect(verdict({ coverage: null, evidenceMissing: true })).toBe('incomplete');
    });

    it('gates the invoice branch on records too, not on slots alone', () => {
      // The slot test this replaced could not see either of these on a fully
      // covered cell: an unreviewed record that closed NO slot (company-level,
      // unattributed, not monthly), and an unreviewed duplicate filed against a
      // month an approved invoice already covers — `awaitingReview` is `covered`
      // minus the accepted slots, so it is empty in both. Both records count
      // towards the tonnage the cell prints, and nobody has accepted either.
      const full = coverage({ required: 1, covered: new Set(['loc-1\u0000january']) });
      expect(verdict({ coverage: full })).toBe('complete');
      expect(verdict({ coverage: full, awaitingReviewRecords: 1 })).toBe('incomplete');
    });
  });

  describe('computeInvoiceCoverage', () => {
    const record = (over = {}) => ({
      locationId: 'loc-1',
      reportingPeriod: 'monthly',
      periodValue: 'January',
      evidenceCount: 1,
      status: ActivityRecordStatus.approved,
      ...over,
    });

    it('never reports a waiting slot without an unreviewed record behind it', () => {
      // The invariant WP19's gate leans on. The record-level counter REPLACED
      // the slot-level term in `deriveCellStatus` because it strictly implies
      // it; if that ever stopped being true the gate would silently weaken on
      // the invoice branch, with nothing failing. So it is asserted here rather
      // than argued in a comment — the function cannot check its own callers.
      for (const status of COUNTED_STATUSES) {
        const accepted = (ACCEPTED_STATUSES as readonly string[]).includes(status);
        const c = computeInvoiceCoverage(
          [record({ status: status as ActivityRecordStatus })],
          ['loc-1'],
        );
        expect(c.covered.size).toBe(1);
        expect(c.awaitingReview.size > 0).toBe(!accepted);
      }

      // And the implication runs ONE WAY. An accepted invoice closes the slot
      // whatever else was filed against it, so the slot set falls silent while
      // an unreviewed record is still sitting in the cell counting towards its
      // tonnage — the case the record counter exists to catch.
      const mixed = computeInvoiceCoverage(
        [
          record({ status: ActivityRecordStatus.approved }),
          record({ status: ActivityRecordStatus.submitted }),
        ],
        ['loc-1'],
      );
      expect(mixed.covered.size).toBe(1);
      expect(mixed.awaitingReview.size).toBe(0);
    });

    it('ignores a record no caller should have passed', () => {
      // The function is exported and now TAKES a status, so a reader will
      // reasonably assume the status rule lives inside it. Without this guard a
      // third caller handing over raw rows would let a DRAFT close a slot and
      // be counted as awaiting review at the same time.
      const c = computeInvoiceCoverage(
        [
          record({ status: ActivityRecordStatus.draft }),
          record({ periodValue: 'February', status: ActivityRecordStatus.rejected }),
        ],
        ['loc-1'],
      );
      expect(c.covered.size).toBe(0);
      expect(c.awaitingReview.size).toBe(0);
      // And it is not silently reclassified as some other kind of shortfall.
      expect(c.unattributedRecords).toBe(0);
      expect(c.nonMonthlyRecords).toBe(0);
      expect(c.missingEvidenceRecords).toBe(0);
    });

    it('keeps awaitingReview a strict subset of covered', () => {
      const c = computeInvoiceCoverage(
        [
          record(),
          record({ periodValue: 'February', status: ActivityRecordStatus.submitted }),
        ],
        ['loc-1'],
      );
      expect(c.covered.size).toBe(2);
      expect([...c.awaitingReview].every((s) => c.covered.has(s))).toBe(true);
      expect(c.awaitingReview.size).toBe(1);
    });
  });
});
