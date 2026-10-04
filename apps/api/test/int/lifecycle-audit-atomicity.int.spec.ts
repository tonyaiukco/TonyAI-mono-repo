import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecordStatus } from '@tonyai/db';
import { AuditService } from '../../src/audit/audit.service';
import { BulkSubmitService } from '../../src/bulk-upload/bulk-submit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { attachEvidence, connect, createRecord, createTenant, type Tenant } from './db';
import {
  ABORTED_AFTER_AUDIT,
  INJECTED_AUDIT_FAILURE,
  abortAfterAuditClient,
  failingAuditClient,
  lifecycleServices,
  pdfFile,
  storageStub,
  type StorageStub,
} from './services';

/**
 * F02 (Part C): a business write and its audit row commit together or not at
 * all.
 *
 * For every lifecycle mutation: run it on a client whose audit insert fails,
 * and require that NOTHING changed — no record, link, file or lock row moved,
 * no audit row exists, and no Storage object was deleted for a change that
 * did not commit. Then run it again on a healthy client and require exactly
 * one logical mutation with exactly one audit row: a retry after the failure
 * is a clean first attempt, not a conflict with a half-done one.
 *
 * Between the two, the same mutation runs on a POOLED client whose audit
 * insert succeeds and then throws: the transaction rolls back, and neither
 * the change nor the audit row may survive. That is what proves both went
 * through the transaction's client — a write or audit row issued on the
 * service's root client would commit on another connection and be found.
 */

let prisma: PrismaService;
let pooled: PrismaService;
let tenant: Tenant;

beforeAll(() => {
  prisma = connect();
  pooled = connect(4);
});

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), pooled.$disconnect()]);
});

beforeEach(async () => {
  tenant = await createTenant();
});

afterEach(async () => {
  await tenant.cleanup();
});

/** Every row a lifecycle mutation can touch in the tenant, in a comparable shape. */
async function tenantState() {
  const where = { subsidiaryId: tenant.subsidiaryId };
  const [records, evidence, links, locks] = await Promise.all([
    prisma.activityRecord.findMany({
      where,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        status: true,
        activityValue: true,
        reviewedBy: true,
        submittedAt: true,
        voidedAt: true,
        updatedAt: true,
      },
    }),
    prisma.evidence.findMany({ where, orderBy: { id: 'asc' }, select: { id: true } }),
    prisma.activityRecordEvidence.findMany({
      where,
      orderBy: [{ activityRecordId: 'asc' }, { evidenceId: 'asc' }],
      select: { activityRecordId: true, evidenceId: true },
    }),
    prisma.periodLock.findMany({ where, orderBy: { id: 'asc' }, select: { id: true } }),
  ]);
  return { records, evidence, links, locks };
}

async function auditRows() {
  return prisma.auditLog.findMany({
    where: { userId: { in: tenant.profileIds } },
    select: { action: true, entity: true, entityId: true },
  });
}

type Services = ReturnType<typeof lifecycleServices>;

interface Case {
  name: string;
  /** Builds the starting state; returns what `act` needs. */
  arrange: () => Promise<Record<string, string>>;
  act: (s: Services, ids: Record<string, string>) => Promise<unknown>;
  audit: { action: string; entity: string };
  /** Storage removals a COMMITTED run makes (none may happen on the failed run). */
  removesBlob?: boolean;
}

const period = { reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'January' } as const;

const cases: Case[] = [
  {
    name: 'create',
    arrange: async () => ({}),
    act: (s) =>
      s.records.create(tenant.users.dataEntry, {
        subsidiaryId: tenant.subsidiaryId,
        ...period,
        reportingPeriod: 'monthly',
        category: 'Water',
        activityValue: 10,
        activityUnit: 'cubic_metres',
      }),
    audit: { action: 'create', entity: 'activity_record' },
  },
  {
    name: 'update',
    arrange: async () => {
      const r = await createRecord(prisma, tenant, { category: 'Water', activityUnit: 'cubic_metres' });
      return { record: r.id };
    },
    act: (s, ids) => s.records.update(tenant.users.dataEntry, ids.record, { activityValue: 20 }),
    audit: { action: 'update', entity: 'activity_record' },
  },
  {
    name: 'delete (with the last link to a file)',
    arrange: async () => {
      const r = await createRecord(prisma, tenant);
      await attachEvidence(prisma, tenant, [r.id]);
      return { record: r.id };
    },
    act: (s, ids) => s.records.remove(tenant.users.dataEntry, ids.record),
    audit: { action: 'delete', entity: 'activity_record' },
    removesBlob: true,
  },
  {
    name: 'submit',
    arrange: async () => {
      const r = await createRecord(prisma, tenant);
      await attachEvidence(prisma, tenant, [r.id]);
      return { record: r.id };
    },
    act: (s, ids) => s.records.submit(tenant.users.dataEntry, ids.record),
    audit: { action: 'submit', entity: 'activity_record' },
  },
  {
    name: 'startReview',
    arrange: async () => {
      const r = await createRecord(prisma, tenant, { status: ActivityRecordStatus.submitted });
      return { record: r.id };
    },
    act: (s, ids) => s.records.startReview(tenant.users.consultant, ids.record),
    audit: { action: 'review', entity: 'activity_record' },
  },
  {
    name: 'approve',
    arrange: async () => {
      const r = await createRecord(prisma, tenant, { status: ActivityRecordStatus.submitted });
      return { record: r.id };
    },
    act: (s, ids) => s.records.approve(tenant.users.superAdmin, ids.record),
    audit: { action: 'approve', entity: 'activity_record' },
  },
  {
    name: 'reject',
    arrange: async () => {
      const r = await createRecord(prisma, tenant, { status: ActivityRecordStatus.under_review });
      return { record: r.id };
    },
    act: (s, ids) => s.records.reject(tenant.users.consultant, ids.record, 'Wrong meter'),
    audit: { action: 'reject', entity: 'activity_record' },
  },
  {
    name: 'void',
    arrange: async () => {
      const r = await createRecord(prisma, tenant, { status: ActivityRecordStatus.approved });
      return { record: r.id };
    },
    act: (s, ids) => s.records.void(tenant.users.superAdmin, ids.record, 'Entered in error'),
    audit: { action: 'void', entity: 'activity_record' },
  },
  {
    name: 'evidence upload',
    arrange: async () => {
      const r = await createRecord(prisma, tenant);
      return { record: r.id };
    },
    act: (s, ids) => s.evidence.upload(tenant.users.dataEntry, ids.record, pdfFile()),
    audit: { action: 'create', entity: 'evidence' },
  },
  {
    name: 'evidence detach (the last link, so the file goes too)',
    arrange: async () => {
      const r = await createRecord(prisma, tenant);
      const f = await attachEvidence(prisma, tenant, [r.id]);
      return { record: r.id, file: f.id };
    },
    act: (s, ids) => s.evidence.detach(tenant.users.dataEntry, ids.record, ids.file),
    audit: { action: 'delete', entity: 'evidence' },
    removesBlob: true,
  },
  {
    name: 'evidence detach (a shared file stays)',
    arrange: async () => {
      const r1 = await createRecord(prisma, tenant);
      const r2 = await createRecord(prisma, tenant, { periodValue: 'February' });
      const f = await attachEvidence(prisma, tenant, [r1.id, r2.id]);
      return { record: r1.id, file: f.id };
    },
    act: (s, ids) => s.evidence.detach(tenant.users.dataEntry, ids.record, ids.file),
    audit: { action: 'detach', entity: 'evidence' },
  },
  {
    name: 'evidence remove',
    arrange: async () => {
      const r = await createRecord(prisma, tenant);
      const f = await attachEvidence(prisma, tenant, [r.id]);
      return { file: f.id };
    },
    act: (s, ids) => s.evidence.remove(tenant.users.dataEntry, ids.file),
    audit: { action: 'delete', entity: 'evidence' },
    removesBlob: true,
  },
  {
    name: 'period lock',
    arrange: async () => {
      await createRecord(prisma, tenant, { status: ActivityRecordStatus.approved });
      return {};
    },
    act: (s) =>
      s.periodLocks.lock(tenant.users.superAdmin, {
        subsidiaryId: tenant.subsidiaryId,
        ...period,
        reportingPeriod: 'monthly',
      }),
    audit: { action: 'lock', entity: 'period_lock' },
  },
  {
    name: 'period unlock',
    arrange: async () => {
      await createRecord(prisma, tenant, { status: ActivityRecordStatus.locked });
      const lock = await prisma.periodLock.create({
        data: { subsidiaryId: tenant.subsidiaryId, ...period, lockedBy: tenant.users.superAdmin.id },
      });
      return { lock: lock.id };
    },
    act: (s, ids) => s.periodLocks.unlock(tenant.users.superAdmin, ids.lock),
    audit: { action: 'unlock', entity: 'period_lock' },
  },
];

describe('F02 — a mutation and its audit row are one transaction', () => {
  it.each(cases)('$name: an audit failure leaves no trace; the retry is one clean mutation', async (c) => {
    const ids = await c.arrange();
    const before = await tenantState();

    const failedStorage: StorageStub = storageStub();
    await expect(c.act(lifecycleServices(failingAuditClient(prisma), failedStorage), ids)).rejects.toThrow(
      INJECTED_AUDIT_FAILURE,
    );

    // Nothing moved, nothing was audited, and no blob was deleted for a
    // change that rolled back. (An upload's own blob is removed again — that
    // is cleanup of its object, asserted below — never another file's.)
    expect(await tenantState()).toEqual(before);
    expect(await auditRows()).toEqual([]);
    if (c.name === 'evidence upload') {
      expect(failedStorage.upload).toHaveBeenCalledTimes(1);
      const uploadedPath = (failedStorage.upload.mock.calls[0] as unknown[])[1];
      expect(failedStorage.remove).toHaveBeenCalledWith('evidence', [uploadedPath]);
    } else {
      expect(failedStorage.remove).not.toHaveBeenCalled();
    }

    // Audit row written, then the transaction aborted: nothing survives, on
    // a client where a stray root-client write could have committed.
    const abortedStorage: StorageStub = storageStub();
    await expect(c.act(lifecycleServices(abortAfterAuditClient(pooled), abortedStorage), ids)).rejects.toThrow(
      ABORTED_AFTER_AUDIT,
    );
    expect(await tenantState()).toEqual(before);
    expect(await auditRows()).toEqual([]);
    if (c.name !== 'evidence upload') expect(abortedStorage.remove).not.toHaveBeenCalled();

    // The retry is a first attempt: it succeeds once, with one audit row.
    const storage = storageStub();
    await expect(c.act(lifecycleServices(prisma, storage), ids)).resolves.toBeDefined();
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(c.audit);
    expect(await tenantState()).not.toEqual(before);
    expect(storage.remove).toHaveBeenCalledTimes(c.removesBlob ? 1 : 0);
  });
});

describe('F02 — the importer reuses these paths (bulk submit)', () => {
  it('an audit failure leaves the record untouched and reports it; the retry submits it once', async () => {
    const record = await createRecord(prisma, tenant);
    await attachEvidence(prisma, tenant, [record.id]);
    const failing = failingAuditClient(prisma);
    const bulk = (client: PrismaService) =>
      new BulkSubmitService(client, lifecycleServices(client).records, new AuditService(client));

    const report = await bulk(failing).submitIds(tenant.users.dataEntry, [record.id]);
    expect(report.submitted).toEqual([]);
    expect(report.failed).toEqual([expect.objectContaining({ recordId: record.id, code: 'unexpected' })]);
    expect((await prisma.activityRecord.findUniqueOrThrow({ where: { id: record.id } })).status).toBe(
      ActivityRecordStatus.draft,
    );
    expect(await prisma.auditLog.count({ where: { entityId: record.id } })).toBe(0);

    const again = await bulk(prisma).submitIds(tenant.users.dataEntry, [record.id]);
    expect(again.submitted).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { entityId: record.id } })).toBe(1);
  });
});
