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
import {
  ActivityRecordsService,
  EVIDENCE_REFUSAL_FRAGMENT,
  RESUBMIT_AUTHOR_REFUSAL,
  SUBMIT_ROLE_REFUSAL,
  VARIANCE_REFUSAL,
} from './activity-records.service';
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
    // Default []: no actor resolves, so every resolved name reads null — the
    // deleted-profile case. Tests that care about a real name stub it.
    profile: {
      findMany: vi.fn().mockResolvedValue([]),
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
/**
 * Every column `toAuditSnapshot` is allowed to carry, and nothing else.
 *
 * Written out rather than derived, because deriving it from the function's
 * own output would assert nothing. `audit_log` is append-only with no
 * correction path, so a field reaching it is permanent — this list failing is
 * the intended outcome of adding one, resolved or persisted.
 */
const PERSISTED_KEYS = [
  'id', 'subsidiaryId', 'locationId', 'reportingYear', 'reportingPeriod',
  'periodValue', 'category', 'scope', 'status', 'activityValue',
  'activityUnit', 'input', 'calculation', 'createdBy', 'anomalyFlag',
  'anomalyBaselinePriorCount', 'anomalyBaselineTCo2e', 'varianceReason',
  'reviewedBy', 'reviewedAt', 'reviewNote', 'submittedAt', 'voidReason', 'voidedBy',
  'voidedAt', 'evidenceCount', 'createdAt', 'updatedAt',
].sort();


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
    // Defaulted for the same reason `factorId` is (see above): a fixture that
    // omits a NOT-NULL-ish column hands `toDTO` an `undefined` where the
    // contract says a number, and the next assertion written against a read
    // path gets written to expect it.
    anomalyBaselinePriorCount: null,
    anomalyBaselineTCo2e: null,
    varianceReason: null,
    submittedAt: null,
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
    accessibleSubsidiaryIds: ['sub-1'],
    ...overrides,
  };
}

function consultant(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-consultant',
    email: 'consultant@tonyai.local',
    fullName: 'Consultant User',
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
    // Whole key SET, on BOTH halves. A named check ("no `locationName`") is the
    // shape that let a fourth resolved field through, and `diff.before` was
    // asserted nowhere at all — on the very path this leak has a history on.
    expect(Object.keys(diff.before).sort()).toEqual(PERSISTED_KEYS);
    expect(Object.keys(diff.after).sort()).toEqual(PERSISTED_KEYS);
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

    // The SENTENCE, not just the class: the bulk importer re-throws on exact
    // equality with this constant to avoid mislabelling a role problem as an
    // authorship one, and nothing else in the repo pinned the wording.
    await expect(service.submit(consultant(), 'rec-c')).rejects.toThrow(
      SUBMIT_ROLE_REFUSAL,
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
      RESUBMIT_AUTHOR_REFUSAL,
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

  /**
   * the revision elements FR §4.3 requires (WP18 PR 2a) — withdrawing an approved figure.
   *
   * The only transition out of `approved` other than the lock/unlock cycle, so
   * every guard here is load-bearing: this is the one path that can remove a
   * reviewed number from the reported inventory.
   */
  describe('void — withdrawing an approved figure (the void path)', () => {
    const approved = (over: Partial<ActivityRecord> = {}) =>
      makeRecord({
        id: 'rec-v',
        status: ActivityRecordStatus.approved,
        calculation: { tCo2e: 19.8, factorId: 'factor-1' },
        ...over,
      } as Partial<ActivityRecord>);

    it('withdraws the figure without deleting the row', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(approved());
      prisma.activityRecord.update.mockImplementation(({ data }: any) =>
        makeRecord({ id: 'rec-v', ...data }),
      );

      await service.void(superAdmin(), 'rec-v', 'Duplicate of the site invoice for January');

      // The whole point: an UPDATE, never a delete. The row, its evidence and
      // its immutable calculation snapshot all survive — what changes is that
      // it stops counting.
      expect(prisma.activityRecord.delete).not.toHaveBeenCalled();
      const data = prisma.activityRecord.update.mock.calls[0][0].data;
      expect(data.status).toBe(ActivityRecordStatus.voided);
      expect(data.calculation).toBeUndefined();
      // three of the four elements FR §4.3 lists, stamped on the row rather than left for a
      // screen to reconstruct from the audit log.
      expect(data.voidReason).toBe('Duplicate of the site invoice for January');
      expect(data.voidedBy).toBe('user-admin');
      expect(data.voidedAt).toBeInstanceOf(Date);
    });

    it('refuses a record outside the caller\'s accessible set, as NOT FOUND', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(
        approved({ subsidiaryId: 'sub-other' } as Partial<ActivityRecord>),
      );

      // Tenant isolation on the newest mutation endpoint, which had none. Not
      // found rather than forbidden, and refused before any write, so a
      // super_admin of one tenant cannot use the response to confirm that a
      // record exists in another.
      await expect(
        service.void(
          superAdmin({ accessibleSubsidiaryIds: ['sub-1'] }),
          'rec-v',
          'A reason long enough to pass',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('checks tenancy BEFORE the role, so a 403 cannot confirm existence', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(
        approved({ subsidiaryId: 'sub-other' } as Partial<ActivityRecord>),
      );

      // A consultant asking about someone else's record must get the same
      // answer as a consultant asking about a record that does not exist.
      // Ordering the role gate first would leak existence through the
      // difference between 403 and 404.
      await expect(
        service.void(
          consultant({ accessibleSubsidiaryIds: ['sub-1'] }),
          'rec-v',
          'A reason long enough to pass',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the withdrawal on the record itself, not only in the audit log', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(approved());
      prisma.activityRecord.update.mockImplementation(({ data }: any) =>
        makeRecord({ id: 'rec-v', ...data }),
      );

      const dto = await service.void(superAdmin(), 'rec-v', 'Superseded by the site invoice');

      // `/audit` is super_admin-only, so for every other seat the record itself
      // is the only place the withdrawal is visible at all.
      expect(dto.voidReason).toBe('Superseded by the site invoice');
      expect(dto.voidedBy).toBe('user-admin');
      expect(dto.voidedAt).not.toBeNull();
    });

    it('names the person on the WRITE response, not only on a later read', async () => {
      const { prisma, service } = build();
      prisma.profile.findMany.mockResolvedValue([]);
      prisma.activityRecord.findUnique.mockResolvedValue(approved());
      prisma.activityRecord.update.mockImplementation(({ data }: any) =>
        makeRecord({ id: 'rec-v', ...data }),
      );

      const dto = await service.void(superAdmin(), 'rec-v', 'Superseded by the site invoice');

      // The exact regression three review seats independently found on the
      // reviewer column in WP22 PR D: both screens splice a write response into
      // read-built state, so a write path that omits the name empties the
      // column at the very click that sets the actor — "Withdrawn by —" on a
      // figure this request just withdrew.
      //
      // `profile.findMany` returns NOTHING here on purpose: the acting user is
      // seeded into the actor map from the request itself, so resolving them
      // must not depend on a database round-trip that the write path has no
      // reason to make.
      expect(dto.voidedByName).toBe('Admin User');
    });

    it('distinguishes "never withdrawn" from "the person who withdrew it is gone"', async () => {
      const { prisma, service } = build();
      prisma.profile.findMany.mockResolvedValue([]);
      prisma.activityRecord.findUnique.mockResolvedValue(
        makeRecord({ subsidiaryId: 'sub-1', voidedBy: 'user-ghost' }),
      );

      const dto = await service.get(consultant(), 'rec-1');

      // Both read `voidedByName: null`; `voidedBy` is the discriminator, which
      // is why it stays on the DTO beside the name. Rendering a never-withdrawn
      // record as "withdrawn by a deleted user" would claim a restatement that
      // never happened — and a withdrawal is the one action here that cannot be
      // undone.
      expect(dto.voidedByName).toBeNull();
      expect(dto.voidedBy).toBe('user-ghost');

      prisma.activityRecord.findUnique.mockResolvedValue(
        makeRecord({ subsidiaryId: 'sub-1', voidedBy: null }),
      );
      const never = await service.get(consultant(), 'rec-1');
      expect(never.voidedByName).toBeNull();
      expect(never.voidedBy).toBeNull();
    });

    it('is super_admin only — a consultant may reject, never withdraw', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(approved());

      // A consultant reviews and can send a record BACK. Taking an accepted
      // figure out of the client's reported inventory is the holding company's
      // decision, exactly as approving it is.
      await expect(
        service.void(consultant(), 'rec-v', 'Not my call to make'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.void(dataEntry(), 'rec-v', 'Not my call to make'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('refuses anything that is not approved, naming the unlock path', async () => {
      const { prisma, service } = build();
      for (const status of [
        ActivityRecordStatus.draft,
        ActivityRecordStatus.rejected,
        ActivityRecordStatus.submitted,
        ActivityRecordStatus.under_review,
        ActivityRecordStatus.voided,
      ]) {
        prisma.activityRecord.findUnique.mockResolvedValue(approved({ status }));
        await expect(
          service.void(superAdmin(), 'rec-v', 'A reason long enough to pass'),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      // `locked` is the one worth naming: it means the period is closed, and
      // letting a void bypass that would make the lock a suggestion.
      prisma.activityRecord.findUnique.mockResolvedValue(
        approved({ status: ActivityRecordStatus.locked }),
      );
      await expect(
        service.void(superAdmin(), 'rec-v', 'A reason long enough to pass'),
      ).rejects.toThrow(/unlocked first/i);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('cannot be undone by voiding twice, or edited back into the inventory', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(
        approved({ status: ActivityRecordStatus.voided }),
      );

      // A voided record is outside EDITABLE_STATUSES and SUBMITTABLE_STATUSES,
      // so there is no route back in. That is deliberate: re-entering a figure
      // means recording it again, with its own provenance, not resurrecting a
      // withdrawn one.
      await expect(
        service.update(superAdmin(), 'rec-v', { activityValue: 5000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.submit(superAdmin(), 'rec-v')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.remove(superAdmin(), 'rec-v')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses inside a locked period even for an approved record', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(approved());
      prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });

      await expect(
        service.void(superAdmin(), 'rec-v', 'A reason long enough to pass'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('writes only while the record is still approved, so a lock cannot be overwritten', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(approved());
      prisma.activityRecord.update.mockImplementation(({ data }: any) =>
        makeRecord({ id: 'rec-v', ...data }),
      );

      await service.void(superAdmin(), 'rec-v', 'A reason long enough to pass');

      // The status is part of the WHERE, not just the guard above it. Every
      // other transition writes on the id alone and is safe doing so, because
      // `lock` refuses to run while a pending-review record exists — but
      // `approved` is the one status `lock` DOES mutate. A lock committing
      // between the check and the write would otherwise be silently
      // overwritten, leaving the record voided inside a closed period with no
      // unlock able to reopen it.
      expect(prisma.activityRecord.update.mock.calls[0][0].where).toEqual({
        id: 'rec-v',
        status: ActivityRecordStatus.approved,
      });
    });

    it('answers 409, not 500, when the record moves out from under the write', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(approved());
      prisma.activityRecord.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Record to update not found', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      // The row plainly exists — it was just read. P2025 here means it stopped
      // being `approved`, in practice because a lock landed in the window, so
      // the honest answer is the lock's own refusal rather than a server error.
      await expect(
        service.void(superAdmin(), 'rec-v', 'A reason long enough to pass'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('audits the withdrawal under its own verb, carrying the figure it removed', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(approved());
      prisma.activityRecord.update.mockImplementation(({ data }: any) =>
        makeRecord({ id: 'rec-v', ...data }),
      );

      await service.void(superAdmin(), 'rec-v', 'Duplicate of the site invoice');

      const call = audit.record.mock.calls[0][1];
      // Its own verb, not a generic `update`: "what was restated and why" has
      // to be filterable in the trail rather than buried in a diff.
      expect(call.action).toBe('void');
      expect(call.diff.transition).toEqual({ from: 'approved', to: 'voided' });
      expect(call.diff.voidReason).toBe('Duplicate of the site invoice');
      // The audit row is the last place the withdrawn figure is reported
      // alongside the reason — FR §4.3's "original value visibility".
      expect(call.diff.before.calculation).toEqual({ tCo2e: 19.8, factorId: 'factor-1' });
      expect(call.diff.before.status).toBe('approved');
    });
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

    // Against the EXPORTED fragment, not a retyped prefix of it. The bulk
    // importer discriminates this refusal from the status one by that exact
    // string, so a reworded tail ("… evidence file." losing "before
    // submitting") would keep this regex green while every bulk evidence
    // refusal silently became "Already moved on".
    await expect(service.submit(dataEntry(), 'rec-e')).rejects.toThrow(
      EVIDENCE_REFUSAL_FRAGMENT,
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
  // A third prior usually has to come from the PREVIOUS year — the subject is
  // March, and only two months precede it inside 2024. That is not a workaround:
  // the baseline query has no `reportingYear` filter (the year enters through
  // the ordinal key alone, so December seeds January), and until VAR §4.1
  // required three priors nothing exercised it.
  const priorMonth = (periodValue: string, tCo2e: number, reportingYear?: number) =>
    makeRecord({
      reportingPeriod: 'monthly',
      periodValue,
      ...(reportingYear !== undefined ? { reportingYear } : {}),
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
      priorMonth('December', 10, 2023),
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
    // Baseline avg = 15; current = 19.8 → +32% → within threshold. Three priors,
    // deliberately: with two this would pass because the rule never RAN, which
    // is a different claim from the one the test makes.
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('December', 15, 2023),
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
      priorMonth('December', 10, 2023),
      priorMonth('January', 10),
      priorMonth('February', 10),
      priorMonth('April', 40), // later than March → ignored
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(dataEntry(), MONTHLY_DTO);
    // The intruder's VALUE is load-bearing. At 19 this test could not fail: an
    // admitted April gives a baseline of 13, and 19.8 is +52% of that — still
    // flagged, still green. At 40 an admitted April gives 20, and 19.8 is -1%,
    // so the assertion below genuinely depends on April being excluded.
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

  // --- The strict window, and the provenance that makes it legible ---------
  //
  // VAR §4.1 asks for the previous THREE periods. The rule used to run on as
  // few as one, so a green cell could mean "compared against one month" and
  // nothing said so. Fewer than three is now NOT EVALUATED, and the count
  // travels with the verdict — without it the strict rule would be strictly
  // less informative than the loose one it replaced.

  it('does not flag a deviation of exactly the threshold (VAR §4.2 says MORE than)', async () => {
    const { prisma, calc, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    // 15 against a baseline of 10 is +50% EXACTLY, and all three of 15, 10 and
    // the 5 between them are exact in binary. The suite's usual 19.8 cannot
    // express this case at all: 19.8 - 13.2 is 6.600000000000001, so the ratio
    // lands a hair ABOVE the threshold and the boundary is never reached.
    calc.compute.mockResolvedValue({ ...calc.snapshot, tCo2e: 15, kgCo2e: 15000 });
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('December', 10, 2023),
      priorMonth('January', 10),
      priorMonth('February', 10),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(dataEntry(), MONTHLY_DTO);

    // `>` vs `>=` on the threshold survived the whole suite until this test:
    // every other fixture sits far from the boundary, so the one comparison
    // VAR §4.2 words precisely ("more than 50 percent") was unpinned.
    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.anomalyFlag).toBe(false);
    expect(data.anomalyBaselinePriorCount).toBe(3);
    expect(data.anomalyBaselineTCo2e).toBe(10);
  });

  it('does not evaluate a value scored on fewer than three priors, and records how many it had', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    // 19.8 against an average of 10 is +98% — the old rule flagged exactly this.
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('January', 10),
      priorMonth('February', 10),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    const dto = await service.create(dataEntry(), MONTHLY_DTO);

    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.anomalyFlag).toBe(false);
    expect(data.anomalyBaselinePriorCount).toBe(2);
    // Null, not the two-period average: a number here would be an average no
    // rule used, and a screen would show it as the thing the value was judged
    // against.
    expect(data.anomalyBaselineTCo2e).toBeNull();
    expect(dto.anomalyBaselinePriorCount).toBe(2);
    expect(dto.anomalyBaselineTCo2e).toBeNull();
  });

  it('persists the baseline it judged against when the window is full', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('December', 9, 2023),
      priorMonth('January', 10),
      priorMonth('February', 11),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    const dto = await service.create(dataEntry(), MONTHLY_DTO);

    expect(dto.anomalyBaselinePriorCount).toBe(3);
    expect(dto.anomalyBaselineTCo2e).toBe(10);
    expect(dto.anomalyFlag).toBe(true); // 19.8 vs 10 → +98%
  });

  it('a prior without a figure consumes a slot, leaving the window short', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('November', 10, 2023), // older — must NOT be pulled in to fill the gap
      priorMonth('December', 10, 2023),
      priorMonth('January', 10),
      // An invoice-tracked category with no factor: stored, committed, and
      // carrying no tCO₂e. It is the NEWEST prior, so it takes a slot.
      makeRecord({
        reportingPeriod: 'monthly',
        periodValue: 'February',
        status: ActivityRecordStatus.approved,
        calculation: { reasonCode: 'no_emission_factor' },
      }),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(dataEntry(), MONTHLY_DTO);

    // Two figures out of three slots → the rule does not run, even though a
    // fourth comparable period exists just outside the window.
    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.anomalyBaselinePriorCount).toBe(2);
    expect(data.anomalyFlag).toBe(false);
  });

  it('reports a full window that averages to zero rather than hiding it', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('December', 0, 2023),
      priorMonth('January', 0),
      priorMonth('February', 0),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(dataEntry(), MONTHLY_DTO);

    // No ratio is computable against zero, so no warning — but three priors of
    // zero is a fact about the series, and the record says so instead of
    // reading like a record that had no priors at all.
    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.anomalyFlag).toBe(false);
    expect(data.anomalyBaselinePriorCount).toBe(3);
    expect(data.anomalyBaselineTCo2e).toBe(0);
  });

  it('orders quarterly periods correctly (Q1<Q2<Q3, Q4 excluded)', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([
      makeRecord({ reportingPeriod: 'quarterly', periodValue: 'Q4', reportingYear: 2023, status: ActivityRecordStatus.approved, calculation: { tCo2e: 10, factorId: 'f-1' } }),
      makeRecord({ reportingPeriod: 'quarterly', periodValue: 'Q1', status: ActivityRecordStatus.approved, calculation: { tCo2e: 10, factorId: 'f-1' } }),
      makeRecord({ reportingPeriod: 'quarterly', periodValue: 'Q2', status: ActivityRecordStatus.approved, calculation: { tCo2e: 10, factorId: 'f-1' } }),
      // Same reasoning as the monthly case: at 19 an admitted Q4 still leaves
      // the value flagged, so the exclusion went unproven. At 40 it does not.
      makeRecord({ reportingPeriod: 'quarterly', periodValue: 'Q4', status: ActivityRecordStatus.approved, calculation: { tCo2e: 40, factorId: 'f-1' } }), // later → excluded
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
      priorMonth('December', 10, 2023),
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
    // NULL, not 0: the pool was never LOOKED AT, and the record may well sit on
    // a full year of neighbours. A `0` here would be a claim about its history
    // — and one every reader outside TypeScript would have had to re-derive
    // `isCalculated()` to disbelieve.
    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.anomalyBaselinePriorCount).toBeNull();
    expect(data.anomalyBaselineTCo2e).toBeNull();
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
    prisma.activityRecord.findMany.mockResolvedValue([priorMonth('December', 10, 2023), priorMonth('January', 10), priorMonth('February', 10)]);

    // The whole constant, not a loose alternation: the bulk mapper compares
    // this message for EXACT equality, so `/variance comment|deviates/i`
    // matched a reworded sentence that the mapper then failed to recognise.
    await expect(service.submit(dataEntry(), 'rec-s')).rejects.toThrow(
      VARIANCE_REFUSAL,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('allows submit of an anomalous record once a variance comment is present (persists the fresh flag)', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draftForSubmit({ varianceReason: 'Plant expansion' }));
    prisma.activityRecord.findMany.mockResolvedValue([priorMonth('December', 10, 2023), priorMonth('January', 10), priorMonth('February', 10)]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-s', ...data }));

    const dto = await service.submit(dataEntry(), 'rec-s');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    expect(prisma.activityRecord.update.mock.calls[0][0].data.anomalyFlag).toBe(true);
  });

  // The provenance is written at THREE moments, and until these two tests
  // existed only the first was asserted: dropping the write at update or at
  // submit, or hardcoding it, left the whole suite green. Each test arranges a
  // window that differs from what the record already stores, so a stale value
  // is as visible as a missing one.

  it('update persists the window it re-scored against, not the one create wrote', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-u',
        subsidiaryId: 'sub-1',
        reportingPeriod: 'monthly',
        periodValue: 'March',
        createdBy: 'user-entry',
        // What create wrote when this record was first saved and its series
        // was empty. The pool has moved since.
        anomalyBaselinePriorCount: 0,
        anomalyBaselineTCo2e: null,
      }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('December', 9, 2023),
      priorMonth('January', 10),
      priorMonth('February', 11),
    ]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-u', ...data }),
    );

    const dto = await service.update(dataEntry(), 'rec-u', { activityValue: 5000 });

    const { data } = prisma.activityRecord.update.mock.calls[0][0];
    expect(data.anomalyBaselinePriorCount).toBe(3);
    expect(data.anomalyBaselineTCo2e).toBe(10);
    expect(dto.anomalyBaselinePriorCount).toBe(3);
  });

  it('submit persists the window as of submit time', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      draftForSubmit({ anomalyBaselinePriorCount: 3, anomalyBaselineTCo2e: 99 }),
    );
    // Two priors now — fewer than the record claims to have been scored on, and
    // fewer than the rule needs. Both halves of the stale claim must be
    // replaced, not just the flag.
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('January', 10),
      priorMonth('February', 10),
    ]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-s', ...data }),
    );

    await service.submit(dataEntry(), 'rec-s');

    const { data } = prisma.activityRecord.update.mock.calls[0][0];
    expect(data.anomalyBaselinePriorCount).toBe(2);
    expect(data.anomalyBaselineTCo2e).toBeNull();
    expect(data.anomalyFlag).toBe(false);
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

describe('ActivityRecordsService — periodValue is canonicalised on write', () => {
  /**
   * Validation was always case-insensitive; storage was verbatim. Everything
   * that then read the column compared RAW strings — the uniqueness index, both
   * period-lock lookups, the seed's de-duplication key — so `"january"` and
   * `"January"` were two rows for one month, and both counted towards the
   * emissions inventory. The fix is not stricter validation; it is storing one
   * spelling.
   */
  const monthly = (periodValue: string) => ({
    ...CREATE_DTO,
    reportingPeriod: 'monthly' as const,
    periodValue,
  });

  const createdWith = async (dto: Parameters<typeof monthly>[0] | object) => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.activityRecord.create.mockImplementation(({ data }: never) =>
      makeRecord({ id: 'rec-1', ...(data as object) }),
    );
    await service.create(dataEntry(), dto as never);
    return prisma;
  };

  it('stores the canonical spelling, whatever casing the caller sent', async () => {
    for (const sent of ['january', 'JANUARY', 'JaNuArY']) {
      const prisma = await createdWith(monthly(sent));
      expect(prisma.activityRecord.create.mock.calls[0][0].data.periodValue).toBe(
        'January',
      );
    }
  });

  it('trims, because a stored space is a different index key', async () => {
    // `" January "` passed validation — which trims only to COMPARE — and was
    // then written with its spaces, occupying a slot of its own.
    const prisma = await createdWith(monthly('  January  '));
    expect(prisma.activityRecord.create.mock.calls[0][0].data.periodValue).toBe(
      'January',
    );
  });

  it('canonicalises quarters and the annual token too', async () => {
    const q = await createdWith({ ...CREATE_DTO, reportingPeriod: 'quarterly', periodValue: 'q3' });
    expect(q.activityRecord.create.mock.calls[0][0].data.periodValue).toBe('Q3');
    const a = await createdWith({ ...CREATE_DTO, periodValue: 'annual' });
    expect(a.activityRecord.create.mock.calls[0][0].data.periodValue).toBe('Annual');
  });

  it('looks the period lock up by the canonical spelling', async () => {
    // The sharpest consequence, and not a data-quality one: a lock stored as
    // `"January"` did not block a record sent as `"january"`, because the gate
    // is raw Postgres equality. A period a super_admin believes is closed went
    // on accepting writes.
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1', subsidiaryId: 'sub-1' });

    await expect(service.create(dataEntry(), monthly('january'))).rejects.toThrow(
      /period .* is locked/i,
    );
    expect(prisma.periodLock.findFirst.mock.calls[0][0].where).toMatchObject({
      periodValue: 'January',
    });
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
  });

  it('canonicalises on update, and only when the caller sent one', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-1', reportingPeriod: 'monthly', periodValue: 'March' }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.activityRecord.update.mockImplementation(({ data }: never) =>
      makeRecord({ id: 'rec-1', ...(data as object) }),
    );

    await service.update(dataEntry(), 'rec-1', { periodValue: 'april' } as never);
    expect(prisma.activityRecord.update.mock.calls[0][0].data.periodValue).toBe('April');

    // An edit that does not mention the period must not rewrite it — that would
    // put a change into the append-only audit diff that the user never made.
    prisma.activityRecord.update.mockClear();
    await service.update(dataEntry(), 'rec-1', { activityValue: 12 } as never);
    expect(prisma.activityRecord.update.mock.calls[0][0].data.periodValue).toBeUndefined();
  });

  it('still refuses a value that names no period at all', async () => {
    const { service } = build(2);
    // Canonicalising must not become "accept anything and guess". An
    // abbreviation names no period, so it is a 400 exactly as before.
    await expect(service.create(dataEntry(), monthly('Mar'))).rejects.toThrow(
      /not a valid period/i,
    );
    await expect(service.create(dataEntry(), monthly('2024-03'))).rejects.toThrow(
      /not a valid period/i,
    );
  });

  it('quotes the value it refuses, cleaned and bounded', async () => {
    // A bulk import repeats this sentence in its report, and a U+202E in the
    // value reversed the rest of it on screen. Built from a code point, never
    // typed.
    const { service } = build(2);
    const rlo = String.fromCharCode(0x202e);

    await expect(
      service.create(dataEntry(), monthly(`Ma${rlo}r${'x'.repeat(60)}`)),
    ).rejects.toThrow(
      `"Mar${'x'.repeat(37)}…" is not a valid period for a monthly record.`,
    );
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

/**
 * Who entered a record, and who decided it — resolved at read time.
 *
 * `/review` and `/emissions` showed NOTHING about either: a reviewer could not
 * see who submitted the record they were deciding, and "who approved this" was
 * recoverable only by cross-referencing `/audit`. `created_by` and `reviewed_by`
 * are plain UUIDs with no FK to `profiles` (the row must survive the actor's
 * deletion), so there is no `include` — the join happens here.
 */

/**
 * Who entered a record, and who decided it — resolved at read time.
 *
 * `/review` and `/emissions` showed NOTHING about either: a reviewer could not
 * see who submitted the record they were deciding, and "who approved this" was
 * recoverable only by cross-referencing `/audit`. `created_by` and `reviewed_by`
 * are plain UUIDs with no FK to `profiles` (the row must survive the actor's
 * deletion), so there is no `include` — the join happens here.
 */
describe('ActivityRecordsService — actor names are resolved', () => {
  const PROFILES = [
    { id: 'user-entry', email: 'entry@tonyai.local', fullName: 'Entry User' },
    { id: 'user-admin', email: 'admin@tonyai.local', fullName: 'Admin User' },
  ];

  it('list resolves BOTH actor columns in a single query for the whole page', async () => {
    const { prisma, service } = build();
    prisma.profile.findMany.mockResolvedValue(PROFILES);
    prisma.activityRecord.findMany.mockResolvedValue([
      { ...makeRecord({ id: 'r1', reviewedBy: 'user-admin' }), _count: { evidence: 1 } },
      { ...makeRecord({ id: 'r2', reviewedBy: 'user-admin' }), _count: { evidence: 0 } },
    ]);

    // A consultant, so neither actor is the caller and both need looking up.
    const rows = await service.list(consultant(), {});

    expect(rows.map((r) => r.createdByName)).toEqual(['Entry User', 'Entry User']);
    expect(rows.map((r) => r.reviewedByName)).toEqual(['Admin User', 'Admin User']);
    // ONE query for the page, not one per row and not one per column. The queue
    // pulls every pending record, so per-row resolution is the shape that
    // quietly turns a review screen into an N+1.
    expect(prisma.profile.findMany).toHaveBeenCalledTimes(1);
    // Sorted, and only the id set is pinned: asserting the literal array would
    // fix the ORDER of a `Set` iteration and forbid ever adding a field to this
    // `where` — a test failing because someone HARDENED the query is a test
    // that will be deleted rather than read.
    const where = prisma.profile.findMany.mock.calls[0][0].where;
    expect([...where.id.in].sort()).toEqual(['user-admin', 'user-entry']);
  });

  it('get resolves the record it returns', async () => {
    const { prisma, service } = build();
    prisma.profile.findMany.mockResolvedValue(PROFILES);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-in', subsidiaryId: 'sub-1', reviewedBy: 'user-admin' }),
    );

    const dto = await service.get(consultant(), 'rec-in');
    expect(dto.createdByName).toBe('Entry User');
    expect(dto.reviewedByName).toBe('Admin User');
  });

  it('names the caller on a create WITHOUT a profile query', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    const dto = await service.create(dataEntry(), CREATE_DTO);

    // `created_by` on a create is always the caller, and the auth guard has
    // already loaded that whole profile to build `RequestUser`. This is the
    // measurement behind making the field required: the cost that argued for
    // resolving on reads only is, on the commonest write, zero.
    expect(dto.createdByName).toBe('Entry User');
    expect(dto.reviewedByName).toBeNull();
    expect(prisma.profile.findMany).not.toHaveBeenCalled();
  });

  it('carries the names on update and on a review transition', async () => {
    const { prisma, service } = build();
    prisma.profile.findMany.mockResolvedValue(PROFILES);
    // `update` re-runs the calc, which needs the subsidiary's geography.
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.activityRecord.findUnique.mockResolvedValue({
      ...makeRecord({ id: 'rec-u', subsidiaryId: 'sub-1' }),
      _count: { evidence: 0 },
    });
    prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
      ...makeRecord({ id: 'rec-u', subsidiaryId: 'sub-1', ...data }),
      _count: { evidence: 0 },
    }));

    // Both screens splice a write response straight into state built from a
    // read. When these responses omitted the names, the actor column emptied
    // the instant a reviewer acted — and "Reviewed by —" appeared on a record
    // whose reviewer had just been set by that very click.
    const updated = await service.update(dataEntry(), 'rec-u', { activityValue: 5000 });
    expect(updated.createdByName).toBe('Entry User');

    prisma.activityRecord.findUnique.mockResolvedValue({
      ...makeRecord({ id: 'rec-u', subsidiaryId: 'sub-1', status: ActivityRecordStatus.submitted }),
      _count: { evidence: 1 },
    });
    const reviewed = await service.approve(superAdmin(), 'rec-u');
    expect(reviewed.createdByName).toBe('Entry User');
    expect(reviewed.reviewedByName).toBe('Admin User');
    expect(reviewed.reviewedBy).toBe('user-admin');
  });

  it('resolves a withdrawal by SOMEONE ELSE, which the acting-user shortcut cannot', async () => {
    const { prisma, service } = build();
    // The mock RESPECTS its filter, and that is the whole point of this test.
    // `mockResolvedValue(PROFILES)` answers every query with every profile, so
    // a name resolves whether or not its id was ever asked for — under that
    // mock, deleting `voidedBy` from `actorsFor`'s gather passes. Measured:
    // that mutation left all 116 tests green until this filter existed.
    prisma.profile.findMany.mockImplementation(({ where }: any) =>
      PROFILES.filter((profile) => where.id.in.includes(profile.id)),
    );
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ subsidiaryId: 'sub-1', voidedBy: 'user-admin' }),
    );

    // Reading SOMEONE ELSE's withdrawal is the only path that needs the query:
    // on a withdrawal the actor is the requesting user, who is seeded into the
    // actor map from the request itself, so the write response resolves the
    // name whether or not the column is gathered at all.
    const dto = await service.get(consultant(), 'rec-1');
    expect(dto.voidedByName).toBe('Admin User');
  });

  it('reads null — not the raw id — when the actor profile is gone', async () => {
    const { prisma, service } = build();
    prisma.profile.findMany.mockResolvedValue([]);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ subsidiaryId: 'sub-1', reviewedBy: 'user-admin' }),
    );

    const dto = await service.get(consultant(), 'rec-1');
    // Erasure has to remove the NAME and keep the row. Leaking the uuid back
    // as a display value would undo exactly what read-time resolution buys.
    expect(dto.createdByName).toBeNull();
    expect(dto.reviewedByName).toBeNull();
    expect(dto.voidedByName).toBeNull();
    expect(dto.createdBy).toBe('user-entry');
  });

  it('distinguishes "nobody has reviewed this" from "the reviewer is gone"', async () => {
    const { prisma, service } = build();
    prisma.profile.findMany.mockResolvedValue(PROFILES);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ subsidiaryId: 'sub-1', reviewedBy: null }),
    );

    const dto = await service.get(consultant(), 'rec-1');
    // Both read `reviewedByName: null`. `reviewedBy` is what tells them apart,
    // which is why it stays on the DTO next to the name — rendering an
    // unreviewed record as "deleted user" would claim someone decided it.
    expect(dto.reviewedByName).toBeNull();
    expect(dto.reviewedBy).toBeNull();
  });

  it('lets NOTHING but a persisted column reach the append-only audit log', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(dataEntry(), CREATE_DTO);

    // A WHOLE-KEY-SET assertion, not a list of forbidden names. The first cut
    // checked three known keys were absent, and a review proved that a FOURTH
    // resolved field — an actor email, say — reached the snapshot with both the
    // compiler and the full suite green. This fails on any new key, which
    // forces the decision to be made rather than defaulted.
    //
    // The compiler helps too, but only halfway, and the half matters: with the
    // name fields REQUIRED, `Omit` rejects one written as a direct property
    // (measured: TS2561) where an optional one passed silently. It does NOT
    // reject the same field arriving through a SPREAD — excess-property
    // checking does not apply through one, measured at 0 errors for both
    // `...{ createdByName }` and `...{ createdByEmail }`. This assertion is
    // what covers that form, and it is the form a real leak would take.
    const { diff } = audit.record.mock.calls.at(-1)![1] as { diff: Record<string, unknown> };
    // Kept from the first cut: without it a snapshot that came back undefined
    // fails as `TypeError: Cannot convert undefined or null to object` rather
    // than as a legible assertion about what was audited.
    expect(diff.after).toBeDefined();
    expect(Object.keys(diff.after as object).sort()).toEqual(PERSISTED_KEYS);
  });
});

/**
 * When a record was submitted for review.
 *
 * The queue counted a reviewer's waiting time from `created_at`, i.e. from when
 * the DRAFT was made — a record started in January and submitted in June read
 * as five months overdue. The column was honestly headed "Age" for exactly that
 * reason; this is what lets it become "Waiting" and mean it.
 */
describe('ActivityRecordsService — submittedAt', () => {
  const submittable = (over: Partial<ActivityRecord> = {}) => ({
    ...makeRecord({
      id: 'rec-s',
      subsidiaryId: 'sub-1',
      status: ActivityRecordStatus.draft,
      ...over,
    }),
    _count: { evidence: 1 },
  });

  const arrange = () => {
    const { prisma, service } = build();
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
      ...makeRecord({ id: 'rec-s', subsidiaryId: 'sub-1', ...data }),
      _count: { evidence: 1 },
    }));
    return { prisma, service };
  };

  it('stamps the submission time on submit', async () => {
    const { prisma, service } = arrange();
    prisma.activityRecord.findUnique.mockResolvedValue(submittable());

    const dto = await service.submit(dataEntry(), 'rec-s');

    const written = prisma.activityRecord.update.mock.calls.at(-1)![0].data;
    expect(written.submittedAt).toBeInstanceOf(Date);
    expect(dto.submittedAt).not.toBeNull();
  });

  it('re-stamps on a RESUBMIT rather than keeping the first attempt', async () => {
    const { prisma, service } = arrange();
    // A rejected record carries the previous attempt's stamp. Resubmitting
    // starts the reviewer's clock again — which is the question the queue
    // asks — and matches how `reviewedAt` is already overwritten on every
    // review outcome. The per-attempt history lives in `audit_log`.
    const first = new Date('2026-02-01T09:00:00.000Z');
    prisma.activityRecord.findUnique.mockResolvedValue(
      submittable({
        status: ActivityRecordStatus.rejected,
        submittedAt: first,
        createdBy: 'user-entry',
      }),
    );

    await service.submit(dataEntry(), 'rec-s');

    const written = prisma.activityRecord.update.mock.calls.at(-1)![0].data;
    expect(written.submittedAt).toBeInstanceOf(Date);
    expect((written.submittedAt as Date).getTime()).toBeGreaterThan(first.getTime());
  });

  // EVERY non-submit transition, not just approve. Testing one of them let two
  // mutants live: stamping on `under_review` as well passed the whole suite,
  // and that is the WP22-D regression in a new place — WP7 keeps a record in
  // the queue through `under_review`, so a reviewer would watch the Waiting
  // cell drop from 9d to 0d on the click that made them the reviewer.
  const NON_SUBMIT: ReadonlyArray<
    [string, (s: ReturnType<typeof arrange>['service']) => Promise<unknown>, ActivityRecordStatus]
  > = [
    ['startReview', (svc) => svc.startReview(superAdmin(), 'rec-s'), ActivityRecordStatus.submitted],
    ['approve', (svc) => svc.approve(superAdmin(), 'rec-s'), ActivityRecordStatus.submitted],
    ['reject', (svc) => svc.reject(superAdmin(), 'rec-s', 'Meter reading does not match.'), ActivityRecordStatus.submitted],
    ['void', (svc) => svc.void(superAdmin(), 'rec-s', 'Duplicate of the site invoice for the month.'), ActivityRecordStatus.approved],
  ];

  it.each(NON_SUBMIT)('leaves it alone on %s', async (_name, act, from) => {
    const { prisma, service } = arrange();
    const stamped = new Date('2026-02-01T09:00:00.000Z');
    prisma.activityRecord.findUnique.mockResolvedValue(
      submittable({ status: from, submittedAt: stamped }),
    );

    await act(service);

    // The submission instant is the START of the reviewer's window. Every one
    // of these either continues that window (startReview) or ends it
    // (approve/reject/void); overwriting the start would erase how long it
    // took, and on `startReview` it would do so while the row is still on
    // screen showing the number.
    const written = prisma.activityRecord.update.mock.calls.at(-1)![0].data;
    expect(written).not.toHaveProperty('submittedAt');
  });

  it('is null on a record that has never been submitted', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ subsidiaryId: 'sub-1', submittedAt: null }),
    );

    // Every seeded record is in this state: the seed writes straight to
    // `approved` and never calls the submit path, so the backfill found
    // nothing for any of them. The screen has to render that as unknown.
    expect((await service.get(dataEntry(), 'rec-1')).submittedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * `previewCreate` is everything `create` DECIDES, with nothing it WRITES.
 *
 * It exists so the bulk importer (WP8) can offer a dry-run that provably
 * persists nothing. The mechanism matters: this service opens no transaction,
 * so there is no rollback to hide behind — the claim "the dry-run wrote
 * nothing" is only as good as an assertion against the write spies, which is
 * what this block is. If a future change moves any write into the prepare half,
 * these fail, and they fail before a user has imported a thousand rows into a
 * dry run.
 *
 * The gates are asserted here too, not only on `create`. A read-only seam that
 * skipped the role, tenant or period-lock check would be a way to ask the
 * server questions about a tenant you cannot reach.
 */
describe('ActivityRecordsService — previewCreate is the read-only half of create', () => {
  let prisma: PrismaMock;
  let service: ActivityRecordsService;

  beforeEach(() => {
    audit.record.mockClear();
    ({ prisma, service } = build());
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
  });

  /** Every spy on the mock that would leave a trace behind. */
  function expectNothingWritten() {
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(prisma.activityRecord.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  }

  it('returns the decisions create would make, and writes nothing', async () => {
    const prepared = await service.previewCreate(dataEntry(), CREATE_DTO);

    expect(prepared.periodValue).toBe('Annual');
    expect(prepared.scope).toBe(2);
    expect(isCalculated(prepared.calculation)).toBe(true);
    expect(prepared.verdict).toEqual({
      anomalous: false,
      priorCount: 0,
      baseline: null,
    });
    expectNothingWritten();
  });

  it('canonicalises the period spelling the same way create does', async () => {
    // The stored spelling IS the identity of the period, so a dry-run that
    // reported on " annual " would be answering about a different slot than
    // the apply would write to.
    const prepared = await service.previewCreate(dataEntry(), {
      ...CREATE_DTO,
      periodValue: '  aNNual ',
    });
    expect(prepared.periodValue).toBe('Annual');
    expectNothingWritten();
  });

  it('refuses a period value that names no period of that granularity', async () => {
    await expect(
      service.previewCreate(dataEntry(), {
        ...CREATE_DTO,
        periodValue: 'Michaelmas',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expectNothingWritten();
  });

  it('enforces the role gate BEFORE it queries anything', async () => {
    // consultant is review-only: it may not author records, and asking the
    // server to price one is authoring it in every sense but the write.
    // The query assertion is the half that matters: asserting only that a
    // ForbiddenException eventually emerges leaves the gate free to move
    // below the lock lookup, which a mutation proved survives the suite.
    await expect(
      service.previewCreate(consultant(), CREATE_DTO),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.periodLock.findFirst).not.toHaveBeenCalled();
    expect(prisma.subsidiary.findUnique).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('refuses an inaccessible subsidiary as a 404, with a lock in place', async () => {
    // The lock is mocked PRESENT deliberately. With the default empty mock
    // this case passed while the period-lock lookup still ran against another
    // tenant's subsidiary — so the 409/404 split answered "does that
    // subsidiary exist and is that period closed" for a tenant the caller
    // cannot see. Three review seats found it independently.
    prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });

    await expect(
      service.previewCreate(dataEntry(), {
        ...CREATE_DTO,
        subsidiaryId: 'sub-99',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.periodLock.findFirst).not.toHaveBeenCalled();
    expect(prisma.subsidiary.findUnique).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('refuses a malformed subsidiary id before Prisma can see it', async () => {
    // `subsidiaryId` is `@IsString`, not `@IsUUID` (the seed's ids are not
    // RFC-4122), but the column is `uuid`: a malformed value reaching a query
    // throws P2023, which the exception filter turns into a 500. In a bulk
    // import that is one 500 and one Sentry event per bad cell.
    await expect(
      service.previewCreate(dataEntry(), {
        ...CREATE_DTO,
        subsidiaryId: 'not-a-uuid',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.periodLock.findFirst).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('returns the identities it validated, not just the derived values', async () => {
    // A bulk importer assembling its write from a row template cannot safely
    // re-read the dto the way `create` does. If the preview hands back only
    // the derived half, an unvalidated subsidiaryId can carry a snapshot that
    // WAS validated, and nothing downstream re-checks it.
    const prepared = await service.previewCreate(dataEntry(), CREATE_DTO);
    expect(prepared.subsidiaryId).toBe('sub-1');
    expect(prepared.locationId).toBeNull();
  });

  it('still enforces the period-lock gate', async () => {
    prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });
    await expect(
      service.previewCreate(dataEntry(), CREATE_DTO),
    ).rejects.toBeInstanceOf(ConflictException);
    expectNothingWritten();
  });

  it('evaluates the anomaly baseline against committed priors', async () => {
    // The verdict is the one thing a dry-run can surface that a plain
    // validation pass cannot: an anomalous row with no variance reason imports
    // fine and can then never be submitted.
    // Monthly, and the third prior comes from the previous year, for the same
    // reason the anomaly block above says: only two months precede March in
    // 2024, and the baseline query orders by the ordinal key, not the year.
    const prior = (periodValue: string, reportingYear?: number) =>
      makeRecord({
        reportingPeriod: 'monthly',
        periodValue,
        ...(reportingYear !== undefined ? { reportingYear } : {}),
        status: ActivityRecordStatus.approved,
        calculation: { tCo2e: 5, factorId: 'f-1' },
      });
    prisma.activityRecord.findMany.mockResolvedValue([
      prior('December', 2023),
      prior('January'),
      prior('February'),
    ]);

    // Baseline avg = 5; the calc stub returns 19.8 → +296%.
    const prepared = await service.previewCreate(dataEntry(), {
      ...CREATE_DTO,
      reportingPeriod: 'monthly' as const,
      periodValue: 'March',
    });

    expect(prepared.verdict.anomalous).toBe(true);
    expect(prepared.verdict.priorCount).toBe(3);
    expectNothingWritten();
  });

  it('create runs the read half exactly once, and audits exactly once', async () => {
    // The complement of every assertion above: extracting the read half must
    // not have left `create` writing nothing, auditing twice — or previewing
    // twice. Nothing pinned the read half's call count before, so duplicating
    // the call inside `create` passed the whole suite; at one call per row
    // that is two extra queries per imported record, silently.
    const { prisma, calc, service } = build();
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.create.mockResolvedValue(makeRecord());

    await service.create(dataEntry(), CREATE_DTO);

    expect(prisma.periodLock.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.subsidiary.findUnique).toHaveBeenCalledTimes(1);
    expect(calc.compute).toHaveBeenCalledTimes(1);
    expect(prisma.activityRecord.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.activityRecord.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('writes the VALIDATED identities and the variance reason it was given', async () => {
    // `varianceReason` had no write-path assertion at all on create: replacing
    // it with a hardcoded null left 735 tests green. WP8 imports variance
    // reasons precisely so anomalous rows can clear the submit gate, so
    // dropping one on the way in would be silent and consequential.
    const { prisma, service } = build();
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.create.mockResolvedValue(makeRecord());

    await service.create(dataEntry(), {
      ...CREATE_DTO,
      varianceReason: 'Meter replaced mid-period',
    });

    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.subsidiaryId).toBe('sub-1');
    expect(data.locationId).toBeNull();
    expect(data.varianceReason).toBe('Meter replaced mid-period');
  });
});

