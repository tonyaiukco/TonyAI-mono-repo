import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecordStatus } from '@tonyai/db';
import {
  DuplicateActivityRecordError,
  EvidenceDetachRequiredError,
  RecordChangedError,
} from '../../src/activity-records/errors';
import { ResourceNotFoundError } from '../../src/common/api-error';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  attachEvidence,
  backendPid,
  connect,
  createRecord,
  createTenant,
  holdBefore,
  settledOrBlocked,
  type Tenant,
} from './db';
import { INJECTED_AUDIT_FAILURE, failingAuditClient, lifecycleServices, storageStub } from './services';

/**
 * BUG-R2-03 (owner decision D1): an edit that re-files a record takes its
 * evidence with it in ONE transaction. A category change must name every
 * linked file; the named files are detached as a detach does — a file left
 * with no link deleted, row now and object after the commit, through a
 * storage intent — and nothing at all happens when the edit is refused.
 */

let a: PrismaService;
let b: PrismaService;
let observer: PrismaService;
let tenant: Tenant;

beforeAll(() => {
  a = connect();
  b = connect();
  observer = connect();
});

afterAll(async () => {
  await Promise.all([a, b, observer].map((c) => c.$disconnect()));
});

beforeEach(async () => {
  tenant = await createTenant();
});

afterEach(async () => {
  await tenant.cleanup();
});

/** Water needs no emission factor, so these edits do not depend on the factor library. */
const toWater = { category: 'Water', activityUnit: 'cubic_metres', activityType: null } as const;

async function linkedFileIds(recordId: string) {
  const links = await observer.activityRecordEvidence.findMany({ where: { activityRecordId: recordId }, select: { evidenceId: true } });
  return links.map((l) => l.evidenceId).sort();
}

describe('BUG-R2-03 — evidence follows a record edit', () => {
  it('a category change naming every file: the record is re-filed, its only-held file deleted with a storage intent, the shared one kept', async () => {
    const storage = storageStub();
    const record = await createRecord(a, tenant, {}, { priced: true });
    const other = await createRecord(a, tenant, { periodValue: 'February' }, { priced: true });
    const own = await attachEvidence(a, tenant, [record.id]);
    const shared = await attachEvidence(a, tenant, [record.id, other.id]);

    const dto = await lifecycleServices(b, storage).records.update(tenant.users.dataEntry, record.id, {
      ...toWater,
      detachEvidenceIds: [own.id, shared.id],
    } as never);

    expect(dto.category).toBe('Water');
    expect(dto.evidenceCount).toBe(0);
    expect(await linkedFileIds(record.id)).toEqual([]);
    // The file only this record held is gone, row and object.
    expect(await observer.evidence.count({ where: { id: own.id } })).toBe(0);
    expect(storage.remove).toHaveBeenCalledWith(expect.any(String), [own.storagePath]);
    // The shared one still backs the other record.
    expect(await linkedFileIds(other.id)).toEqual([shared.id]);
    // One audit row per file, beside the record's own update.
    const fileRows = await observer.auditLog.findMany({
      where: { entity: 'evidence', entityId: { in: [own.id, shared.id] } },
      select: { entityId: true, action: true },
    });
    expect(Object.fromEntries(fileRows.map((r) => [r.entityId, r.action]))).toEqual({ [own.id]: 'delete', [shared.id]: 'detach' });
    expect(await observer.auditLog.count({ where: { entityId: record.id, action: 'update' } })).toBe(1);
  });

  it('a category change leaving a file attached is refused, and nothing changes', async () => {
    const record = await createRecord(a, tenant, {}, { priced: true });
    const first = await attachEvidence(a, tenant, [record.id]);
    const second = await attachEvidence(a, tenant, [record.id]);

    await expect(
      lifecycleServices(b).records.update(tenant.users.dataEntry, record.id, { ...toWater, detachEvidenceIds: [first.id] } as never),
    ).rejects.toBeInstanceOf(EvidenceDetachRequiredError);

    expect((await observer.activityRecord.findUniqueOrThrow({ where: { id: record.id } })).category).toBe('Electricity');
    expect(await linkedFileIds(record.id)).toEqual([first.id, second.id].sort());
    expect(await observer.auditLog.count({ where: { entityId: { in: [record.id, first.id, second.id] } } })).toBe(0);
  });

  it('a category change refused as a duplicate rolls the detaches back: every file stays linked and stored', async () => {
    const storage = storageStub();
    const record = await createRecord(a, tenant, {}, { priced: true });
    // The slot the edit would move into is taken.
    await createRecord(a, tenant, { category: 'Water', activityUnit: 'cubic_metres', scope: 3 });
    const file = await attachEvidence(a, tenant, [record.id]);

    await expect(
      lifecycleServices(b, storage).records.update(tenant.users.dataEntry, record.id, { ...toWater, detachEvidenceIds: [file.id] } as never),
    ).rejects.toBeInstanceOf(DuplicateActivityRecordError);

    expect((await observer.activityRecord.findUniqueOrThrow({ where: { id: record.id } })).category).toBe('Electricity');
    expect(await linkedFileIds(record.id)).toEqual([file.id]);
    expect(await observer.evidence.count({ where: { id: file.id } })).toBe(1);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(await observer.storageIntent.count({ where: { objectPath: file.storagePath } })).toBe(0);
  });

  it('a file of another record is not found, and nothing changes', async () => {
    const record = await createRecord(a, tenant, {}, { priced: true });
    const other = await createRecord(a, tenant, { periodValue: 'March' }, { priced: true });
    const foreign = await attachEvidence(a, tenant, [other.id]);

    await expect(
      lifecycleServices(b).records.update(tenant.users.dataEntry, record.id, { activityValue: 5, detachEvidenceIds: [foreign.id] } as never),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(await linkedFileIds(other.id)).toEqual([foreign.id]);
    expect((await observer.activityRecord.findUniqueOrThrow({ where: { id: record.id } })).activityValue).toBe(record.activityValue);
  });

  it('a year move without a list keeps its files', async () => {
    const record = await createRecord(a, tenant, {}, { priced: true });
    const file = await attachEvidence(a, tenant, [record.id]);
    await lifecycleServices(b).records.update(tenant.users.dataEntry, record.id, { periodValue: 'June' } as never);
    expect(await linkedFileIds(record.id)).toEqual([file.id]);
  });

  it('a period move naming one of two files detaches only that one', async () => {
    const record = await createRecord(a, tenant, {}, { priced: true });
    const keep = await attachEvidence(a, tenant, [record.id]);
    const drop = await attachEvidence(a, tenant, [record.id]);
    await lifecycleServices(b).records.update(tenant.users.dataEntry, record.id, { periodValue: 'May', detachEvidenceIds: [drop.id] } as never);
    expect(await linkedFileIds(record.id)).toEqual([keep.id]);
    expect(await observer.evidence.count({ where: { id: drop.id } })).toBe(0);
    expect((await observer.activityRecord.findUniqueOrThrow({ where: { id: record.id } })).periodValue).toBe('May');
  });

  it('an edit that fails AFTER its detaches ran rolls them back: the audit insert fails, every file stays linked and stored', async () => {
    // The duplicate test above fails before the detaches run; this one fails
    // after them — the record's own audit row is the transaction's last write.
    const storage = storageStub();
    const record = await createRecord(a, tenant, {}, { priced: true });
    const file = await attachEvidence(a, tenant, [record.id]);

    await expect(
      lifecycleServices(failingAuditClient(b), storage).records.update(
        tenant.users.dataEntry, record.id, { ...toWater, detachEvidenceIds: [file.id] } as never,
      ),
    ).rejects.toThrow(INJECTED_AUDIT_FAILURE);

    expect((await observer.activityRecord.findUniqueOrThrow({ where: { id: record.id } })).category).toBe('Electricity');
    expect(await linkedFileIds(record.id)).toEqual([file.id]);
    expect(await observer.evidence.count({ where: { id: file.id } })).toBe(1);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(await observer.storageIntent.count({ where: { objectPath: file.storagePath } })).toBe(0);
  });

  it('a reviewer who saw the first submission cannot approve the one resubmitted after a recall', async () => {
    const record = await createRecord(a, tenant, {}, { priced: true });
    await attachEvidence(a, tenant, [record.id]);
    const svc = lifecycleServices(b).records;
    const first = await svc.submit(tenant.users.dataEntry, record.id);
    await svc.recall(tenant.users.dataEntry, record.id);
    await svc.update(tenant.users.dataEntry, record.id, { activityValue: 1000 } as never);
    const second = await svc.submit(tenant.users.dataEntry, record.id);
    expect(second.submittedAt).not.toBe(first.submittedAt);

    await expect(svc.approve(tenant.users.superAdmin, record.id, first.submittedAt)).rejects.toBeInstanceOf(RecordChangedError);
    expect((await observer.activityRecord.findUniqueOrThrow({ where: { id: record.id } })).status).toBe(ActivityRecordStatus.submitted);

    const approved = await svc.approve(tenant.users.superAdmin, record.id, second.submittedAt);
    expect(approved.status).toBe(ActivityRecordStatus.approved);
    expect(approved.activityValue).toBe(1000);
  });

  it('a category change racing a separate detach of the same file: one waits for the other, and the end state is consistent', async () => {
    const record = await createRecord(a, tenant, {}, { priced: true });
    const file = await attachEvidence(a, tenant, [record.id]);

    const held = holdBefore(a, 'ActivityRecord', ['update', 'updateMany']);
    const pidB = await backendPid(b);
    const edit = lifecycleServices(held.client).records
      .update(tenant.users.dataEntry, record.id, { ...toWater, detachEvidenceIds: [file.id] } as never)
      .then(() => 'ok' as const, (e: unknown) => e);
    await held.reached();
    const detach = lifecycleServices(b).evidence.detach(tenant.users.dataEntry, record.id, file.id);
    const detachOutcome = detach.then(() => 'ok' as const, (e: unknown) => e);
    const how = await settledOrBlocked(detach, pidB, observer);
    held.release();

    // The edit holds the record's row lock; the detach waits for it, then
    // finds the record changed (or its file gone) — never a half-applied pair.
    expect(how).toBe('blocked');
    expect(await edit).toBe('ok');
    const lost = await detachOutcome;
    expect(lost === 'ok').toBe(false);
    expect(lost instanceof RecordChangedError || lost instanceof ResourceNotFoundError).toBe(true);
    const final = await observer.activityRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(final.category).toBe('Water');
    expect(final.status).toBe(ActivityRecordStatus.draft);
    expect(await linkedFileIds(record.id)).toEqual([]);
    expect(await observer.evidence.count({ where: { id: file.id } })).toBe(0);
    expect(await observer.auditLog.count({ where: { entityId: file.id } })).toBe(1);
  });
});
