import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ActivityRecordStatus, Prisma, type ActivityRecord } from '@tonyai/db';
import type { EvidenceLinkRefusedDTO } from '@tonyai/shared-types';
import { EvidenceService } from './evidence.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageObjectMissingError, StorageService } from '../storage/storage.service';
import type { StorageIntentsService } from '../storage/storage-intents.service';
import type { RequestUser } from '../auth/auth.types';
import { PeriodLockedError, RecordChangedError } from '../activity-records/errors';

import { AuditService } from '../audit/audit.service';

/**
 * Audit writes go through the shared AuditService. A single shared spy lets the
 * specs assert WHAT was audited; the row shape it stamps (actor role +
 * organisation) is covered by audit.service.spec.ts.
 */
const audit = { record: vi.fn() };
const auditMock = () => audit as unknown as AuditService;

/**
 * Every write runs in one interactive transaction (the lifecycle protocol,
 * `lifecycle-lock.ts`). Its client shares the root mock's spies — so "the
 * link was not deleted" asserts against the one spy a delete would really
 * hit, inside the transaction or out — but is a different OBJECT, so a spec
 * can tell which client the audit row was written through:
 * `audit.record(..., tx)` fails if the service audits on its root client,
 * outside the write.
 */
function createPrismaMock() {
  const client = {
    // Row locks (`FOR UPDATE`) read back every id they were given: all there.
    $queryRaw: vi.fn(async (_sql: unknown, ids: string[]) => ids.map((id) => ({ id }))),
    // The period's advisory lock.
    $executeRaw: vi.fn().mockResolvedValue(1),
    activityRecord: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn() },
    evidence: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    activityRecordEvidence: {
      createMany: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    periodLock: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const tx = { ...client };
  return {
    ...client,
    tx,
    $transaction: vi.fn(async (fn: (c: typeof tx) => unknown) => fn(tx)),
  };
}
type PrismaMock = ReturnType<typeof createPrismaMock>;
type TxMock = PrismaMock['tx'];

function createStorageMock() {
  return {
    upload: vi.fn().mockResolvedValue(undefined),
    createSignedUrl: vi.fn().mockResolvedValue('https://signed.example/x'),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * The Storage protocol (`StorageIntentsService`) is exercised against real
 * PostgreSQL and Storage in `test/int/storage-recovery.int.spec.ts`; here it
 * is a set of spies, so a spec asserts WHICH step the service asked for and
 * when — the intent before the bytes, its adoption inside the transaction,
 * the abandonment on failure, the delete intent with the row.
 */
function createIntentsMock() {
  return {
    beginUpload: vi.fn().mockResolvedValue('intent-1'),
    adoptUpload: vi.fn().mockResolvedValue(undefined),
    abandonUpload: vi.fn().mockResolvedValue(undefined),
    enqueueDeletes: vi.fn().mockResolvedValue(undefined),
    runNow: vi.fn().mockResolvedValue(undefined),
  };
}

/** What `deleteUnlinkedRows` selects beside the id and the key: the file's tenant, for its delete intent. */
const UNLINKED_OWNER = { subsidiaryId: 'sub-1', subsidiary: { organisationId: 'org-1' } };

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
    buffer: Buffer.from('%PDF-1.4 demo'),
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
  let tx: TxMock;
  let prisma: PrismaMock;
  let storage: ReturnType<typeof createStorageMock>;
  let intents: ReturnType<typeof createIntentsMock>;
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
    prisma = createPrismaMock();
    tx = prisma.tx;
    // Unless a test races them, the locked re-reads see what the caller's own
    // read saw: a record read alone answers the by-id re-read, and a file read
    // with `findFirst` answers the lookup under its lock.
    const one = <T>(fn: { getMockImplementation(): ((...a: never[]) => T) | undefined }) =>
      fn.getMockImplementation()?.();
    prisma.activityRecord.findMany.mockImplementation(async () => {
      const record = await one(prisma.activityRecord.findUnique);
      return record ? [record] : [];
    });
    prisma.activityRecord.findUniqueOrThrow.mockImplementation(async () =>
      one(prisma.activityRecord.findUnique),
    );
    prisma.evidence.findUnique.mockImplementation(async () => one(prisma.evidence.findFirst));
    prisma.evidence.findUniqueOrThrow.mockImplementation(async () =>
      one(prisma.evidence.findUnique),
    );
    storage = createStorageMock();
    intents = createIntentsMock();
    service = new EvidenceService(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
      auditMock(),
      intents as unknown as StorageIntentsService,
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

    it('names the site of each linked record — what a reviewer judges one invoice against', async () => {
      const mine = makeRecord({ id: 'rec-1' });
      prisma.activityRecord.findUnique.mockResolvedValue(mine);
      const file = makeEvidence([mine]);
      file.links[0].activityRecord.location = { name: 'Izmir Plant' } as never;
      prisma.evidence.findMany.mockResolvedValue([file]);
      const [dto] = await service.list(dataEntry(), 'rec-1');
      expect(dto.linkedRecords[0].locationName).toBe('Izmir Plant');
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

    it('is a 404 for a record out of reach — for a super_admin too — before any storage', async () => {
      prisma.activityRecord.findUnique.mockResolvedValue(
        makeRecord({ id: 'rec-x', subsidiaryId: 'sub-999' }),
      );
      await expect(
        service.upload(dataEntry({ role: 'super_admin', id: 'admin' }), 'rec-x', makeFile()),
      ).rejects.toBeInstanceOf(NotFoundException);
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

    it('answers 404, not 500, when the record was deleted before its link was written', async () => {
      // A record delete racing the upload: the link's foreign key refuses it.
      prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-1' }));
      tx.activityRecordEvidence.createMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
          code: 'P2003',
          clientVersion: 'test',
        }),
      );
      tx.evidence.create.mockResolvedValue({ id: 'ev-new' });

      await expect(service.upload(dataEntry(), 'rec-1', makeFile())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const key = storage.upload.mock.calls[0][1] as string;
      expect(intents.abandonUpload).toHaveBeenCalledWith('intent-1', { bucket: 'evidence', path: key }, expect.anything());
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('audits the new file through the transaction that writes it', async () => {
      const record = makeRecord({ id: 'rec-1' });
      prisma.activityRecord.findUnique.mockResolvedValue(record);
      stubStore([record]);

      await service.upload(dataEntry(), 'rec-1', makeFile());

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0][2]).toBe(tx);
    });

    it('re-checks the record under its lock: submitted while the file uploaded → lost race, nothing kept', async () => {
      const record = makeRecord({ id: 'rec-1' });
      prisma.activityRecord.findUnique.mockResolvedValue(record);
      prisma.activityRecord.findMany.mockResolvedValue([
        { ...record, status: ActivityRecordStatus.submitted },
      ]);
      stubStore([record]);

      await expect(service.upload(dataEntry(), 'rec-1', makeFile())).rejects.toBeInstanceOf(
        RecordChangedError,
      );
      expect(tx.evidence.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      // The object stored before the transaction is removed again.
      expect(intents.abandonUpload).toHaveBeenCalledWith(
        'intent-1',
        { bucket: 'evidence', path: storage.upload.mock.calls[0][1] },
        expect.anything(),
      );
    });

    it('answers a lost race when the record moved to another period while the file uploaded', async () => {
      const record = makeRecord({ id: 'rec-1' });
      prisma.activityRecord.findUnique.mockResolvedValue(record);
      prisma.activityRecord.findMany.mockResolvedValue([{ ...record, periodValue: 'Q4' }]);
      stubStore([record]);

      await expect(service.upload(dataEntry(), 'rec-1', makeFile())).rejects.toBeInstanceOf(
        RecordChangedError,
      );
      expect(tx.evidence.create).not.toHaveBeenCalled();
      expect(intents.abandonUpload).toHaveBeenCalledWith(
        'intent-1',
        { bucket: 'evidence', path: storage.upload.mock.calls[0][1] },
        expect.anything(),
      );
    });

    it('names the object in an intent before the bytes go up, and adopts it inside the transaction', async () => {
      const record = makeRecord({ id: 'rec-1' });
      prisma.activityRecord.findUnique.mockResolvedValue(record);
      stubStore([record]);

      await service.upload(dataEntry(), 'rec-1', makeFile());

      const path = storage.upload.mock.calls[0][1] as string;
      expect(intents.beginUpload).toHaveBeenCalledWith(
        { bucket: 'evidence', path },
        { reason: 'evidence.upload', subsidiaryId: 'sub-1', organisationId: 'org-1' },
      );
      expect(intents.beginUpload.mock.invocationCallOrder[0]).toBeLessThan(
        storage.upload.mock.invocationCallOrder[0],
      );
      // Adopted through the transaction that writes the row — never outside it.
      expect(intents.adoptUpload).toHaveBeenCalledWith(tx, 'intent-1');
      expect(intents.adoptUpload.mock.invocationCallOrder[0]).toBeLessThan(
        tx.evidence.create.mock.invocationCallOrder[0],
      );
      expect(intents.abandonUpload).not.toHaveBeenCalled();
    });

    it('stores the checked type, the content hash and a cleaned name', async () => {
      const record = makeRecord({ id: 'rec-1' });
      prisma.activityRecord.findUnique.mockResolvedValue(record);
      stubStore([record]);
      // U+202E (right-to-left override) would make the name read as another type.
      const rlo = String.fromCharCode(0x202e);

      await service.upload(dataEntry(), 'rec-1', makeFile({ originalname: `invoice${rlo}fdp.pdf` }));

      expect(tx.evidence.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fileName: 'invoicefdp.pdf',
          mimeType: 'application/pdf',
          // sha256 of "%PDF-1.4 demo"
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      });
      expect(audit.record.mock.calls[0][1].diff.after.sha256).toBe(
        tx.evidence.create.mock.calls[0][0].data.sha256,
      );
    });

    it('refuses a file whose bytes are not the type it claims, before any intent or upload', async () => {
      prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-1' }));
      await expect(
        service.upload(dataEntry(), 'rec-1', makeFile({ buffer: Buffer.from('<html><script>') })),
      ).rejects.toThrow(/not a PDF file/);
      expect(intents.beginUpload).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('abandons the intent when the bytes cannot be stored, and writes no row', async () => {
      prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-1' }));
      storage.upload.mockRejectedValue(new Error('storage down'));

      await expect(service.upload(dataEntry(), 'rec-1', makeFile())).rejects.toThrow('storage down');
      expect(intents.abandonUpload).toHaveBeenCalledWith(
        'intent-1',
        { bucket: 'evidence', path: storage.upload.mock.calls[0][1] },
        expect.anything(),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('stores nothing when the intent cannot be written', async () => {
      prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-1' }));
      intents.beginUpload.mockRejectedValue(new Error('db down'));

      await expect(service.upload(dataEntry(), 'rec-1', makeFile())).rejects.toThrow('db down');
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('removes the stored object again when the rows cannot be written', async () => {
      prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-1' }));
      tx.evidence.create.mockRejectedValue(new Error('insert failed'));

      await expect(service.upload(dataEntry(), 'rec-1', makeFile())).rejects.toThrow('insert failed');

      const key = storage.upload.mock.calls[0][1] as string;
      expect(intents.abandonUpload).toHaveBeenCalledWith('intent-1', { bucket: 'evidence', path: key }, expect.anything());
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

    it('asks for each distinct period once, however many records share it', async () => {
      const q1a = makeRecord({ id: 'aaaaaaaa-0000-0000-0000-000000000001', reportingPeriod: 'quarterly', periodValue: 'Q1' });
      const q1b = makeRecord({ id: 'aaaaaaaa-0000-0000-0000-000000000002', reportingPeriod: 'quarterly', periodValue: 'Q1', category: 'Fuel' });
      const q2 = makeRecord({ id: 'aaaaaaaa-0000-0000-0000-000000000003', reportingPeriod: 'quarterly', periodValue: 'Q2' });
      prisma.activityRecord.findMany.mockResolvedValue([q1a, q1b, q2]);
      prisma.periodLock.findMany.mockResolvedValue([
        { subsidiaryId: 'sub-1', reportingYear: 2024, reportingPeriod: 'quarterly', periodValue: 'Q1' },
      ]);

      const error = await service
        .uploadForRecords(dataEntry(), [q1a.id, q1b.id, q2.id], makeFile())
        .catch((e: unknown) => e);

      expect(prisma.periodLock.findMany.mock.calls[0][0].where.OR).toHaveLength(2);
      // Both records of the locked period are refused, not just the first.
      const body = (error as BadRequestException).getResponse() as EvidenceLinkRefusedDTO;
      expect(body.refused.map((r) => r.recordId)).toEqual([q1a.id, q1b.id]);
    });

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
      expect(intents.runNow).not.toHaveBeenCalled();
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
      expect(intents.runNow).not.toHaveBeenCalled();
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
      prisma.evidence.findMany.mockResolvedValue([{ id: 'ev-1', storagePath: 'sub-1/a.pdf', ...UNLINKED_OWNER }]);
      prisma.evidence.deleteMany.mockResolvedValue({ count: 1 });

      const res = await service.detach(dataEntry(), 'rec-1', 'ev-1');

      // Read under the file's lock, so "no links left" is final.
      expect(prisma.evidence.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['ev-1'] }, links: { none: {} } },
        select: { id: true, storagePath: true, subsidiaryId: true, subsidiary: { select: { organisationId: true } } },
      });
      expect(prisma.evidence.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['ev-1'] } },
      });
      expect(intents.runNow).toHaveBeenCalledWith([{ bucket: 'evidence', path: 'sub-1/a.pdf' }]);
      expect(res.fileDeleted).toBe(true);
      expect(audit.record.mock.calls[0][1]).toMatchObject({ action: 'delete', entityId: 'ev-1' });
      // The link, the row and the audit row in one transaction; the object
      // only after it committed.
      expect(audit.record.mock.calls[0][2]).toBe(tx);
      const order = (fn: { mock: { invocationCallOrder: number[] } }, call = 0) =>
        fn.mock.invocationCallOrder[call];
      expect(order(prisma.activityRecordEvidence.deleteMany)).toBeLessThan(
        order(prisma.evidence.deleteMany),
      );
      expect(order(prisma.evidence.deleteMany)).toBeLessThan(order(audit.record));
      expect(order(audit.record)).toBeLessThan(order(intents.runNow));
    });

    it('takes the record lock before the file lock, and both before the link goes (the protocol\'s order)', async () => {
      const mine = makeRecord({ id: 'rec-1' });
      prisma.activityRecord.findUnique.mockResolvedValue(mine);
      prisma.evidence.findFirst.mockResolvedValue(makeEvidence([mine]));

      await service.detach(dataEntry(), 'rec-1', 'ev-1');

      const locks = prisma.$queryRaw.mock.calls.map((c) => (c[0] as unknown as string[]).join('?'));
      expect(locks[0]).toMatch(/"activity_records"[\s\S]*FOR UPDATE/);
      expect(locks[1]).toMatch(/"evidence"[\s\S]*FOR UPDATE/);
      expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.$queryRaw.mock.invocationCallOrder[0],
      );
      expect(prisma.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
        prisma.activityRecordEvidence.deleteMany.mock.invocationCallOrder[0],
      );
    });

    it('answers a lost race when the record was submitted while it waited for the lock', async () => {
      const mine = makeRecord({ id: 'rec-1' });
      prisma.activityRecord.findUnique.mockResolvedValue(mine);
      prisma.activityRecord.findUniqueOrThrow.mockResolvedValue({
        ...mine,
        status: ActivityRecordStatus.submitted,
      });
      prisma.evidence.findFirst.mockResolvedValue(makeEvidence([mine]));

      await expect(service.detach(dataEntry(), 'rec-1', 'ev-1')).rejects.toBeInstanceOf(
        RecordChangedError,
      );
      expect(prisma.activityRecordEvidence.deleteMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(intents.runNow).not.toHaveBeenCalled();
    });

    it('removes no object when the audit fails — the detach rolled back', async () => {
      const mine = makeRecord({ id: 'rec-1' });
      prisma.activityRecord.findUnique.mockResolvedValue(mine);
      prisma.evidence.findFirst.mockResolvedValue(makeEvidence([mine]));
      prisma.evidence.findMany.mockResolvedValue([{ id: 'ev-1', storagePath: 'sub-1/a.pdf', ...UNLINKED_OWNER }]);
      audit.record.mockRejectedValueOnce(new Error('audit down'));

      await expect(service.detach(dataEntry(), 'rec-1', 'ev-1')).rejects.toThrow(/audit down/);
      expect(intents.runNow).not.toHaveBeenCalled();
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

    it('is a 404 for a record out of reach before the file is even looked up', async () => {
      const foreign = makeRecord({ id: 'rec-x', subsidiaryId: 'sub-999' });
      prisma.activityRecord.findUnique.mockResolvedValue(foreign);
      prisma.evidence.findFirst.mockResolvedValue(makeEvidence([foreign], { subsidiaryId: 'sub-999' }));
      await expect(service.detach(dataEntry(), 'rec-x', 'ev-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.evidence.findFirst).not.toHaveBeenCalled();
      expect(prisma.activityRecordEvidence.deleteMany).not.toHaveBeenCalled();
    });

    it('answers and audits with the DATABASE ids when the path spells them in uppercase', async () => {
      // The route accepts either case. Comparing the path's spelling with the
      // ids the sweep returns once made a deleted file answer
      // `fileDeleted: false` and audit as a `detach` under an id no lookup finds.
      const mine = makeRecord({ id: 'rec-1' });
      prisma.activityRecord.findUnique.mockResolvedValue(mine);
      prisma.evidence.findFirst.mockResolvedValue(makeEvidence([mine]));
      prisma.evidence.findMany.mockResolvedValue([{ id: 'ev-1', storagePath: 'sub-1/a.pdf', ...UNLINKED_OWNER }]);

      const res = await service.detach(dataEntry(), 'REC-1', 'EV-1');

      expect(prisma.activityRecordEvidence.deleteMany).toHaveBeenCalledWith({
        where: { activityRecordId: 'rec-1', evidenceId: 'ev-1' },
      });
      expect(res).toEqual({ evidenceId: 'ev-1', recordId: 'rec-1', fileDeleted: true });
      expect(audit.record.mock.calls[0][1]).toMatchObject({
        action: 'delete',
        entityId: 'ev-1',
        diff: { before: { recordId: 'rec-1' } },
      });
    });

    it('is a 404 with no audit row when a concurrent detach removed the link first', async () => {
      const mine = makeRecord({ id: 'rec-1' });
      prisma.activityRecord.findUnique.mockResolvedValue(mine);
      prisma.evidence.findFirst.mockResolvedValue(makeEvidence([mine]));
      prisma.activityRecordEvidence.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.detach(dataEntry(), 'rec-1', 'ev-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.evidence.findMany).not.toHaveBeenCalled(); // no sweep
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
    it('deletes a file backing one editable record: the row and its audit row in one transaction, then the object', async () => {
      const record = makeRecord({ id: 'rec-1' });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([record]));
      prisma.activityRecord.findMany.mockResolvedValue([record]);

      const res = await service.remove(dataEntry(), 'ev-1');

      expect(intents.runNow).toHaveBeenCalledWith([{ bucket: 'evidence', path: 'sub-1/a.pdf' }]);
      expect(prisma.evidence.delete).toHaveBeenCalledWith({ where: { id: 'ev-1' } });
      // The object AFTER the commit — the old order (object first) could leave
      // a record pointing at bytes that were gone when the row delete lost a race.
      expect(prisma.evidence.delete.mock.invocationCallOrder[0]).toBeLessThan(
        audit.record.mock.invocationCallOrder[0],
      );
      expect(audit.record.mock.invocationCallOrder[0]).toBeLessThan(
        intents.runNow.mock.invocationCallOrder[0],
      );
      expect(res).toEqual({ id: 'ev-1', deleted: true });
      expect(audit.record.mock.calls[0][1]).toMatchObject({
        action: 'delete',
        diff: { before: { recordIds: ['rec-1'] } },
      });
      expect(audit.record.mock.calls[0][2]).toBe(tx);
      // The object's delete intent commits with the row and its audit row.
      expect(intents.enqueueDeletes).toHaveBeenCalledWith(
        tx,
        [{ bucket: 'evidence', path: 'sub-1/a.pdf' }],
        { reason: 'evidence.delete', subsidiaryId: 'sub-1', organisationId: 'org-1' },
      );
      expect(prisma.evidence.delete.mock.invocationCallOrder[0]).toBeLessThan(
        intents.enqueueDeletes.mock.invocationCallOrder[0],
      );
    });

    it('records no delete intent when the transaction fails, so nothing is removed', async () => {
      const record = makeRecord({ id: 'rec-1' });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([record]));
      prisma.activityRecord.findMany.mockResolvedValue([record]);
      audit.record.mockRejectedValueOnce(new Error('audit down'));

      await expect(service.remove(dataEntry(), 'ev-1')).rejects.toThrow('audit down');
      expect(intents.runNow).not.toHaveBeenCalled();
    });

    it('locks every record the file backs, then the file, before re-checking them', async () => {
      const a = makeRecord({ id: 'rec-2' });
      const b = makeRecord({ id: 'rec-1', periodValue: 'Q2' });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([a, b]));
      prisma.activityRecord.findMany.mockResolvedValue([a, b]);

      await service.remove(dataEntry(), 'ev-1');

      // Two periods shared, in key order; then the records, in id order; then the file.
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
      expect(prisma.$queryRaw.mock.calls[0].slice(1)).toEqual([['rec-1', 'rec-2']]);
      expect(prisma.$queryRaw.mock.calls[1].slice(1)).toEqual([['ev-1']]);
    });

    it('answers a lost race when a record it backs was submitted while it waited — and keeps the file', async () => {
      const draft = makeRecord({ id: 'rec-1' });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([draft]));
      prisma.activityRecord.findMany
        .mockResolvedValueOnce([draft])
        .mockResolvedValueOnce([{ ...draft, status: ActivityRecordStatus.submitted }]);

      await expect(service.remove(dataEntry(), 'ev-1')).rejects.toBeInstanceOf(RecordChangedError);
      expect(prisma.evidence.delete).not.toHaveBeenCalled();
      expect(intents.runNow).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('answers a lost race when a record it backs moved to another period meanwhile — its lock was never taken', async () => {
      const draft = makeRecord({ id: 'rec-1' });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([draft]));
      prisma.activityRecord.findMany
        .mockResolvedValueOnce([draft])
        .mockResolvedValueOnce([{ ...draft, reportingYear: 2025 }]);

      await expect(service.remove(dataEntry(), 'ev-1')).rejects.toBeInstanceOf(RecordChangedError);
      expect(prisma.evidence.delete).not.toHaveBeenCalled();
      expect(intents.runNow).not.toHaveBeenCalled();
    });

    it('removes no object when the audit fails — the delete rolled back', async () => {
      const record = makeRecord({ id: 'rec-1' });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([record]));
      prisma.activityRecord.findMany.mockResolvedValue([record]);
      audit.record.mockRejectedValueOnce(new Error('audit down'));

      await expect(service.remove(dataEntry(), 'ev-1')).rejects.toThrow(/audit down/);
      expect(intents.runNow).not.toHaveBeenCalled();
    });

    it('keeps the single-record refusals for a file backing one record', async () => {
      const record = makeRecord({ id: 'rec-1', status: ActivityRecordStatus.approved });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([record]));
      prisma.activityRecord.findMany.mockResolvedValue([record]);
      await expect(service.remove(dataEntry(), 'ev-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(intents.runNow).not.toHaveBeenCalled();
    });

    it('refuses to delete a SHARED file while any record it backs can no longer change', async () => {
      // The hole this closes: without it, removing the file from a draft's
      // vault would take it off an approved record too.
      const draft = makeRecord({ id: 'rec-1' });
      const approved = makeRecord({ id: 'rec-2', status: ActivityRecordStatus.approved, periodValue: 'Q3' });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([draft, approved]));
      prisma.activityRecord.findMany.mockResolvedValue([draft, approved]);

      const error = await service.remove(dataEntry(), 'ev-1').catch((e: unknown) => e);

      // The records checked are exactly the ones this file backs.
      expect(prisma.activityRecord.findMany).toHaveBeenCalledWith({
        where: { evidenceLinks: { some: { evidenceId: 'ev-1' } } },
      });
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toContain('Electricity · Q3 2024');
      expect((error as Error).message).toContain('Remove it from each editable record instead');
      expect(intents.runNow).not.toHaveBeenCalled();
      expect(prisma.evidence.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses in a locked period: the lock itself for one record, a 409 naming it for a shared file', async () => {
      const locked = makeRecord({ id: 'rec-1', status: ActivityRecordStatus.rejected });
      prisma.periodLock.findMany.mockResolvedValue([
        { subsidiaryId: 'sub-1', reportingYear: 2024, reportingPeriod: 'annual', periodValue: 'Annual' },
      ]);
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([locked]));
      prisma.activityRecord.findMany.mockResolvedValue([locked]);
      await expect(service.remove(dataEntry(), 'ev-1')).rejects.toBeInstanceOf(PeriodLockedError);

      const open = makeRecord({ id: 'rec-2', reportingPeriod: 'quarterly', periodValue: 'Q1' });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([open, locked]));
      prisma.activityRecord.findMany.mockResolvedValue([open, locked]);
      await expect(service.remove(dataEntry(), 'ev-1')).rejects.toThrow(/can no longer change.*is locked/);
      expect(intents.runNow).not.toHaveBeenCalled();
      expect(prisma.evidence.delete).not.toHaveBeenCalled();
    });

    it('deletes a shared file when every record it backs is editable by the caller', async () => {
      const a = makeRecord({ id: 'rec-1' });
      const b = makeRecord({ id: 'rec-2', status: ActivityRecordStatus.rejected });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([a, b]));
      prisma.activityRecord.findMany.mockResolvedValue([a, b]);
      await service.remove(dataEntry(), 'ev-1');
      expect(prisma.evidence.delete).toHaveBeenCalledOnce();
    });

    it('is a 404 with no audit row when another request deleted the file meanwhile', async () => {
      const record = makeRecord({ id: 'rec-1' });
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([record], { id: 'ev-1' }));
      prisma.activityRecord.findMany.mockResolvedValue([record]);
      // The file's row lock wakes to no row: the other delete committed first.
      prisma.$queryRaw.mockImplementation(async (sql: unknown, ids: string[]) =>
        (sql as string[]).join('?').includes('"evidence"') ? [] : ids.map((id) => ({ id })),
      );

      await expect(service.remove(dataEntry(), 'EV-1')).rejects.toBeInstanceOf(NotFoundException);
      // Scoped by the database's id, not the path's spelling.
      expect(prisma.$queryRaw.mock.calls.at(-1)!.slice(1)).toEqual([['ev-1']]);
      expect(prisma.evidence.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(intents.runNow).not.toHaveBeenCalled();
    });

    it('treats a file of a subsidiary out of reach as not found', async () => {
      prisma.evidence.findUnique.mockResolvedValue(
        makeEvidence([], { subsidiaryId: 'sub-999' }),
      );
      await expect(service.remove(dataEntry(), 'ev-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(intents.runNow).not.toHaveBeenCalled();
    });
  });

  describe('deleteUnlinkedRows — inside the caller\'s transaction, after links went', () => {
    it('does nothing for no ids', async () => {
      expect(await service.deleteUnlinkedRows([], tx as never)).toEqual([]);
      expect(prisma.evidence.findMany).not.toHaveBeenCalled();
    });

    it('deletes only the rows no record links to any more, records their delete intents, and returns them', async () => {
      const client = {
        evidence: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { id: 'ev-1', storagePath: 'sub-1/a.pdf', subsidiaryId: 'sub-1', subsidiary: { organisationId: 'org-1' } },
            ]),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };

      expect(await service.deleteUnlinkedRows(['ev-1', 'ev-2'], client as never)).toEqual([
        { id: 'ev-1', storagePath: 'sub-1/a.pdf' },
      ]);
      expect(client.evidence.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['ev-1', 'ev-2'] }, links: { none: {} } },
        select: { id: true, storagePath: true, subsidiaryId: true, subsidiary: { select: { organisationId: true } } },
      });
      expect(client.evidence.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['ev-1'] } } });
      // The intent is written through the SAME client, so it commits with the row delete.
      expect(intents.enqueueDeletes).toHaveBeenCalledWith(
        client,
        [{ bucket: 'evidence', path: 'sub-1/a.pdf' }],
        { reason: 'evidence.unlinked', subsidiaryId: 'sub-1', organisationId: 'org-1' },
      );
      // Through the caller's client only — and Storage waits for the commit.
      expect(prisma.evidence.findMany).not.toHaveBeenCalled();
      expect(intents.runNow).not.toHaveBeenCalled();
    });

    it('records no intent when every file is still linked', async () => {
      const client = { evidence: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() } };
      expect(await service.deleteUnlinkedRows(['ev-1'], client as never)).toEqual([]);
      expect(client.evidence.deleteMany).not.toHaveBeenCalled();
      expect(intents.enqueueDeletes).not.toHaveBeenCalled();
    });

    it('lets a database failure propagate — it rolls back the change that unlinked the file, audit row included', async () => {
      const client = { evidence: { findMany: vi.fn().mockRejectedValue(new Error('db down')) } };
      await expect(service.deleteUnlinkedRows(['ev-1'], client as never)).rejects.toThrow(/db down/);
    });
  });

  describe('removeBlobs — after the commit', () => {
    it('hands the committed delete intents to the intents service, which never throws', async () => {
      await expect(service.removeBlobs(['sub-1/a.pdf'])).resolves.toBeUndefined();
      expect(intents.runNow).toHaveBeenCalledWith([{ bucket: 'evidence', path: 'sub-1/a.pdf' }]);
      // Nothing is removed here directly: a failure must stay a retryable intent.
      expect(storage.remove).not.toHaveBeenCalled();
    });

    it('does nothing for no paths', async () => {
      await service.removeBlobs([]);
      expect(intents.runNow).not.toHaveBeenCalled();
    });
  });

  it('fileIdsFor reads through the caller’s transaction when given one', async () => {
    const client = { activityRecordEvidence: { findMany: vi.fn().mockResolvedValue([{ evidenceId: 'ev-9' }]) } };
    expect(await service.fileIdsFor('rec-1', client as never)).toEqual(['ev-9']);
    expect(prisma.activityRecordEvidence.findMany).not.toHaveBeenCalled();
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
    it('saves a download under the type\'s extension when the stored name lacks it', async () => {
      prisma.evidence.findUnique.mockResolvedValue(
        makeEvidence([makeRecord({ id: 'rec-1' })], { fileName: 'fatura.html' }),
      );
      await service.signedUrl(dataEntry(), 'ev-1');
      expect(storage.createSignedUrl).toHaveBeenCalledWith('evidence', 'sub-1/a.pdf', 60, 'fatura.html.pdf');
    });

    it('answers 404 — not 500 — and reports it, when the row\'s bytes are missing from Storage', async () => {
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([makeRecord({ id: 'rec-1' })]));
      storage.createSignedUrl.mockRejectedValue(new StorageObjectMissingError('evidence', 'sub-1/a.pdf'));
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const refusal = service.signedUrl(dataEntry(), 'ev-1');
      await expect(refusal).rejects.toBeInstanceOf(NotFoundException);
      await expect(refusal).rejects.toThrow(/missing from storage/);
      expect(logged.mock.calls[0][0]).toContain('sub-1/a.pdf');
      logged.mockRestore();
    });

    it('lets any other Storage failure through unchanged', async () => {
      prisma.evidence.findUnique.mockResolvedValue(makeEvidence([makeRecord({ id: 'rec-1' })]));
      storage.createSignedUrl.mockRejectedValue(new Error('storage down'));
      await expect(service.signedUrl(dataEntry(), 'ev-1')).rejects.toThrow('storage down');
    });

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
