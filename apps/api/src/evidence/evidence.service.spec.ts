import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ActivityRecordStatus, type ActivityRecord } from '@tonyai/db';
import { EvidenceService } from './evidence.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type { RequestUser } from '../auth/auth.types';

function createPrismaMock() {
  return {
    activityRecord: { findUnique: vi.fn() },
    evidence: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  };
}
type PrismaMock = ReturnType<typeof createPrismaMock>;

function createStorageMock() {
  return {
    upload: vi.fn().mockResolvedValue(undefined),
    createSignedUrl: vi.fn().mockResolvedValue('https://signed.example/x'),
    remove: vi.fn().mockResolvedValue(undefined),
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

function makeFile(over: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'invoice.pdf',
    encoding: '7bit',
    mimetype: 'application/pdf',
    size: 1024,
    buffer: Buffer.from('demo'),
    stream: undefined as never,
    destination: '',
    filename: '',
    path: '',
    ...over,
  };
}

function dataEntry(over: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-entry',
    email: 'entry@tonyai.local',
    role: 'data_entry',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1'],
    ...over,
  };
}

describe('EvidenceService', () => {
  let prisma: PrismaMock;
  let storage: ReturnType<typeof createStorageMock>;
  let service: EvidenceService;

  beforeEach(() => {
    seq = 0;
    prisma = createPrismaMock();
    storage = createStorageMock();
    service = new EvidenceService(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
    );
  });

  it('lists evidence for an accessible record', async () => {
    prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-1' }));
    prisma.evidence.findMany.mockResolvedValue([
      { id: 'ev-1', activityRecordId: 'rec-1', storagePath: 'rec-1/a.pdf', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10, uploadedBy: 'user-entry', createdAt: new Date() },
    ]);
    const list = await service.list(dataEntry(), 'rec-1');
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('storagePath'); // never leak the object key
  });

  it('treats a record outside the accessible set as not found', async () => {
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-x', subsidiaryId: 'sub-999' }),
    );
    await expect(service.list(dataEntry(), 'rec-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('uploads a valid file: stores the object + writes the row + audits', async () => {
    prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-1' }));
    prisma.evidence.create.mockImplementation(({ data }: any) => ({
      id: 'ev-new',
      ...data,
      createdAt: new Date(),
    }));

    const dto = await service.upload(dataEntry(), 'rec-1', makeFile());

    expect(storage.upload).toHaveBeenCalledOnce();
    const [bucket, path] = storage.upload.mock.calls[0];
    expect(bucket).toBe('evidence');
    expect(path).toMatch(/^rec-1\//);
    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(dto.fileName).toBe('invoice.pdf');
  });

  it('rejects an unsupported file type before touching storage', async () => {
    prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-1' }));
    await expect(
      service.upload(dataEntry(), 'rec-1', makeFile({ mimetype: 'application/x-msdownload', originalname: 'x.exe' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('rejects a file over the size limit', async () => {
    prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-1' }));
    await expect(
      service.upload(dataEntry(), 'rec-1', makeFile({ size: 11 * 1024 * 1024 })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('forbids uploading to a record the caller did not create', async () => {
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-1', createdBy: 'someone-else' }),
    );
    await expect(
      service.upload(dataEntry(), 'rec-1', makeFile()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks evidence changes once the record is no longer editable', async () => {
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-1', status: ActivityRecordStatus.approved }),
    );
    await expect(
      service.upload(dataEntry(), 'rec-1', makeFile()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removes an evidence file from storage and the DB', async () => {
    prisma.evidence.findUnique.mockResolvedValue({
      id: 'ev-1', activityRecordId: 'rec-1', storagePath: 'rec-1/a.pdf', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10, uploadedBy: 'user-entry', createdAt: new Date(),
    });
    prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-1' }));

    const res = await service.remove(dataEntry(), 'ev-1');
    expect(storage.remove).toHaveBeenCalledWith('evidence', ['rec-1/a.pdf']);
    expect(prisma.evidence.delete).toHaveBeenCalledWith({ where: { id: 'ev-1' } });
    expect(res).toEqual({ id: 'ev-1', deleted: true });
  });

  it('returns a signed URL for an accessible evidence file', async () => {
    prisma.evidence.findUnique.mockResolvedValue({
      id: 'ev-1', activityRecordId: 'rec-1', storagePath: 'rec-1/a.pdf', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10, uploadedBy: 'user-entry', createdAt: new Date(),
    });
    prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-1' }));

    const { url, expiresIn } = await service.signedUrl(dataEntry(), 'ev-1');
    expect(url).toContain('https://');
    expect(expiresIn).toBeGreaterThan(0);
    expect(storage.createSignedUrl).toHaveBeenCalledWith('evidence', 'rec-1/a.pdf', expiresIn);
  });
});
