import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ActivityRecordStatus, type ActivityRecord, type Subsidiary } from '@tonyai/db';
import type { CalculationResult } from '@tonyai/shared-types';
import { ActivityRecordsService } from './activity-records.service';
import { PrismaService } from '../prisma/prisma.service';
import { CalculationsService } from '../calculations/calculations.service';
import type { RequestUser } from '../auth/auth.types';

// --- Local, DB-free mocks --------------------------------------------------

function createPrismaMock() {
  return {
    activityRecord: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    subsidiary: {
      findUnique: vi.fn(),
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
