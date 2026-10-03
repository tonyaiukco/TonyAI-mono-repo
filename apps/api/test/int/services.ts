import { vi } from 'vitest';
import { ActivityRecordsService } from '../../src/activity-records/activity-records.service';
import { AuditService } from '../../src/audit/audit.service';
import { CalculationsService } from '../../src/calculations/calculations.service';
import { EvidenceService } from '../../src/evidence/evidence.service';
import { PeriodLocksService } from '../../src/period-locks/period-locks.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StorageService } from '../../src/storage/storage.service';

/**
 * The lifecycle services as Nest would wire them, on one client — so every
 * query, including the audit insert, runs on that client's connection(s).
 */

/** A Storage stand-in: records what the services asked of the bucket, stores nothing. */
export function storageStub() {
  return {
    upload: vi.fn(async (_bucket: string, _path: string, _body: Buffer, _mimeType: string) => undefined),
    remove: vi.fn(async (_bucket: string, _paths: string[]) => undefined),
    createSignedUrl: vi.fn(async () => 'https://storage.invalid/signed'),
  };
}
export type StorageStub = ReturnType<typeof storageStub>;

export function lifecycleServices(prisma: PrismaService, storage: StorageStub = storageStub()) {
  const audit = new AuditService(prisma);
  const evidence = new EvidenceService(prisma, storage as unknown as StorageService, audit);
  const records = new ActivityRecordsService(prisma, new CalculationsService(prisma), audit, evidence);
  const periodLocks = new PeriodLocksService(prisma, audit);
  return { records, evidence, periodLocks, storage };
}

export const INJECTED_AUDIT_FAILURE = 'injected audit failure (LP1-01 test)';

/**
 * A client whose every audit insert fails — inside a transaction too, since a
 * query extension reaches interactive-transaction clients. Built on the REAL
 * AuditService, so what fails is the insert the service actually issues, not a
 * stubbed method that a refactor could stop calling.
 */
export function failingAuditClient(base: PrismaService): PrismaService {
  return base.$extends({
    query: {
      auditLog: {
        async create() {
          throw new Error(INJECTED_AUDIT_FAILURE);
        },
      },
    },
  }) as unknown as PrismaService;
}

export const ABORTED_AFTER_AUDIT = 'aborted after the audit insert (LP1-01 test)';

/**
 * A client whose audit insert SUCCEEDS and then throws, so the transaction
 * that issued it rolls back. Pass a client with more than one connection: a
 * service that wrote the audit row (or its change) on its root client instead
 * of the transaction's would then COMMIT that write on a second connection,
 * and the test finds it — rather than catching the mistake only because a
 * one-connection client starved.
 */
export function abortAfterAuditClient(base: PrismaService): PrismaService {
  return base.$extends({
    query: {
      auditLog: {
        async create({ args, query }) {
          await query(args);
          throw new Error(ABORTED_AFTER_AUDIT);
        },
      },
    },
  }) as unknown as PrismaService;
}

/** A multer-shaped file for the upload paths. */
export function pdfFile(): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'invoice.pdf',
    encoding: '7bit',
    mimetype: 'application/pdf',
    size: 4,
    buffer: Buffer.from('%PDF'),
  } as Express.Multer.File;
}
