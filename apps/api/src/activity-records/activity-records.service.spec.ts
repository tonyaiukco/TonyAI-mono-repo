import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ActivityRecordStatus, Prisma, type ActivityRecord, type Subsidiary } from '@tonyai/db';
import { isCalculated, PENDING_REVIEW_STATUSES } from '@tonyai/shared-types';
import type { CalculationResult } from '@tonyai/shared-types';
import { ActivityRecordsService } from './activity-records.service';
import { PrismaService } from '../prisma/prisma.service';
import { CalculationsService } from '../calculations/calculations.service';
import type { RequestUser } from '../auth/auth.types';

import { AuditService } from '../audit/audit.service';
import { EvidenceService } from '../evidence/evidence.service';

/**
 * Audit writes go through the shared AuditService. A single shared spy lets the
 * specs assert WHAT was audited; the row shape it stamps (actor role +
 * organisation) is covered by audit.service.spec.ts.
 */
const audit = { record: vi.fn() };
const auditMock = () => audit as unknown as AuditService;

// Order-independence: some describes below assert `not.toHaveBeenCalled()`.
beforeEach(() => audit.record.mockClear());

// --- Local, DB-free mocks --------------------------------------------------

function createPrismaMock() {
  return {
    activityRecord: {
      // Default [] so the anomaly baseline query finds no priors (no anomaly)
      // unless a test overrides it.
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    subsidiary: {
      findUnique: vi.fn(),
    },
    location: {
      findUnique: vi.fn(),
    },
    evidence: {
      // Default: records have evidence, so evidence-required submits pass.
      count: vi.fn().mockResolvedValue(1),
    },
    periodLock: {
      // Default: period open (no lock row), so existing tests pass unchanged.
      findFirst: vi.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: vi.fn(),
    },
  };
}
type PrismaMock = ReturnType<typeof createPrismaMock>;

/** A calc engine stub: compute() returns a fixed snapshot and records calls. */
function createCalcMock(scope = 2) {
  const snapshot: CalculationResult = {
    category: 'Electricity',
    geographyCode: 'TR',
    reportingYear: 2024,
    scope,
    inputValue: 45000,
    inputUnit: 'kWh',
    normalizedValue: 45000,
    normalizedUnit: 'kWh',
    conversionApplied: false,
    kgCo2e: 19800,
    tCo2e: 19.8,
    factorId: 'factor-1',
    factorValue: 0.44,
    factorUnit: 'kgCO2e/kWh',
    methodology: 'location-based',
    source: 'demo',
    version: '2024.1',
  };
  return {
    snapshot,
    compute: vi.fn().mockResolvedValue(snapshot),
  };
}

let seq = 0;
function makeRecord(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  seq += 1;
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: `rec-${seq}`,
    subsidiaryId: 'sub-1',
    reportingYear: 2024,
    reportingPeriod: 'annual',
    periodValue: 'Annual',
    category: 'Electricity',
    scope: 2,
    status: ActivityRecordStatus.draft,
    activityValue: 45000,
    activityUnit: 'kWh',
    input: null,
    // `factorId` is not decoration: a STORED record that was calculated always
    // carries one, and `isCalculated()` keys on it to decide whether the record
    // has a figure worth comparing. Without it here the fixture describes a
    // record that cannot exist, and the anomaly gate silently skipped every
    // spec in this file.
    calculation: { tCo2e: 19.8, factorId: 'factor-1' } as unknown,
    createdBy: 'user-entry',
    anomalyFlag: false,
    varianceReason: null,
    // Prisma `_count` shape returned when the service includes evidence counts.
    _count: { evidence: 0 },
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
    legalName: 'Sub One',
    tradingName: null,
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
    accessibleSubsidiaryIds: ['sub-1'],
    ...overrides,
  };
}

function consultant(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-consultant',
    email: 'consultant@tonyai.local',
    role: 'consultant',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
    ...overrides,
  };
}

/**
 * Evidence FILES are reclaimed by the evidence service on the way out; the rows
 * go by themselves through the FK cascade. Only `removeAllForRecord` is used
 * from here.
 */
function createEvidenceMock() {
  return { removeAllForRecord: vi.fn().mockResolvedValue(0) };
}

function build(scope = 2) {
  const prisma = createPrismaMock();
  const calc = createCalcMock(scope);
  const evidence = createEvidenceMock();
  const service = new ActivityRecordsService(
    prisma as unknown as PrismaService,
    calc as unknown as CalculationsService,
    auditMock(),
    evidence as unknown as EvidenceService,
  );
  return { prisma, calc, evidence, service };
}

const CREATE_DTO = {
  subsidiaryId: 'sub-1',
  reportingYear: 2024,
  reportingPeriod: 'annual' as const,
  periodValue: 'Annual',
  category: 'Electricity' as const,
  activityValue: 45000,
  activityUnit: 'kWh',
};

// ---------------------------------------------------------------------------

describe('ActivityRecordsService — tenant scoping', () => {
  let prisma: PrismaMock;
  let service: ActivityRecordsService;

  beforeEach(() => {

    audit.record.mockClear();
    ({ prisma, service } = build());
  });

  it('list scopes to accessibleSubsidiaryIds when no filter given', async () => {
    prisma.activityRecord.findMany.mockResolvedValue([]);
    await service.list(dataEntry(), {});
    expect(prisma.activityRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ subsidiaryId: { in: ['sub-1'] } }),
      }),
    );
  });

  it('list returns [] for a subsidiaryId outside the accessible set (no DB hit)', async () => {
    const result = await service.list(dataEntry(), { subsidiaryId: 'sub-2' });
    expect(result).toEqual([]);
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('list filters on a SET of statuses (the reviewer queue)', async () => {
    prisma.activityRecord.findMany.mockResolvedValue([]);
    await service.list(superAdmin(), {
      status: [...PENDING_REVIEW_STATUSES],
    });
    expect(prisma.activityRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['submitted', 'under_review'] },
        }),
      }),
    );
  });

  it('list omits the status filter entirely when none is given', async () => {
    // Not `{ in: [] }` — Prisma reads an empty `in` as "match nothing", so a
    // careless refactor here would silently empty every unfiltered list.
    prisma.activityRecord.findMany.mockResolvedValue([]);
    await service.list(superAdmin(), {});
    const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
    expect(where.status).toBeUndefined();
  });

  it('get treats an out-of-scope record as NotFound', async () => {
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ subsidiaryId: 'sub-2' }),
    );
    await expect(service.get(dataEntry(), 'rec-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('get returns a record inside the accessible set', async () => {
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-in', subsidiaryId: 'sub-1' }),
    );
    const dto = await service.get(dataEntry(), 'rec-in');
    expect(dto.id).toBe('rec-in');
  });
});

describe('ActivityRecordsService — create stores the calc snapshot', () => {
  it('calls compute() with the subsidiary geography + derived scope and persists the snapshot', async () => {
    const { prisma, calc, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    const dto = await service.create(dataEntry(), CREATE_DTO);

    // compute() called with resolved geography + engine input.
    expect(calc.compute).toHaveBeenCalledWith(
      {
        category: 'Electricity',
        geographyCode: 'TR',
        reportingYear: 2024,
        value: 45000,
        unit: 'kWh',
      },
      // A create always chooses its unit, so the category/unit map applies.
      { enforceCategoryUnit: true },
    );
    // Snapshot + derived scope persisted on the row.
    const createArg = prisma.activityRecord.create.mock.calls[0][0];
    expect(createArg.data.scope).toBe(2); // Electricity -> Scope 2
    expect(createArg.data.calculation).toEqual(calc.snapshot);
    expect(createArg.data.status).toBe(ActivityRecordStatus.draft);
    expect(createArg.data.createdBy).toBe('user-entry');
    // Narrowed, not cast: an `as CalculationResult` would still compile if the
    // service regressed to storing the uncalculated shape here, and the
    // assertion below would then compare `undefined` and pass nothing.
    expect(isCalculated(dto.calculation)).toBe(true);
    expect((dto.calculation as CalculationResult).tCo2e).toBeCloseTo(19.8, 6);
    // Audit written.
    expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({
          action: 'create',
          entity: 'activity_record',
        }),
      );
  });

  it('resolves the factor geography from the LOCATION when a locationId is given (data_entry_page.md §5.2)', async () => {
    const { prisma, calc, service } = build(2);
    // Subsidiary is TR, but the targeted location is UK -> UK must win.
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.location.findUnique.mockResolvedValue({
      id: 'loc-1',
      subsidiaryId: 'sub-1',
      geographyCode: 'UK',
    });
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(dataEntry(), { ...CREATE_DTO, locationId: 'loc-1' });

    expect(calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ geographyCode: 'UK' }),
      expect.anything(),
    );
    const createArg = prisma.activityRecord.create.mock.calls[0][0];
    expect(createArg.data.locationId).toBe('loc-1');
  });

    it('rejects a location that belongs to another subsidiary (NotFound, no compute)', async () => {
    const { prisma, calc, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.location.findUnique.mockResolvedValue({
      id: 'loc-x',
      subsidiaryId: 'sub-OTHER', // not the record's subsidiary
      geographyCode: 'UK',
    });

    await expect(
      service.create(dataEntry(), { ...CREATE_DTO, locationId: 'loc-x' }),
    ).rejects.toThrow(/Location not found/);
    expect(calc.compute).not.toHaveBeenCalled();
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
  });

  it('maps a duplicate (Prisma P2002) to 409 Conflict, not 500', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.activityRecord.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.create(dataEntry(), CREATE_DTO),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('cannot create against an inaccessible subsidiary (NotFound, no compute)', async () => {
    const { prisma, calc, service } = build();
    await expect(
      service.create(dataEntry(), { ...CREATE_DTO, subsidiaryId: 'sub-2' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(calc.compute).not.toHaveBeenCalled();
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
  });

  it('executive_viewer (read-only role) cannot create -> Forbidden', async () => {
    const { service } = build();
    await expect(
      service.create(
        superAdmin({ role: 'executive_viewer' }),
        CREATE_DTO,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

/**
 * `locationName` is resolved by a join, not stored on the row. That makes it a
 * read-time convenience — and a liability the moment it reaches `audit_log`,
 * which is append-only and has no correction path. Before the split, `toDTO`
 * served both jobs and the queries disagreed about the include, so a create
 * whose `locationId` was set the whole time logged `locationName: null` and the
 * next unrelated edit logged `null → "Ankara Plant"` — a permanent record of a
 * geography decision that never happened on that day.
 */
describe('ActivityRecordsService — locationName: read-only, never audited', () => {
  const located = { ...CREATE_DTO, locationId: 'loc-1' };

  function withLocation(prisma: PrismaMock) {
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.location.findUnique.mockResolvedValue({
      id: 'loc-1',
      subsidiaryId: 'sub-1',
      geographyCode: 'UK',
    });
  }

  beforeEach(() => {
    audit.record.mockClear();
  });

  it('create returns the name but keeps it out of the audit snapshot', async () => {
    const { prisma, service } = build(2);
    withLocation(prisma);
    prisma.activityRecord.create.mockImplementation(({ data }: any) => ({
      ...makeRecord({ ...data, id: 'rec-new' }),
      location: { name: 'Ankara Plant' },
    }));

    const dto = await service.create(dataEntry(), located);

    expect(dto.locationName).toBe('Ankara Plant');
    const diff = audit.record.mock.calls[0][1].diff as any;
    // The persisted column IS audited; the resolved label is not.
    expect(diff.after.locationId).toBe('loc-1');
    expect(diff.after).not.toHaveProperty('locationName');
  });

  it('update audits neither side with a resolved name', async () => {
    const { prisma, service } = build(2);
    withLocation(prisma);
    prisma.activityRecord.findUnique.mockResolvedValue({
      ...makeRecord({
        id: 'rec-u',
        subsidiaryId: 'sub-1',
        locationId: 'loc-1',
        status: ActivityRecordStatus.draft,
        createdBy: 'user-entry',
      }),
      location: { name: 'Ankara Plant' },
    });
    prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
      ...makeRecord({ id: 'rec-u', subsidiaryId: 'sub-1', locationId: 'loc-1', ...data }),
      _count: { evidence: 0 },
      location: { name: 'Ankara Plant' },
    }));

    const dto = await service.update(dataEntry(), 'rec-u', { activityValue: 5000 });

    expect(dto.locationName).toBe('Ankara Plant');
    const diff = audit.record.mock.calls[0][1].diff as any;
    expect(diff.before).not.toHaveProperty('locationName');
    expect(diff.after).not.toHaveProperty('locationName');
  });

  /**
   * Re-attribution — moving a record between reporting entities (WP18).
   *
   * The server has accepted this since 2026-07-07 and **nothing tested it**:
   * across all 13 `service.update()` calls in this file, not one passed
   * `locationId`, so neither the `connect`/`disconnect` branch nor its 409 had
   * any coverage. It matters more than an ordinary gap, because the client used
   * to abandon the edit on a location change and POST instead — creating the
   * second row that double-counts the month. The web fix only holds if the
   * server behaviour it now relies on is pinned.
   */
  describe('re-attribution (WP18)', () => {
    const draftAt = (locationId: string | null) => ({
      ...makeRecord({
        id: 'rec-move',
        subsidiaryId: 'sub-1',
        locationId,
        status: ActivityRecordStatus.draft,
        createdBy: 'user-entry',
      }),
      location: locationId ? { name: 'Ankara Plant' } : null,
    });

    it('moves a whole-company record onto a site, and recalculates for that site', async () => {
      const { prisma, calc, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));
      prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
        ...makeRecord({ id: 'rec-move', subsidiaryId: 'sub-1', locationId: 'loc-1', ...data }),
        _count: { evidence: 0 },
        location: { name: 'Ankara Plant' },
      }));

      await service.update(dataEntry(), 'rec-move', { locationId: 'loc-1' });

      // `connect`, not a new row. This is the whole point: the record MOVES.
      const data = prisma.activityRecord.update.mock.calls[0][0].data;
      expect(data.location).toEqual({ connect: { id: 'loc-1' } });
      // And the snapshot is recomputed from the SITE's geography, not the
      // subsidiary's — the location is what decides which factor applies
      // (data_entry_page.md §5.2), so a move that kept the old factor would leave a record
      // whose stored provenance contradicts its own reporting entity.
      expect(calc.compute).toHaveBeenCalledWith(
        expect.objectContaining({ geographyCode: 'UK' }),
        expect.anything(),
      );
    });

    it('detaches a site record back to the whole company', async () => {
      const { prisma, calc, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt('loc-1'));
      prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
        ...makeRecord({ id: 'rec-move', subsidiaryId: 'sub-1', locationId: null, ...data }),
        _count: { evidence: 0 },
        location: null,
      }));

      await service.update(dataEntry(), 'rec-move', { locationId: null });

      expect(prisma.activityRecord.update.mock.calls[0][0].data.location).toEqual({
        disconnect: true,
      });
      // Back to the SUBSIDIARY's geography. `null` and "omitted" are different
      // requests and the DTO validator lets both through, so this is the half
      // of the tri-state that a `@IsOptional()` reading would silently skip.
      expect(calc.compute).toHaveBeenCalledWith(
        expect.objectContaining({ geographyCode: 'TR' }),
        expect.anything(),
      );
    });

    it('leaves the location alone when the field is omitted', async () => {
      const { prisma, calc, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt('loc-1'));
      prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
        ...makeRecord({ id: 'rec-move', subsidiaryId: 'sub-1', locationId: 'loc-1', ...data }),
        _count: { evidence: 0 },
        location: { name: 'Ankara Plant' },
      }));

      await service.update(dataEntry(), 'rec-move', { activityValue: 5000 });

      // The third arm of the tri-state: no `location` key at all, so an
      // unrelated edit cannot silently re-home the record...
      expect(prisma.activityRecord.update.mock.calls[0][0].data).not.toHaveProperty(
        'location',
      );
      // ...and the recompute still uses the location it already had.
      expect(calc.compute).toHaveBeenCalledWith(
        expect.objectContaining({ geographyCode: 'UK' }),
        expect.anything(),
      );
    });

    it('refuses to move onto an entity that already holds a record', async () => {
      const { prisma, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));
      prisma.activityRecord.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      // Exactly the collision the six seeded duplicate pairs would produce if
      // someone tried to resolve one by moving. A 409, never a second row —
      // and never a silent overwrite of the record already sitting there.
      await expect(
        service.update(dataEntry(), 'rec-move', { locationId: 'loc-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a location belonging to another subsidiary, before writing anything', async () => {
      const { prisma, service } = build(2);
      prisma.subsidiary.findUnique.mockResolvedValue(
        makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
      );
      prisma.location.findUnique.mockResolvedValue({
        id: 'loc-x',
        subsidiaryId: 'sub-2',
        geographyCode: 'UK',
      });
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));

      await expect(
        service.update(dataEntry(), 'rec-move', { locationId: 'loc-x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Tenant isolation: a cross-tenant id must not be probeable through a
      // half-applied write, so nothing may reach the database.
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('cannot move a committed record at all', async () => {
      const { prisma, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue({
        ...makeRecord({
          id: 'rec-move',
          subsidiaryId: 'sub-1',
          locationId: null,
          status: ActivityRecordStatus.approved,
          createdBy: 'user-entry',
        }),
        location: null,
      });

      // The limit of what PR 1 delivers, pinned so it is not mistaken for a
      // capability: all twelve rows in the six double-counted pairs are
      // `approved`, so the records that most need moving are exactly the ones
      // this refuses. Repairing them needs the audited correction path (PR 3).
      await expect(
        service.update(dataEntry(), 'rec-move', { locationId: 'loc-1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('re-evaluates the anomaly against the entity it moved TO, not the one it left', async () => {
      const { prisma, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));
      prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
        ...makeRecord({ id: 'rec-move', subsidiaryId: 'sub-1', locationId: 'loc-1', ...data }),
        _count: { evidence: 0 },
        location: { name: 'Ankara Plant' },
      }));

      await service.update(dataEntry(), 'rec-move', { locationId: 'loc-1' });

      // The baseline is keyed on the reporting ENTITY (subsidiary + location +
      // category + granularity), and whole-company records form their own pool.
      // Measuring a moved record against the pool it just left would flag it as
      // anomalous for differing from consumption at a different site.
      const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
      expect(where.locationId).toBe('loc-1');
    });

    it('answers 404 for a location that does not exist, before writing anything', async () => {
      const { prisma, service } = build(2);
      prisma.subsidiary.findUnique.mockResolvedValue(
        makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
      );
      prisma.location.findUnique.mockResolvedValue(null);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));

      // Without the `!location` half of the guard this reaches `connect` and
      // Prisma raises P2025 — a 500 for what is plainly a bad request.
      await expect(
        service.update(dataEntry(), 'rec-move', { locationId: 'loc-nope' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('does not report an unrelated database failure as a duplicate', async () => {
      const { prisma, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));
      prisma.activityRecord.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Record to update not found', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      // A catch that answered 409 for everything would tell the user "an
      // activity record already exists for this reporting entity" whenever the
      // database failed for any reason at all — a specific, checkable claim,
      // and a false one.
      await expect(
        service.update(dataEntry(), 'rec-move', { locationId: 'loc-1' }),
      ).rejects.not.toBeInstanceOf(ConflictException);
    });

    it('records both sides of the move in the audit diff', async () => {
      const { prisma, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));
      prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
        ...makeRecord({ id: 'rec-move', subsidiaryId: 'sub-1', locationId: 'loc-1', ...data }),
        _count: { evidence: 0 },
        location: { name: 'Ankara Plant' },
      }));

      await service.update(dataEntry(), 'rec-move', { locationId: 'loc-1' });

      // `audit_log` is append-only and has no correction path, so a move that
      // was not captured on both sides would be unreconstructable.
      const diff = audit.record.mock.calls[0][1].diff as any;
      expect(diff.before.locationId).toBeNull();
      expect(diff.after.locationId).toBe('loc-1');
    });
  });

  it('single-record reads carry the same include as the list (GET /:id agrees)', async () => {
    // The contract documents `locationName: null` as "subsidiary-level, or the
    // location has since been removed" — and this work package makes the second
    // case impossible. A GET that answered `null` for a located record would
    // therefore read as "orphaned, investigate".
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue({
      ...makeRecord({ id: 'rec-g', subsidiaryId: 'sub-1', locationId: 'loc-1' }),
      location: { name: 'Ankara Plant' },
    });

    const dto = await service.get(dataEntry(), 'rec-g');

    expect(dto.locationName).toBe('Ankara Plant');
    expect(prisma.activityRecord.findUnique).toHaveBeenCalledWith({
      where: { id: 'rec-g' },
      include: { location: { select: { name: true } } },
    });
  });

  it('create asks for the include too — otherwise the 201 body lies', async () => {
    const { prisma, service } = build(2);
    withLocation(prisma);
    prisma.activityRecord.create.mockImplementation(({ data }: any) => ({
      ...makeRecord({ ...data, id: 'rec-new' }),
      location: { name: 'Ankara Plant' },
    }));

    await service.create(dataEntry(), located);

    expect(prisma.activityRecord.create.mock.calls[0][0].include).toEqual({
      location: { select: { name: true } },
    });
  });
});

/**
 * Deleting a record cascades its `evidence` ROWS away inside Postgres, where no
 * application code sees them go — so nothing ever deleted the FILES. Storage is
 * a separate system; nothing reconciled the two. Measured on the local stack:
 * 1501 objects in the bucket against 102 rows. They are utility invoices, so
 * files outliving every pointer to them is a retention problem (KVKK/GDPR).
 *
 * Note what was NOT covered before this: every existing `remove` spec asserts a
 * refusal, so the successful delete path had no unit test at all — which is why
 * adding a whole new constructor dependency left the suite green.
 */
describe('ActivityRecordsService — deleting a record reclaims its evidence files', () => {
  function deletableRecord(prisma: PrismaMock) {
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-del',
        subsidiaryId: 'sub-1',
        status: ActivityRecordStatus.draft,
        createdBy: 'user-entry',
      }),
    );
  }

  it('reclaims the blobs, and does it BEFORE the row is gone', async () => {
    const { prisma, evidence, service } = build();
    deletableRecord(prisma);
    evidence.removeAllForRecord.mockResolvedValue(2);

    await service.remove(dataEntry(), 'rec-del');

    expect(evidence.removeAllForRecord).toHaveBeenCalledWith('rec-del');
    // Order is the whole point: the storage paths are only knowable while the
    // rows still exist, and a storage failure must abort before anything is
    // destroyed rather than after.
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0];
    expect(order(evidence.removeAllForRecord)).toBeLessThan(
      order(prisma.activityRecord.delete),
    );
  });

  it('does not delete the record when storage refuses', async () => {
    // Otherwise the failure mode is the exact one being fixed: row gone, file
    // stranded, and now nothing left that even knows the file exists.
    const { prisma, evidence, service } = build();
    deletableRecord(prisma);
    evidence.removeAllForRecord.mockRejectedValue(new Error('storage down'));

    await expect(service.remove(dataEntry(), 'rec-del')).rejects.toThrow(/storage down/);
    expect(prisma.activityRecord.delete).not.toHaveBeenCalled();
  });

  it('is not attempted for a record that is refused (gate runs first)', async () => {
    const { prisma, evidence, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-a', status: ActivityRecordStatus.approved, createdBy: 'user-entry' }),
    );

    await expect(service.remove(dataEntry(), 'rec-a')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(evidence.removeAllForRecord).not.toHaveBeenCalled();
    expect(prisma.activityRecord.delete).not.toHaveBeenCalled();
  });
});

describe('ActivityRecordsService — RBAC', () => {
  it('data_entry cannot approve -> Forbidden', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ status: ActivityRecordStatus.submitted, subsidiaryId: 'sub-1' }),
    );
    await expect(service.approve(dataEntry(), 'rec-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('consultant may NOT approve — approval is super_admin only', async () => {
    // Decision 2026-07-30: a consultant enters data on a client's behalf, so
    // letting the same seat approve it breaks "the preparer does not approve".
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-a', status: ActivityRecordStatus.submitted }),
    );

    await expect(service.approve(consultant(), 'rec-a')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('super_admin approves a submitted record (audited as `approve`)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-a', status: ActivityRecordStatus.submitted }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-a', status: data.status }),
    );

    const dto = await service.approve(superAdmin(), 'rec-a');
    expect(dto.status).toBe(ActivityRecordStatus.approved);
    expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({
          action: 'approve',
          entity: 'activity_record',
        }),
      );
  });

  it('non-owner data_entry cannot edit a peer record -> Forbidden', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        subsidiaryId: 'sub-1',
        createdBy: 'someone-else',
        status: ActivityRecordStatus.draft,
      }),
    );
    await expect(
      service.update(dataEntry(), 'rec-1', { activityValue: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('super_admin may edit a record created by someone else', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-o',
        subsidiaryId: 'sub-1',
        createdBy: 'someone-else',
        status: ActivityRecordStatus.draft,
      }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-o', ...data }),
    );

    const dto = await service.update(superAdmin(), 'rec-o', { activityValue: 100 });
    expect(dto.id).toBe('rec-o');
    expect(prisma.activityRecord.update).toHaveBeenCalled();
  });
});

describe('ActivityRecordsService — start review (FR §6.3)', () => {
  it('consultant takes a submitted record into under_review (audited)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-r', status: ActivityRecordStatus.submitted }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-r', status: data.status }),
    );
    const dto = await service.startReview(consultant(), 'rec-r');
    expect(dto.status).toBe(ActivityRecordStatus.under_review);
    // The action taxonomy is the point of the change: a transition must no
    // longer be logged as a blanket 'update'.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ action: 'review', entity: 'activity_record' }),
    );
  });

  it('consultant is review-only: may NOT create, update, delete or submit', async () => {
    // Decision 2026-07-30 — the consultant seat is advisory (review, anomaly
    // flagging, guidance) and typically sits outside the holding company; data
    // preparation belongs to the tenant's own data_entry staff.
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-c', status: ActivityRecordStatus.draft }),
    );

    await expect(
      service.create(consultant(), {
        subsidiaryId: 'sub-1',
        locationId: null,
        reportingYear: 2024,
        reportingPeriod: 'quarterly',
        periodValue: 'Q1',
        category: 'Electricity',
        activityValue: 100,
        activityUnit: 'kWh',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      service.update(consultant(), 'rec-c', { activityValue: 200 } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(service.remove(consultant(), 'rec-c')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    await expect(service.submit(consultant(), 'rec-c')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(prisma.activityRecord.delete).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('consultant KEEPS review and reject (the seat is not read-only)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-k', status: ActivityRecordStatus.submitted }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-k', status: data.status, reviewNote: data.reviewNote }),
    );

    const reviewed = await service.startReview(consultant(), 'rec-k');
    expect(reviewed.status).toBe(ActivityRecordStatus.under_review);

    const rejected = await service.reject(consultant(), 'rec-k', 'missing invoice');
    expect(rejected.status).toBe(ActivityRecordStatus.rejected);
    expect(rejected.reviewNote).toBe('missing invoice');
  });

  it('data_entry cannot start a review -> Forbidden', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ status: ActivityRecordStatus.submitted, subsidiaryId: 'sub-1' }),
    );
    await expect(service.startReview(dataEntry(), 'rec-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('only a submitted record can enter review (draft -> BadRequest)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ status: ActivityRecordStatus.draft }),
    );
    await expect(service.startReview(consultant(), 'rec-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('a locked period blocks starting a review (409, no write)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ status: ActivityRecordStatus.submitted }),
    );
    prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });
    await expect(service.startReview(consultant(), 'rec-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });
});

describe('ActivityRecordsService — transition rules', () => {
  it('approving a draft record -> BadRequest', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ status: ActivityRecordStatus.draft }),
    );
    await expect(service.approve(superAdmin(), 'rec-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('editing an approved record -> BadRequest (immutable)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        subsidiaryId: 'sub-1',
        createdBy: 'user-entry',
        status: ActivityRecordStatus.approved,
      }),
    );
    await expect(
      service.update(dataEntry(), 'rec-1', { activityValue: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deleting a locked record -> BadRequest (immutable)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        subsidiaryId: 'sub-1',
        createdBy: 'user-entry',
        status: ActivityRecordStatus.locked,
      }),
    );
    await expect(service.remove(dataEntry(), 'rec-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('submit moves draft -> submitted (any accessor) and audits', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-s', status: ActivityRecordStatus.draft }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-s', status: data.status }),
    );

    const dto = await service.submit(dataEntry(), 'rec-s');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ action: 'submit', entity: 'activity_record' }),
    );
  });

  it('a REJECTED record can be resubmitted, and keeps the reviewer\'s note', async () => {
    // Rejection must not be a one-way door. `update` allows editing a rejected
    // record but never moved it back to `draft`, and submit accepted only
    // `draft` — so every rejected record was permanently stranded: excluded
    // from the counted statuses, dropped from the inventory, and pinning its
    // report to `contains_incomplete_data` with no API path back.
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-r',
        status: ActivityRecordStatus.rejected,
        reviewNote: 'invoice mismatch',
      }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-r', status: data.status, reviewNote: data.reviewNote }),
    );

    const dto = await service.submit(dataEntry(), 'rec-r');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    // The note is NOT destroyed: it is the reviewer's only in-record signal that
    // this record has been round the loop before, and `/review` renders it as
    // "Previous review note". The stale-note problem is solved by rendering it
    // only on a rejected record, not by deleting the value.
    const data = prisma.activityRecord.update.mock.calls[0][0].data;
    expect('reviewNote' in data).toBe(false);
  });

  it('a non-author may not resubmit — that would overturn a rejection', async () => {
    // `update`/`remove` already gate on the author; submit did not, so any
    // data_entry user who could see the subsidiary could undo a reviewer's
    // decision while still being forbidden from fixing the number.
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-n',
        status: ActivityRecordStatus.rejected,
        createdBy: 'someone-else',
      }),
    );

    await expect(service.submit(dataEntry(), 'rec-n')).rejects.toThrow(
      /only resubmit activity records you created/i,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('a super_admin may resubmit a record they did not author', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-sa',
        status: ActivityRecordStatus.rejected,
        createdBy: 'someone-else',
      }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-sa', status: data.status }),
    );

    const dto = await service.submit(superAdmin(), 'rec-sa');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
  });

  it('a first submit does not touch reviewNote at all', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-d', status: ActivityRecordStatus.draft }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-d', status: data.status }),
    );

    await service.submit(dataEntry(), 'rec-d');
    const data = prisma.activityRecord.update.mock.calls[0][0].data;
    expect('reviewNote' in data).toBe(false);
  });

  it('still refuses to submit an approved record', async () => {
    // Widening submit to accept `rejected` must not have widened it to anything
    // else — an approved record is immutable.
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-a', status: ActivityRecordStatus.approved }),
    );

    await expect(service.submit(dataEntry(), 'rec-a')).rejects.toThrow(
      /draft or rejected/i,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('does not re-police the unit when an edit did not change it', async () => {
    // The category/unit map is new. A record stored before it (gas in MWh, say)
    // would otherwise 400 on ANY edit — including one that never touched the
    // unit — with a message telling the user to change a historical figure.
    const { prisma, calc, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-u',
        subsidiaryId: 'sub-1',
        createdBy: 'user-entry',
        status: ActivityRecordStatus.rejected,
        activityUnit: 'MWh',
      }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-u', ...data }),
    );

    await service.update(dataEntry(), 'rec-u', { varianceReason: 'a note' });

    expect(calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ unit: 'MWh' }),
      { enforceCategoryUnit: false },
    );
  });

  it('blocks submit of an evidence-required category with no evidence (FR §4.1)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-e', category: 'Electricity', status: ActivityRecordStatus.draft }),
    );
    prisma.evidence.count.mockResolvedValue(0); // no evidence attached

    await expect(service.submit(dataEntry(), 'rec-e')).rejects.toThrow(
      /requires at least one evidence file/,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('reject moves submitted -> rejected and stores the reviewer note (not varianceReason)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-r', status: ActivityRecordStatus.submitted }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({
        id: 'rec-r',
        status: data.status,
        varianceReason: data.varianceReason,
        reviewNote: data.reviewNote,
        reviewedBy: data.reviewedBy,
        reviewedAt: data.reviewedAt,
      }),
    );

    const dto = await service.reject(consultant(), 'rec-r', 'invoice mismatch');
    expect(dto.status).toBe(ActivityRecordStatus.rejected);
    const updateArg = prisma.activityRecord.update.mock.calls[0][0];
    // The reviewer's reason is its own field; the author's variance
    // justification (VAR §4) must survive untouched.
    expect(updateArg.data.reviewNote).toBe('invoice mismatch');
    expect(updateArg.data.varianceReason).toBeUndefined();
    expect(updateArg.data.reviewedBy).toBeDefined();
    expect(updateArg.data.reviewedAt).toBeInstanceOf(Date);
    // …and it must be READABLE: the reason is worthless if no DTO exposes it.
    expect(dto.reviewNote).toBe('invoice mismatch');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ action: 'reject', entity: 'activity_record' }),
    );
  });

  it('update recomputes the calc snapshot on value change', async () => {
    const { prisma, calc, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-u',
        subsidiaryId: 'sub-1',
        createdBy: 'user-entry',
        status: ActivityRecordStatus.rejected,
      }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-u', ...data }),
    );

    await service.update(dataEntry(), 'rec-u', { activityValue: 90000 });
    expect(calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ value: 90000, geographyCode: 'TR' }),
      expect.anything(),
    );
    const updateArg = prisma.activityRecord.update.mock.calls[0][0];
    expect(updateArg.data.calculation).toEqual(calc.snapshot);
  });
});

describe('ActivityRecordsService — anomaly detection (VAR §4)', () => {
  // calc.compute() returns tCo2e 19.8 for the record being written.
  const MONTHLY_DTO = {
    ...CREATE_DTO,
    reportingPeriod: 'monthly' as const,
    periodValue: 'March',
  };
  const priorMonth = (periodValue: string, tCo2e: number) =>
    makeRecord({
      reportingPeriod: 'monthly',
      periodValue,
      status: ActivityRecordStatus.approved,
      // `factorId` for the same reason as makeRecord's default: a stored,
      // calculated prior always carries the factor it used, and isCalculated()
      // is what decides whether a prior can seed the baseline.
      calculation: { tCo2e, factorId: 'f-1' },
    });

  it('flags an anomaly when tCO₂e deviates >50% from the rolling 3-period baseline', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    // Baseline avg = 10; current = 19.8 → +98% → anomaly.
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('January', 10),
      priorMonth('February', 10),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    const dto = await service.create(dataEntry(), MONTHLY_DTO);

    expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(true);
    expect(dto.anomalyFlag).toBe(true);
  });

  it('does not flag a value within 50% of the baseline', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    // Baseline avg = 15; current = 19.8 → +32% → within threshold.
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('January', 15),
      priorMonth('February', 15),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(dataEntry(), MONTHLY_DTO);
    expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(false);
  });

  it('does not flag the first-ever entry (no baseline to deviate from)', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([]); // no prior periods
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(dataEntry(), MONTHLY_DTO);
    expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(false);
  });

  it('excludes later periods and the record itself from its own baseline', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    // A FUTURE month (April) must not seed the March baseline; only Jan/Feb count.
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('January', 10),
      priorMonth('February', 10),
      priorMonth('April', 19), // later than March → ignored
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(dataEntry(), MONTHLY_DTO);
    // If April (19) had counted, baseline ≈ 13 and 19.8 would be within 50%.
    expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(true);
  });

  it('scopes the baseline query to the reporting entity + granularity + committed statuses', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(dataEntry(), MONTHLY_DTO);

    const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      subsidiaryId: 'sub-1',
      locationId: null,
      category: 'Electricity',
      reportingPeriod: 'monthly',
      status: {
        in: [
          ActivityRecordStatus.submitted,
          ActivityRecordStatus.under_review,
          ActivityRecordStatus.approved,
          ActivityRecordStatus.locked,
        ],
      },
    });
  });

  it('only the most recent 3 priors count (older ones are dropped)', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    // Current = May (19.8). Recent 3 (Apr/Mar/Feb) avg = 10 → anomaly; if the
    // oldest (January = 100) also counted, avg = 32.5 → NOT an anomaly.
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('January', 100),
      priorMonth('February', 10),
      priorMonth('March', 10),
      priorMonth('April', 10),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(dataEntry(), { ...MONTHLY_DTO, periodValue: 'May' });
    expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(true);
  });

  it('orders quarterly periods correctly (Q1<Q2<Q3, Q4 excluded)', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([
      makeRecord({ reportingPeriod: 'quarterly', periodValue: 'Q1', status: ActivityRecordStatus.approved, calculation: { tCo2e: 10, factorId: 'f-1' } }),
      makeRecord({ reportingPeriod: 'quarterly', periodValue: 'Q2', status: ActivityRecordStatus.approved, calculation: { tCo2e: 10, factorId: 'f-1' } }),
      makeRecord({ reportingPeriod: 'quarterly', periodValue: 'Q4', status: ActivityRecordStatus.approved, calculation: { tCo2e: 19, factorId: 'f-1' } }), // later → excluded
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(dataEntry(), { ...CREATE_DTO, reportingPeriod: 'quarterly', periodValue: 'Q3' });
    expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(true);
  });

  it('recomputes the flag with excludeId on update (a record cannot seed its own baseline)', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-u', subsidiaryId: 'sub-1', reportingPeriod: 'monthly', periodValue: 'March', createdBy: 'user-entry' }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('January', 10),
      priorMonth('February', 10),
    ]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-u', ...data }),
    );

    await service.update(dataEntry(), 'rec-u', { activityValue: 5000 });
    const updateArg = prisma.activityRecord.update.mock.calls[0][0];
    expect(updateArg.data.anomalyFlag).toBe(true);
    expect(prisma.activityRecord.findMany.mock.calls[0][0].where.id).toEqual({ not: 'rec-u' });
  });

  it('create skips the anomaly check for a record with no figure', async () => {
    const { prisma, service, calc } = build(3);
    // The calc engine hands back the factor-less shape for this write.
    calc.compute.mockResolvedValue({
      snapshotSchema: 1,
      category: 'Water',
      geographyCode: 'TR',
      reportingYear: 2024,
      scope: 3,
      inputValue: 250,
      inputUnit: 'cubic_metres',
      reasonCode: 'no_emission_factor',
      reason: 'No emission factor is available for "Water"',
    });
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(dataEntry(), {
      ...MONTHLY_DTO,
      category: 'Water',
      activityUnit: 'cubic_metres',
    } as unknown as typeof MONTHLY_DTO);

    expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(false);
    // The baseline query never runs: detection is skipped, not survived.
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('update skips the anomaly check when the recomputed snapshot has no figure', async () => {
    const { prisma, service, calc } = build(3);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-u', subsidiaryId: 'sub-1', reportingPeriod: 'monthly', periodValue: 'March', createdBy: 'user-entry' }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    // Editing a record into a factor-less category: calculated -> uncalculated.
    calc.compute.mockResolvedValue({
      snapshotSchema: 1,
      category: 'Water',
      geographyCode: 'TR',
      reportingYear: 2024,
      scope: 3,
      inputValue: 250,
      inputUnit: 'cubic_metres',
      reasonCode: 'no_emission_factor',
      reason: 'No emission factor is available for "Water"',
    });
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-u', ...data }),
    );

    await service.update(dataEntry(), 'rec-u', {
      category: 'Water',
      activityUnit: 'cubic_metres',
    } as never);

    const updateArg = prisma.activityRecord.update.mock.calls[0][0];
    expect(updateArg.data.anomalyFlag).toBe(false);
    expect(updateArg.data.calculation).toMatchObject({
      reasonCode: 'no_emission_factor',
    });
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('a category change re-enforces the unit map even when the unit is not resent', async () => {
    const { prisma, service, calc } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-w',
        subsidiaryId: 'sub-1',
        category: 'Water',
        activityUnit: 'cubic_metres',
        createdBy: 'user-entry',
      }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-w', ...data }),
    );

    await service.update(dataEntry(), 'rec-w', { category: 'Electricity' } as never);

    // Without this the stored `cubic_metres` was re-read under Electricity,
    // normalised at the natural-gas calorific value and multiplied by the grid
    // factor — a fabricated figure carrying full factor provenance.
    expect(calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Electricity', unit: 'cubic_metres' }),
      { enforceCategoryUnit: true },
    );
  });

  it('rejects a non-canonical periodValue for its granularity (VAR data integrity)', async () => {
    const { service } = build(2);
    await expect(
      service.create(dataEntry(), { ...MONTHLY_DTO, periodValue: 'Mar' }),
    ).rejects.toThrow(/not a valid period/i);
  });

  // --- Submit gate re-evaluates the baseline as of submit time (fix: never
  //     trust the write-time flag; the API is the final enforcement layer). ---

  const draftForSubmit = (over = {}) =>
    makeRecord({
      id: 'rec-s',
      status: ActivityRecordStatus.draft,
      reportingPeriod: 'monthly',
      periodValue: 'March',
      // Same reason as makeRecord's default: the submit gate only evaluates a
      // record that HAS a figure, and a stored calculated record always carries
      // the factor it used.
      calculation: { tCo2e: 19.8, factorId: 'factor-1' },
      varianceReason: null,
      ...over,
    });

  it('blocks submit when the value is anomalous vs. the current baseline and no comment', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draftForSubmit());
    prisma.activityRecord.findMany.mockResolvedValue([priorMonth('January', 10), priorMonth('February', 10)]);

    await expect(service.submit(dataEntry(), 'rec-s')).rejects.toThrow(/variance comment|deviates/i);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('allows submit of an anomalous record once a variance comment is present (persists the fresh flag)', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draftForSubmit({ varianceReason: 'Plant expansion' }));
    prisma.activityRecord.findMany.mockResolvedValue([priorMonth('January', 10), priorMonth('February', 10)]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-s', ...data }));

    const dto = await service.submit(dataEntry(), 'rec-s');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    expect(prisma.activityRecord.update.mock.calls[0][0].data.anomalyFlag).toBe(true);
  });

  it('a record with no calculated figure is never anomalous, so submit is not blocked', async () => {
    const { prisma, service } = build(2);
    // An invoice-tracked category with no factor (WP17): the snapshot carries
    // no tCO₂e at all. Substituting 0 — what a plain `?? 0` does — reads as a
    // 100% drop against this baseline and would demand a variance comment for a
    // value that was never computed.
    prisma.activityRecord.findUnique.mockResolvedValue(
      draftForSubmit({
        category: 'Water',
        varianceReason: null,
        calculation: {
          category: 'Water',
          geographyCode: 'TR',
          reportingYear: 2024,
          scope: 3,
          inputValue: 100,
          inputUnit: 'cubic_metres',
          reasonCode: 'no_emission_factor',
          reason: 'No emission factor is available for "Water"',
        },
      }),
    );
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('January', 500),
      priorMonth('February', 500),
    ]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-s', ...data }),
    );

    const dto = await service.submit(dataEntry(), 'rec-s');

    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    expect(prisma.activityRecord.update.mock.calls[0][0].data.anomalyFlag).toBe(false);
    // The baseline was never even queried: detection is skipped, not merely
    // survived. Without this leg the test would still pass if the comparison
    // happened and simply came out under the threshold.
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('does not trust a stale stored flag: submit passes when the current baseline is not anomalous', async () => {
    const { prisma, service } = build(2);
    // Stored flag is true, no comment — but there is no baseline now, so submit
    // must NOT be blocked, and the persisted flag is corrected to false.
    prisma.activityRecord.findUnique.mockResolvedValue(draftForSubmit({ anomalyFlag: true }));
    prisma.activityRecord.findMany.mockResolvedValue([]); // no comparable priors
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-s', ...data }));

    const dto = await service.submit(dataEntry(), 'rec-s');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    expect(prisma.activityRecord.update.mock.calls[0][0].data.anomalyFlag).toBe(false);
  });
});

describe('ActivityRecordsService — period-lock gate (FR §4.2)', () => {
  const LOCK_ROW = { id: 'lock-1', subsidiaryId: 'sub-1' };

  it('blocks creating a record in a locked period (409, nothing persisted)', async () => {
    const { prisma, service } = build(2);
    prisma.periodLock.findFirst.mockResolvedValue(LOCK_ROW);

    await expect(service.create(dataEntry(), CREATE_DTO)).rejects.toThrow(
      /period .* is locked/i,
    );
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
  });

  it('blocks updating a record whose period is locked', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-l', createdBy: 'user-entry' }),
    );
    prisma.periodLock.findFirst.mockResolvedValue(LOCK_ROW);

    await expect(
      service.update(dataEntry(), 'rec-l', { activityValue: 1 }),
    ).rejects.toThrow(/period .* is locked/i);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('blocks re-targeting a record INTO a locked period', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-m', reportingPeriod: 'monthly', periodValue: 'March', createdBy: 'user-entry' }),
    );
    // Current period (March) open, target period (April) locked.
    prisma.periodLock.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(LOCK_ROW);

    await expect(
      service.update(dataEntry(), 'rec-m', { periodValue: 'April' }),
    ).rejects.toThrow(/period .* is locked/i);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('blocks deleting a record in a locked period', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-d', createdBy: 'user-entry' }),
    );
    prisma.periodLock.findFirst.mockResolvedValue(LOCK_ROW);

    await expect(service.remove(dataEntry(), 'rec-d')).rejects.toThrow(
      /period .* is locked/i,
    );
    expect(prisma.activityRecord.delete).not.toHaveBeenCalled();
  });

  it('blocks submitting a draft in a locked period', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-s', status: ActivityRecordStatus.draft }),
    );
    prisma.periodLock.findFirst.mockResolvedValue(LOCK_ROW);

    await expect(service.submit(dataEntry(), 'rec-s')).rejects.toThrow(
      /period .* is locked/i,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('queries the lock with the record period tuple', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(dataEntry(), CREATE_DTO);
    expect(prisma.periodLock.findFirst).toHaveBeenCalledWith({
      where: {
        subsidiaryId: 'sub-1',
        reportingYear: 2024,
        reportingPeriod: 'annual',
        periodValue: 'Annual',
      },
    });
  });
});
