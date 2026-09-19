import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ActivityRecordStatus, type ActivityRecord } from '@tonyai/db';
import type { EvidenceLinkRefusedDTO } from '@tonyai/shared-types';
import { EvidenceService } from './evidence.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type { RequestUser } from '../auth/auth.types';
import { PeriodLockedError } from '../activity-records/errors';

import { AuditService } from '../audit/audit.service';

/**
 * Audit writes go through the shared AuditService. A single shared spy lets the
 * specs assert WHAT was audited; the row shape it stamps (actor role +
 * organisation) is covered by audit.service.spec.ts.
 */
const audit = { record: vi.fn() };
const auditMock = () => audit as unknown as AuditService;

/**
 * The transaction client has its OWN spies (the #50 rule): with `tx === prisma`
 * no assertion could tell a write inside the transaction from one outside it.
 */
function createTxMock() {
  return {
    evidence: { create: vi.fn(), findUniqueOrThrow: vi.fn() },
    activityRecordEvidence: { createMany: vi.fn() },
  };
}

function createPrismaMock(tx: ReturnType<typeof createTxMock>) {
  return {
    activityRecord: { findUnique: vi.fn(), findMany: vi.fn() },
    evidence: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    activityRecordEvidence: { findMany: vi.fn(), deleteMany: vi.fn() },
    periodLock: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
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
    calculation: { tCo2e: 10, factorId: 'f-1' } as unknown,
    createdBy: 'user-entry',
    anomalyFlag: false,
    varianceReason: null,
    locationId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ActivityRecord;
}

/** An evidence row as Prisma returns it with `WITH_LINKED_RECORDS`. */
function makeEvidence(
  records: ActivityRecord[],
  over: Record<string, unknown> = {},
) {
  return {
    id: 'ev-1',
    subsidiaryId: 'sub-1',
    storagePath: 'sub-1/a.pdf',
    fileName: 'a.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 10,
    uploadedBy: 'user-entry',
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    links: records.map((r) => ({
      activityRecord: {
        id: r.id,
        category: r.category,
        reportingYear: r.reportingYear,
        periodValue: r.periodValue,
        status: r.status,
        location: null,
      },
    })),
    ...over,
  };
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
    fullName: 'Entry User',
    role: 'data_entry',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1'],
    ...over,
  };
}

describe('EvidenceService', () => {
  let tx: ReturnType<typeof createTxMock>;
  let prisma: PrismaMock;
  let storage: ReturnType<typeof createStorageMock>;
  let service: EvidenceService;

  /** Make the transaction create a file backing `records`. */
  function stubStore(records: ActivityRecord[]) {
    tx.evidence.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'ev-new',
      ...data,
      createdAt: new Date(),
    }));
    tx.evidence.findUniqueOrThrow.mockImplementation(() => {
      const data = tx.evidence.create.mock.calls[0][0].data as Record<string, unknown>;
      return makeEvidence(records, { id: 'ev-new', ...data });
    });
  }

  beforeEach(() => {
    audit.record.mockClear();
    seq = 0;
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    storage = createStorageMock();
    service = new EvidenceService(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
      auditMock(),
    );
  });

  describe('list', () => {
    it('lists the files linked to an accessible record, each with every record it backs', async () => {
      const mine = makeRecord({ id: 'rec-1' });
      const other = makeRecord({ id: 'rec-2', periodValue: 'Q2' });
      prisma.activityRecord.findUnique.mockResolvedValue(mine);
      prisma.evidence.findMany.mockResolvedValue([makeEvidence([mine, other])]);

      const list = await service.list(dataEntry(), 'rec-1');

      expect(prisma.evidence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { links: { some: { activityRecordId: 'rec-1' } } },
        }),
      );
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty('storagePath'); // never leak the object key
      expect(list[0].subsidiaryId).toBe('sub-1');
      expect(list[0].linkedRecords.map((r) => r.id)).toEqual(['rec-1', 'rec-2']);
      expect(list[0].linkedRecords[1]).toEqual({
        id: 'rec-2',
        category: 'Electricity',
        reportingYear: 2024,
        periodValue: 'Q2',
        locationName: null,
        status: 'draft',
      });
    });

    it('treats a record outside the accessible set as not found', async () => {
      prisma.activityRecord.findUnique.mockResolvedValue(
        makeRecord({ id: 'rec-x', subsidiaryId: 'sub-999' }),
      );
      await expect(service.list(dataEntry(), 'rec-x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.evidence.findMany).not.toHaveBeenCalled();
    });
  });

  describe('upload — one record', () => {
    it('stores the object under the subsidiary, then the row and its link in one transaction, and audits', async () => {
      const record = makeRecord({ id: 'rec-1' });
      prisma.activityRecord.findUnique.mockResolvedValue(record);
      stubStore([record]);

      const dto = await service.upload(dataEntry(), 'rec-1', makeFile());

      expect(storage.upload).toHaveBeenCalledOnce();
      const [bucket, path] = storage.upload.mock.calls[0];
      expect(bucket).toBe('evidence');
      expect(path).toMatch(/^sub-1\/[0-9a-f-]{36}-invoice\.pdf$/);
      expect(tx.evidence.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ subsidiaryId: 'sub-1', storagePath: path }),
      });
      expect(tx.activityRecordEvidence.createMany).toHaveBeenCalledWith({
        data: [
          { activityRecordId: 'rec-1', evidenceId: 'ev-new', subsidiaryId: 'sub-1', linkedBy: 'user-entry' },
        ],
      });
      expect(audit.record).toHaveBeenCalledOnce();
      expect(audit.record.mock.calls[0][1]).toMatchObject({
        action: 'create',
        entity: 'evidence',
        entityId: 'ev-new',
        diff: { after: { recordIds: ['rec-1'], fileName: 'invoice.pdf' } },
      });
      expect(audit.record.mock.calls[0][1].diff.after).not.toHaveProperty('storagePath');
      expect(dto.fileName).toBe('invoice.pdf');
      expect(dto.linkedRecords.map((r) => r.id)).toEqual(['rec-1']);
    });

    it('stores the filename verbatim and keeps the object key ASCII', async () => {
      // DE-8: the DISPLAYED name must survive exactly, while the storage key stays
      // opaque ASCII. Note this spec cannot see the actual DE-8 bug — that
      // happened inside multer, before the service is called — which is why the
      // real guard is the e2e that goes through multipart.
      const record = makeRecord({ id: 'rec-1' });
      prisma.activityRecord.findUnique.mockResolvedValue(record);
      stubStore([record]);

      const name = 'Şubat-Faturası-İĞÜÖÇ.pdf';
      const dto = await service.upload(dataEntry(), 'rec-1', makeFile({ originalname: name }));

      expect(dto.fileName).toBe(name);
      const key = storage.upload.mock.calls[0][1] as string;
      expect(key).toMatch(/^sub-1\//);
      // The control range IS the assertion here: it pins that the storage key
      // is pure ASCII, which is the whole point of the sanitiser under test.
      // eslint-disable-next-line no-control-regex
      expect(key, 'the object key must not carry non-ASCII').toMatch(/^[\u0000-\u007F]*$/);
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
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('lets a super_admin upload to anyone’s editable record', async () => {
      const record = makeRecord({ id: 'rec-1', createdBy: 'someone-else' });
      prisma.activityRecord.findUnique.mockResolvedValue(record);
      stubStore([record]);
      await service.upload(dataEntry({ role: 'super_admin', id: 'admin' }), 'rec-1', makeFile());
      expect(storage.upload).toHaveBeenCalledOnce();
    });

    it('blocks evidence changes once the record is no longer editable', async () => {
      prisma.activityRecord.findUnique.mockResolvedValue(
        makeRecord({ id: 'rec-1', status: ActivityRecordStatus.approved }),
      );
      await expect(
        service.upload(dataEntry(), 'rec-1', makeFile()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('blocks evidence changes in a locked period, even on a rejected record', async () => {
      // New in WP8 PR7: before it, a rejected record stranded inside a locked
      // period could still gain or lose a file.
      const record = makeRecord({ id: 'rec-1', status: ActivityRecordStatus.rejected });
      prisma.activityRecord.findUnique.mockResolvedValue(record);
      prisma.periodLock.findMany.mockResolvedValue([
        { subsidiaryId: 'sub-1', reportingYear: 2024, reportingPeriod: 'annual', periodValue: 'Annual' },
      ]);

      await expect(service.upload(dataEntry(), 'rec-1', makeFile())).rejects.toBeInstanceOf(
        PeriodLockedError,
      );
      expect(prisma.periodLock.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [{ subsidiaryId: 'sub-1', reportingYear: 2024, reportingPeriod: 'annual', periodValue: 'Annual' }],
          },
        }),
      );
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('removes the stored object again when the rows cannot be written', async () => {
      prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-1' }));
      tx.evidence.create.mockRejectedValue(new Error('insert failed'));

      await expect(service.upload(dataEntry(), 'rec-1', makeFile())).rejects.toThrow('insert failed');

      const key = storage.upload.mock.calls[0][1] as string;
      expect(storage.remove).toHaveBeenCalledWith('evidence', [key]);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('uploadForRecords — one file, several records', () => {
    it('stores ONE object and ONE row, links every named record once, and writes one audit row', async () => {
      const a = makeRecord({ id: 'aaaaaaaa-0000-0000-0000-000000000001' });
      const b = makeRecord({ id: 'aaaaaaaa-0000-0000-0000-000000000002', periodValue: 'Q2' });
      prisma.activityRecord.findMany.mockResolvedValue([a, b]);
      stubStore([a, b]);

      const dto = await service.uploadForRecords(
        dataEntry(),
        // An uppercase spelling of `a` and a repeat of `b`: one link each.
        [a.id.toUpperCase(), b.id, b.id],
        makeFile(),
      );

      expect(prisma.activityRecord.findMany).toHaveBeenCalledWith({
        where: { id: { in: [a.id, b.id] }, subsidiaryId: { in: ['sub-1'] } },
      });
      expect(storage.upload).toHaveBeenCalledOnce();
      expect(tx.evidence.create).toHaveBeenCalledOnce();
      expect(tx.activityRecordEvidence.createMany).toHaveBeenCalledWith({
        data: [a, b].map((r) => ({
          activityRecordId: r.id,
          evidenceId: 'ev-new',
          subsidiaryId: 'sub-1',
          linkedBy: 'user-entry',
        })),
      });
      expect(audit.record).toHaveBeenCalledOnce();
      expect(audit.record.mock.calls[0][1].diff.after.recordIds).toEqual([a.id, b.id]);
      expect(dto.linkedRecords).toHaveLength(2);
    });

    it('refuses a record the caller cannot reach exactly like one that does not exist, and stores nothing', async () => {
      const mine = makeRecord({ id: 'aaaaaaaa-0000-0000-0000-000000000001' });
      // The query is scoped by the access set, so a foreign record simply is
      // not returned — the same as an id that matches nothing.
      prisma.activityRecord.findMany.mockResolvedValue([mine]);
      const foreign = 'bbbbbbbb-0000-0000-0000-000000000009';

      const error = await service
        .uploadForRecords(dataEntry(), [mine.id, foreign], makeFile())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as EvidenceLinkRefusedDTO;
      expect(body.refused).toEqual([{ recordId: foreign, reason: 'Activity record not found' }]);
      expect(body.message).toMatch(/^1 of the 2 records cannot take this file, so nothing was uploaded/);
      expect(storage.upload).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses records of more than one subsidiary as a whole', async () => {
      prisma.activityRecord.findMany.mockResolvedValue([
        makeRecord({ id: 'aaaaaaaa-0000-0000-0000-000000000001', subsidiaryId: 'sub-1' }),
        makeRecord({ id: 'aaaaaaaa-0000-0000-0000-000000000002', subsidiaryId: 'sub-2' }),
      ]);
      await expect(
        service.uploadForRecords(
          dataEntry({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] }),
          ['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002'],
          makeFile(),
        ),
      ).rejects.toThrow(/more than one subsidiary/);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('is all or nothing: every refused record is named, with its own reason', async () => {
      const ok = makeRecord({ id: 'aaaaaaaa-0000-0000-0000-000000000001' });
      const approved = makeRecord({
        id: 'aaaaaaaa-0000-0000-0000-000000000002',
        status: ActivityRecordStatus.approved,
        category: 'Natural Gas',
        periodValue: 'March',
      });
      const colleague = makeRecord({ id: 'aaaaaaaa-0000-0000-0000-000000000003', createdBy: 'someone-else' });
      const locked = makeRecord({
        id: 'aaaaaaaa-0000-0000-0000-000000000004',
        reportingPeriod: 'quarterly',
        periodValue: 'Q1',
      });
      prisma.activityRecord.findMany.mockResolvedValue([ok, approved, colleague, locked]);
      prisma.periodLock.findMany.mockResolvedValue([
        { subsidiaryId: 'sub-1', reportingYear: 2024, reportingPeriod: 'quarterly', periodValue: 'Q1' },
      ]);

      const error = await service
        .uploadForRecords(dataEntry(), [ok, approved, colleague, locked].map((r) => r.id), makeFile())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as EvidenceLinkRefusedDTO;
      expect(body.refused.map((r) => r.recordId)).toEqual([approved.id, colleague.id, locked.id]);
      expect(body.refused[0].reason).toMatch(/status "approved"/);
      expect(body.refused[1].reason).toMatch(/records you created/);
      expect(body.refused[2].reason).toMatch(/Q1 2024 is locked/);
      expect(body.message).toContain('Natural Gas · March 2024 — Cannot modify evidence');
      expect(storage.upload).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each(['consultant', 'executive_viewer'] as const)(
      'refuses a %s before reading any record',
      async (role) => {
        await expect(
          service.uploadForRecords(dataEntry({ role }), ['aaaaaaaa-0000-0000-0000-000000000001'], makeFile()),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
        expect(storage.upload).not.toHaveBeenCalled();
      },
    );

    it('checks the file only after every record passed, and stores nothing when it fails', async () => {
      prisma.activityRecord.findMany.mockResolvedValue([
        makeRecord({ id: 'aaaaaaaa-0000-0000-0000-000000000001' }),
      ]);
      await expect(
        service.uploadForRecords(
          dataEntry(),
          ['aaaaaaaa-0000-0000-0000-000000000001'],
          makeFile({ mimetype: 'application/x-msdownload' }),
        ),
      ).rejects.toThrow(/Unsupported file type/);
      expect(storage.upload).not.toHaveBeenCalled();
    });
  });

  it.each(['consultant', 'executive_viewer'] as const)(
    'refuses a %s even on a record they authored — upload, detach and remove',
    async (role) => {
      // The role gate on its own: the record is theirs and editable, so only
      // `mayAuthorRecords` stands between this seat and the evidence vault.
      const author = dataEntry({ role, id: 'user-seat' });
      const record = makeRecord({ id: 'rec-1', createdBy: 'user-seat' });
      prisma.activityRecord.findUnique.mockResolvedValue(record);
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([record]));

      await expect(service.upload(author, 'rec-1', makeFile())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.detach(author, 'rec-1', 'ev-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.remove(author, 'ev-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(storage.upload).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
      expect(prisma.activityRecordEvidence.deleteMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  describe('detach — a file off one record', () => {
    it('keeps a file that still backs another record, even an approved one, and audits a detach', async () => {
      // Only the record it is taken off has to be editable: the approved
      // record keeps its file, which is the point of detaching rather than
      // deleting.
      const mine = makeRecord({ id: 'rec-1' });
      const approved = makeRecord({ id: 'rec-2', status: ActivityRecordStatus.approved });
      prisma.activityRecord.findUnique.mockResolvedValue(mine);
      prisma.evidence.findFirst.mockResolvedValue(makeEvidence([mine, approved]));
      prisma.evidence.findMany.mockResolvedValue([]); // still linked — not a candidate

      const res = await service.detach(dataEntry(), 'rec-1', 'ev-1');

      expect(prisma.evidence.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ev-1', links: { some: { activityRecordId: 'rec-1' } } },
        }),
      );
      expect(prisma.activityRecordEvidence.deleteMany).toHaveBeenCalledWith({
        where: { activityRecordId: 'rec-1', evidenceId: 'ev-1' },
      });
      expect(prisma.evidence.deleteMany).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
      expect(res).toEqual({ evidenceId: 'ev-1', recordId: 'rec-1', fileDeleted: false });
      expect(audit.record.mock.calls[0][1]).toMatchObject({
        action: 'detach',
        entity: 'evidence',
        entityId: 'ev-1',
        diff: { before: { recordId: 'rec-1', recordIds: ['rec-1', 'rec-2'] } },
      });
    });

    it('deletes the file, row then object, when that was its last record, and audits a delete', async () => {
      const mine = makeRecord({ id: 'rec-1' });
      prisma.activityRecord.findUnique.mockResolvedValue(mine);
      prisma.evidence.findFirst.mockResolvedValue(makeEvidence([mine]));
      prisma.evidence.findMany.mockResolvedValue([{ id: 'ev-1', storagePath: 'sub-1/a.pdf' }]);
      prisma.evidence.deleteMany.mockResolvedValue({ count: 1 });

      const res = await service.detach(dataEntry(), 'rec-1', 'ev-1');

      expect(prisma.evidence.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['ev-1'] }, links: { none: {} } },
        select: { id: true, storagePath: true },
      });
      // Conditional: only a row that is STILL unlinked is deleted.
      expect(prisma.evidence.deleteMany).toHaveBeenCalledWith({
        where: { id: 'ev-1', links: { none: {} } },
      });
      expect(storage.remove).toHaveBeenCalledWith('evidence', ['sub-1/a.pdf']);
      expect(prisma.evidence.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
        storage.remove.mock.invocationCallOrder[0],
      );
      expect(res.fileDeleted).toBe(true);
      expect(audit.record.mock.calls[0][1]).toMatchObject({ action: 'delete', entityId: 'ev-1' });
    });

    it('refuses on the record it is taken off: not the author, not editable, period locked', async () => {
      const cases: [Partial<ActivityRecord>, unknown][] = [
        [{ createdBy: 'someone-else' }, ForbiddenException],
        [{ status: ActivityRecordStatus.submitted }, BadRequestException],
        [{ status: ActivityRecordStatus.rejected }, PeriodLockedError],
      ];
      for (const [over, expected] of cases) {
        prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-1', ...over }));
        prisma.periodLock.findMany.mockResolvedValue(
          expected === PeriodLockedError
            ? [{ subsidiaryId: 'sub-1', reportingYear: 2024, reportingPeriod: 'annual', periodValue: 'Annual' }]
            : [],
        );
        await expect(service.detach(dataEntry(), 'rec-1', 'ev-1')).rejects.toBeInstanceOf(
          expected as never,
        );
      }
      expect(prisma.activityRecordEvidence.deleteMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('is a 404 for a file not linked to that record, and for a record out of reach', async () => {
      prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-1' }));
      prisma.evidence.findFirst.mockResolvedValue(null);
      await expect(service.detach(dataEntry(), 'rec-1', 'ev-other')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      prisma.activityRecord.findUnique.mockResolvedValue(
        makeRecord({ id: 'rec-x', subsidiaryId: 'sub-999' }),
      );
      await expect(service.detach(dataEntry(), 'rec-x', 'ev-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.activityRecordEvidence.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('remove — the file from every record', () => {
    it('deletes a file backing one editable record: object first, then the row, then audits', async () => {
      const record = makeRecord({ id: 'rec-1' });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([record]));
      prisma.activityRecord.findMany.mockResolvedValue([record]);

      const res = await service.remove(dataEntry(), 'ev-1');

      expect(storage.remove).toHaveBeenCalledWith('evidence', ['sub-1/a.pdf']);
      expect(prisma.evidence.delete).toHaveBeenCalledWith({ where: { id: 'ev-1' } });
      expect(storage.remove.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.evidence.delete.mock.invocationCallOrder[0],
      );
      expect(res).toEqual({ id: 'ev-1', deleted: true });
      expect(audit.record.mock.calls[0][1]).toMatchObject({
        action: 'delete',
        diff: { before: { recordIds: ['rec-1'] } },
      });
    });

    it('keeps the single-record refusals for a file backing one record', async () => {
      const record = makeRecord({ id: 'rec-1', status: ActivityRecordStatus.approved });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([record]));
      prisma.activityRecord.findMany.mockResolvedValue([record]);
      await expect(service.remove(dataEntry(), 'ev-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.remove).not.toHaveBeenCalled();
    });

    it('refuses to delete a SHARED file while any record it backs can no longer change', async () => {
      // The hole this closes: without it, removing the file from a draft's
      // vault would take it off an approved record too.
      const draft = makeRecord({ id: 'rec-1' });
      const approved = makeRecord({ id: 'rec-2', status: ActivityRecordStatus.approved, periodValue: 'Q3' });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([draft, approved]));
      prisma.activityRecord.findMany.mockResolvedValue([draft, approved]);

      const error = await service.remove(dataEntry(), 'ev-1').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toContain('Electricity · Q3 2024');
      expect((error as Error).message).toContain('Remove it from each editable record instead');
      expect(storage.remove).not.toHaveBeenCalled();
      expect(prisma.evidence.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('deletes a shared file when every record it backs is editable by the caller', async () => {
      const a = makeRecord({ id: 'rec-1' });
      const b = makeRecord({ id: 'rec-2', status: ActivityRecordStatus.rejected });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([a, b]));
      prisma.activityRecord.findMany.mockResolvedValue([a, b]);
      await service.remove(dataEntry(), 'ev-1');
      expect(prisma.evidence.delete).toHaveBeenCalledOnce();
    });

    it('treats a file of a subsidiary out of reach as not found', async () => {
      prisma.evidence.findUnique.mockResolvedValue(
        makeEvidence([], { subsidiaryId: 'sub-999' }),
      );
      await expect(service.remove(dataEntry(), 'ev-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.remove).not.toHaveBeenCalled();
    });
  });

  describe('deleteUnlinked — after links went', () => {
    it('does nothing for no ids', async () => {
      expect(await service.deleteUnlinked([])).toEqual([]);
      expect(prisma.evidence.findMany).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
    });

    it('removes the object only for the row THIS call deleted — a concurrent winner keeps its own', async () => {
      prisma.evidence.findMany.mockResolvedValue([
        { id: 'ev-1', storagePath: 'sub-1/a.pdf' },
        { id: 'ev-2', storagePath: 'sub-1/b.pdf' },
      ]);
      prisma.evidence.deleteMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 }); // another caller got ev-2 first

      expect(await service.deleteUnlinked(['ev-1', 'ev-2', 'ev-3'])).toEqual(['ev-1']);
      expect(storage.remove).toHaveBeenCalledWith('evidence', ['sub-1/a.pdf']);
    });

    it('logs a storage failure instead of throwing — the rows are already gone', async () => {
      prisma.evidence.findMany.mockResolvedValue([{ id: 'ev-1', storagePath: 'sub-1/a.pdf' }]);
      prisma.evidence.deleteMany.mockResolvedValue({ count: 1 });
      storage.remove.mockRejectedValue(new Error('storage down'));
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(service.deleteUnlinked(['ev-1'])).resolves.toEqual(['ev-1']);
      // The object key is in the line, so whoever reads it can reclaim it.
      expect(logged.mock.calls[0][0]).toContain('sub-1/a.pdf');
      logged.mockRestore();
    });
  });

  it('fileIdsFor lists the files a record holds, for the caller about to delete it', async () => {
    prisma.activityRecordEvidence.findMany.mockResolvedValue([
      { evidenceId: 'ev-1' },
      { evidenceId: 'ev-2' },
    ]);
    expect(await service.fileIdsFor('rec-1')).toEqual(['ev-1', 'ev-2']);
    expect(prisma.activityRecordEvidence.findMany).toHaveBeenCalledWith({
      where: { activityRecordId: 'rec-1' },
      select: { evidenceId: true },
    });
  });

  describe('signedUrl', () => {
    it('returns a signed URL for a file of an accessible subsidiary', async () => {
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([makeRecord({ id: 'rec-1' })]));

      const { url, expiresIn } = await service.signedUrl(dataEntry(), 'ev-1');
      expect(url).toContain('https://');
      expect(expiresIn).toBeGreaterThan(0);
      // The user's real filename rides along so the browser saves under it rather
      // than under the sanitised, uuid-prefixed object key (DE-8).
      expect(storage.createSignedUrl).toHaveBeenCalledWith(
        'evidence',
        'sub-1/a.pdf',
        expiresIn,
        'a.pdf',
      );
    });

    it('is a 404 for a file of a subsidiary out of reach, the same as a missing one', async () => {
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([], { subsidiaryId: 'sub-999' }));
      await expect(service.signedUrl(dataEntry(), 'ev-1')).rejects.toBeInstanceOf(NotFoundException);
      prisma.evidence.findUnique.mockResolvedValue(null);
      await expect(service.signedUrl(dataEntry(), 'ev-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.createSignedUrl).not.toHaveBeenCalled();
    });
  });
});
