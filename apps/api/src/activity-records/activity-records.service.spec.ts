import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ActivityRecordStatus, Prisma, type ActivityRecord, type Subsidiary } from '@tonyai/db';
import type { CalculationResult } from '@tonyai/shared-types';
import { ActivityRecordsService } from './activity-records.service';
import { PrismaService } from '../prisma/prisma.service';
import { CalculationsService } from '../calculations/calculations.service';
import type { RequestUser } from '../auth/auth.types';

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
    calculation: { tCo2e: 19.8 } as unknown,
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

function build(scope = 2) {
  const prisma = createPrismaMock();
  const calc = createCalcMock(scope);
  const service = new ActivityRecordsService(
    prisma as unknown as PrismaService,
    calc as unknown as CalculationsService,
  );
  return { prisma, calc, service };
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
    expect(calc.compute).toHaveBeenCalledWith({
      category: 'Electricity',
      geographyCode: 'TR',
      reportingYear: 2024,
      value: 45000,
      unit: 'kWh',
    });
    // Snapshot + derived scope persisted on the row.
    const createArg = prisma.activityRecord.create.mock.calls[0][0];
    expect(createArg.data.scope).toBe(2); // Electricity -> Scope 2
    expect(createArg.data.calculation).toEqual(calc.snapshot);
    expect(createArg.data.status).toBe(ActivityRecordStatus.draft);
    expect(createArg.data.createdBy).toBe('user-entry');
    expect(dto.calculation.tCo2e).toBeCloseTo(19.8, 6);
    // Audit written.
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'create',
          entity: 'activity_record',
        }),
      }),
    );
  });

  it('resolves the factor geography from the LOCATION when a locationId is given (FR §5.2)', async () => {
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

  it('consultant can approve a submitted record (writes audit)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-a', status: ActivityRecordStatus.submitted }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-a', status: data.status }),
    );

    const dto = await service.approve(consultant(), 'rec-a');
    expect(dto.status).toBe(ActivityRecordStatus.approved);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'update',
          entity: 'activity_record',
        }),
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
    expect(prisma.auditLog.create).toHaveBeenCalled();
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
    await expect(service.approve(consultant(), 'rec-1')).rejects.toBeInstanceOf(
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
    expect(prisma.auditLog.create).toHaveBeenCalled();
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

  it('reject moves submitted -> rejected and stores the varianceReason', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-r', status: ActivityRecordStatus.submitted }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-r', status: data.status, varianceReason: data.varianceReason }),
    );

    const dto = await service.reject(consultant(), 'rec-r', 'invoice mismatch');
    expect(dto.status).toBe(ActivityRecordStatus.rejected);
    expect(dto.varianceReason).toBe('invoice mismatch');
    const updateArg = prisma.activityRecord.update.mock.calls[0][0];
    expect(updateArg.data.varianceReason).toBe('invoice mismatch');
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
      calculation: { tCo2e },
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
      makeRecord({ reportingPeriod: 'quarterly', periodValue: 'Q1', status: ActivityRecordStatus.approved, calculation: { tCo2e: 10 } }),
      makeRecord({ reportingPeriod: 'quarterly', periodValue: 'Q2', status: ActivityRecordStatus.approved, calculation: { tCo2e: 10 } }),
      makeRecord({ reportingPeriod: 'quarterly', periodValue: 'Q4', status: ActivityRecordStatus.approved, calculation: { tCo2e: 19 } }), // later → excluded
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
      calculation: { tCo2e: 19.8 },
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
