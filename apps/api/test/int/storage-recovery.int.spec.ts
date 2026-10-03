import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ActivityRecordStatus, type Prisma } from '@tonyai/db';
import { EvidenceRequiredError, RecordChangedError } from '../../src/activity-records/errors';
import { AuditService } from '../../src/audit/audit.service';
import { BulkUploadService } from '../../src/bulk-upload/bulk-upload.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { EVIDENCE_BUCKET, IMPORT_SOURCES_BUCKET, type Bucket } from '../../src/storage/buckets';
import type { StorageService } from '../../src/storage/storage.service';
import {
  StorageIntentsService,
  UPLOAD_GRACE_SECONDS,
  UploadExpiredError,
} from '../../src/storage/storage-intents.service';
import { StorageReconcileService } from '../../src/storage/storage-reconcile.service';
import {
  backendPid,
  connect,
  connectOwner,
  createRecord,
  createTenant,
  deferred,
  holdBefore,
  settledOrBlocked,
  type Tenant,
} from './db';
import { failingAuditClient, lifecycleServices, pdfFile } from './services';
import {
  localStorage,
  objectExists,
  removeTenantObjects,
  sha256,
  tenantObjects,
  tenantPrefixes,
} from './storage';

/**
 * LP1-02 (F14): every database ↔ Storage boundary, failed on purpose, against
 * real PostgreSQL AND the local Supabase Storage. A fault is one spied call
 * on a real `StorageService` or one Prisma query extension; everything else
 * runs for real, and each test asserts on the objects themselves — present,
 * absent, or hashing to the row's sha256 — never on a stub's call log.
 *
 * The acceptance it carries (Part B, LP1-02 "Done when"): failure injection
 * at each boundary is recoverable — every failure ends with no orphan and no
 * row pointing at missing bytes, or with an intent the sweeper then
 * finishes; concurrent approval cannot silently lose evidence; cleanup is
 * bounded, observable (backlog, stuck) and safe during restoration
 * (`STORAGE_CLEANUP_HOLD`, orphans never swept automatically).
 */

let a: PrismaService;
let b: PrismaService;
let observer: PrismaService;
let tenant: Tenant;
let storage: StorageService;

beforeAll(() => {
  // Pooled: a service that wrote an intent on its root client instead of its
  // transaction's must COMMIT that write and be found — not merely starve a
  // one-connection client and fail for the wrong reason (`qa-auditor`).
  a = connect(5);
  b = connect();
  observer = connect();
});

afterAll(async () => {
  await Promise.all([a, b, observer].map((c) => c.$disconnect()));
});

beforeEach(async () => {
  tenant = await createTenant();
  storage = localStorage();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // A fresh service: the test's own may still carry a spy.
  await removeTenantObjects(observer, localStorage(), tenant);
  await tenant.cleanup();
});

const INJECTED = 'injected storage failure (LP1-02 test)';

const outcome = (p: Promise<unknown>): Promise<'ok' | unknown> =>
  p.then(
    () => 'ok' as const,
    (err: unknown) => err,
  );

function quiet(): void {
  for (const level of ['error', 'warn', 'log'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
}

/** Every intent under the tenant's key prefixes. */
async function intents() {
  const prefixes = Object.values(tenantPrefixes(tenant));
  return observer.storageIntent.findMany({
    where: { OR: prefixes.map((p) => ({ objectPath: { startsWith: p } })) },
    orderBy: { createdAt: 'asc' },
  });
}

/** Make the tenant's intents due now and unclaimed — the passage of time a backoff or a lease waits for. */
async function makeDue() {
  for (const prefix of Object.values(tenantPrefixes(tenant))) {
    await observer.$executeRaw`
      UPDATE storage_intents SET next_attempt_at = now() - interval '1 second', claimed_until = NULL
      WHERE starts_with(object_path, ${prefix})`;
  }
}

function sweeper(client: PrismaService = b, store: StorageService = storage) {
  return new StorageIntentsService(client, store);
}

async function evidenceObjects() {
  return (await tenantObjects(observer, tenant)).filter((o) => o.bucket === EVIDENCE_BUCKET);
}

async function draft(data: Partial<Prisma.ActivityRecordUncheckedCreateInput> = {}) {
  return createRecord(a, tenant, data);
}

const IMPORT_HEADER =
  'subsidiaryId,locationId,reportingYear,reportingPeriod,periodValue,category,activityValue,activityUnit,varianceReason';

/** An import the importer reads and then refuses row by row (a non-numeric value): the batch opens, no record is written. */
function importCsv(): Express.Multer.File {
  const buffer = Buffer.from(
    `${IMPORT_HEADER}\n${tenant.subsidiaryId},,2026,monthly,January,Electricity,not-a-number,kWh,\n`,
  );
  return { originalname: 'import.csv', mimetype: 'text/csv', size: buffer.length, buffer } as Express.Multer.File;
}

function importer(client: PrismaService, store: StorageService = storage) {
  const { records, intents: intentService } = lifecycleServices(client, store);
  return new BulkUploadService(client, records, new AuditService(client), store, intentService);
}

/** Upload a real file to `recordIds` through the service; returns its row. */
async function uploaded(recordIds: string[]) {
  const services = lifecycleServices(a, storage);
  const dto =
    recordIds.length === 1
      ? await services.evidence.upload(tenant.users.dataEntry, recordIds[0], pdfFile())
      : await services.evidence.uploadForRecords(tenant.users.dataEntry, recordIds, pdfFile());
  return observer.evidence.findUniqueOrThrow({ where: { id: dto.id } });
}

/** The row's bytes are in Storage and hash to the row's sha256. */
async function expectIntactBytes(row: { storagePath: string; sha256: string | null }) {
  expect(await objectExists(observer, EVIDENCE_BUCKET, row.storagePath)).toBe(true);
  expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(sha256(await storage.download(EVIDENCE_BUCKET, row.storagePath))).toBe(row.sha256);
}

describe('LP1-02 — an evidence upload, failed at each boundary', () => {
  it('the intent cannot be written: nothing is stored and no row is written', async () => {
    const record = await draft();
    const noIntent = a.$extends({
      query: {
        storageIntent: {
          async create() {
            throw new Error('injected intent failure');
          },
        },
      },
    }) as unknown as PrismaService;
    const upload = vi.spyOn(storage, 'upload');

    const result = await outcome(
      lifecycleServices(noIntent, storage).evidence.upload(tenant.users.dataEntry, record.id, pdfFile()),
    );

    expect(result).toBeInstanceOf(Error);
    expect(upload).not.toHaveBeenCalled();
    expect(await evidenceObjects()).toEqual([]);
    expect(await observer.evidence.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(0);
  });

  it('Storage refuses the bytes: no row, no object, and the intent is closed', async () => {
    quiet();
    const record = await draft();
    vi.spyOn(storage, 'upload').mockRejectedValueOnce(new Error(INJECTED));

    const result = await outcome(
      lifecycleServices(a, storage).evidence.upload(tenant.users.dataEntry, record.id, pdfFile()),
    );

    expect((result as Error).message).toBe(INJECTED);
    expect(await evidenceObjects()).toEqual([]);
    expect(await observer.evidence.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(0);
    expect(await intents()).toEqual([]);
  });

  it('the row transaction fails (its audit insert): the object is removed and the intent closed', async () => {
    quiet();
    const record = await draft();

    const result = await outcome(
      lifecycleServices(failingAuditClient(a), storage).evidence.upload(
        tenant.users.dataEntry,
        record.id,
        pdfFile(),
      ),
    );

    expect(result).toBeInstanceOf(Error);
    expect(await observer.evidence.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(0);
    expect(await evidenceObjects()).toEqual([]);
    expect(await intents()).toEqual([]);
  });

  it('the transaction fails AND the removal fails: the object waits as a delete intent, and a sweep removes it', async () => {
    quiet();
    const record = await draft();
    vi.spyOn(storage, 'remove').mockRejectedValueOnce(new Error(INJECTED));

    await outcome(
      lifecycleServices(failingAuditClient(a), storage).evidence.upload(
        tenant.users.dataEntry,
        record.id,
        pdfFile(),
      ),
    );

    const [left] = await evidenceObjects();
    expect(left).toBeDefined();
    const [intent] = await intents();
    expect(intent).toMatchObject({ kind: 'delete', objectPath: left.path, attempts: 1, claimedUntil: null });
    expect(intent.lastError).toContain(INJECTED);
    expect(intent.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // Not due yet: the sweep leaves it — the backoff is real.
    await sweeper().sweep();
    expect(await objectExists(observer, EVIDENCE_BUCKET, left.path)).toBe(true);

    await makeDue();
    const report = await sweeper().sweep();
    expect(report.removed).toBeGreaterThanOrEqual(1);
    expect(await evidenceObjects()).toEqual([]);
    expect(await intents()).toEqual([]);
  });

  it('the commit succeeds but its acknowledgement is lost: the row KEEPS its bytes (it used to lose them)', async () => {
    quiet();
    const record = await draft();
    const LOST = 'connection reset after COMMIT (LP1-02 test)';
    // The transaction really commits; the caller sees an error anyway.
    const lostAck = new Proxy(a, {
      get(target, prop) {
        if (prop === '$transaction') {
          return async (...args: unknown[]) => {
            await (target.$transaction as (...x: unknown[]) => Promise<unknown>)(...args);
            throw new Error(LOST);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as PrismaService;

    const result = await outcome(
      lifecycleServices(lostAck, storage).evidence.upload(tenant.users.dataEntry, record.id, pdfFile()),
    );

    expect((result as Error).message).toBe(LOST);
    const row = await observer.evidence.findFirstOrThrow({ where: { subsidiaryId: tenant.subsidiaryId } });
    await expectIntactBytes(row);
    expect(await intents()).toEqual([]);
  });

  it('the process dies after the upload: the sweeper abandons the intent after its grace and removes the object', async () => {
    quiet();
    const services = lifecycleServices(a, storage);
    const path = `${tenant.subsidiaryId}/crashed-upload.pdf`;
    // What a request had done when it died: the intent, then the bytes.
    await services.intents.beginUpload({ bucket: EVIDENCE_BUCKET, path }, { reason: 'evidence.upload' });
    await storage.upload(EVIDENCE_BUCKET, path, Buffer.from('%PDF-1.4\n'), 'application/pdf');

    // Inside the grace period it may still be a live upload: untouched.
    await sweeper().sweep();
    expect(await objectExists(observer, EVIDENCE_BUCKET, path)).toBe(true);
    expect((await intents())[0]).toMatchObject({ kind: 'upload' });

    await observer.$executeRaw`
      UPDATE storage_intents
      SET created_at = now() - ${UPLOAD_GRACE_SECONDS + 60}::int * interval '1 second'
      WHERE object_path = ${path}`;
    const report = await sweeper().sweep();
    expect(report.abandoned).toBeGreaterThanOrEqual(1);
    expect(await objectExists(observer, EVIDENCE_BUCKET, path)).toBe(false);
    expect(await intents()).toEqual([]);
  });

  it('the sweeper abandons an intent the owning transaction has not adopted yet: the upload is refused, nothing is left', async () => {
    quiet();
    const record = await draft();
    const held = holdBefore(a, 'StorageIntent', 'deleteMany');
    const upload = outcome(
      lifecycleServices(held.client, storage).evidence.upload(tenant.users.dataEntry, record.id, pdfFile()),
    );
    await held.reached();
    // The bytes are up; the transaction holds its record locks but has not adopted the intent.
    const [intent] = await intents();
    expect(intent.kind).toBe('upload');
    await observer.$executeRaw`
      UPDATE storage_intents
      SET created_at = now() - ${UPLOAD_GRACE_SECONDS + 60}::int * interval '1 second'
      WHERE id = ${intent.id}::uuid`;
    await sweeper().sweep();
    expect(await objectExists(observer, EVIDENCE_BUCKET, intent.objectPath)).toBe(false);
    held.release();

    const refused = await upload;
    expect(refused).toBeInstanceOf(UploadExpiredError);
    // A retry, not an outage: 409, never a 5xx that would page whoever watches the error rate.
    expect((refused as UploadExpiredError).getStatus()).toBe(409);
    expect(await observer.evidence.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(0);
    expect(await intents()).toEqual([]);
  });

  it('the sweeper abandons an upload whose bytes are still on their way: the late bytes are removed too', async () => {
    quiet();
    const record = await draft();
    const started = deferred();
    const gate = deferred();
    const send = storage.upload.bind(storage);
    vi.spyOn(storage, 'upload').mockImplementationOnce(async (...args) => {
      started.resolve();
      await gate.promise;
      return send(...args);
    });
    const upload = outcome(
      lifecycleServices(a, storage).evidence.upload(tenant.users.dataEntry, record.id, pdfFile()),
    );
    await started.promise;
    // The intent is committed, the bytes are not there yet — and the sweeper
    // decides the upload is dead: it removes nothing (yet) and closes the intent.
    const [intent] = await intents();
    await observer.$executeRaw`
      UPDATE storage_intents
      SET created_at = now() - ${UPLOAD_GRACE_SECONDS + 60}::int * interval '1 second'
      WHERE id = ${intent.id}::uuid`;
    await sweeper().sweep();
    expect(await intents()).toEqual([]);

    gate.resolve();
    const refused = await upload;
    expect(refused).toBeInstanceOf(UploadExpiredError);
    // A retry, not an outage: 409, never a 5xx that would page whoever watches the error rate.
    expect((refused as UploadExpiredError).getStatus()).toBe(409);
    // The bytes landed after the sweeper's removal; the request's own refusal removed them.
    expect(await objectExists(observer, EVIDENCE_BUCKET, intent.objectPath)).toBe(false);
    expect(await observer.evidence.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(0);
    expect(await intents()).toEqual([]);
  });

  it('a sweep while the owning transaction holds its adopted intent: the sweep skips it, the row keeps its bytes', async () => {
    const record = await draft();
    // Every intent this client writes is already past its grace.
    const backdated = a.$extends({
      query: {
        storageIntent: {
          async create({ args, query }) {
            const createdAt = new Date(Date.now() - (UPLOAD_GRACE_SECONDS + 60) * 1000);
            return query({ ...args, data: { ...args.data, createdAt } });
          },
        },
      },
    }) as unknown as PrismaService;
    const held = holdBefore(backdated, 'Evidence', 'create');
    const upload = outcome(
      lifecycleServices(held.client, storage).evidence.upload(tenant.users.dataEntry, record.id, pdfFile()),
    );
    await held.reached();

    // Adopted but not committed: the row is locked, and the sweep must not wait on it.
    const pidB = await backendPid(b);
    const sweep = sweeper().sweep();
    expect(await settledOrBlocked(sweep, pidB, observer)).toBe('settled');
    expect((await sweep).abandoned).toBe(0);
    held.release();

    expect(await upload).toBe('ok');
    const row = await observer.evidence.findFirstOrThrow({ where: { subsidiaryId: tenant.subsidiaryId } });
    await expectIntactBytes(row);
    expect(await intents()).toEqual([]);
  });
});

describe('LP1-02 — the sweeper and an adoption, at the same moment', () => {
  it('a sweep already removing an abandoned upload while its transaction adopts: the adoption is refused, no row points at removed bytes', async () => {
    quiet();
    const record = await draft();
    const held = holdBefore(a, 'StorageIntent', 'deleteMany');
    const upload = outcome(
      lifecycleServices(held.client, storage).evidence.upload(tenant.users.dataEntry, record.id, pdfFile()),
    );
    await held.reached();
    const [intent] = await intents();
    await observer.$executeRaw`
      UPDATE storage_intents
      SET created_at = now() - ${UPLOAD_GRACE_SECONDS + 60}::int * interval '1 second'
      WHERE id = ${intent.id}::uuid`;
    // The sweep abandons the intent, claims it, finds no owner — and is held
    // at the Storage call, the moment the adoption runs.
    const sweepStorage = localStorage();
    const send = sweepStorage.remove.bind(sweepStorage);
    const atRemove = deferred();
    const gate = deferred();
    vi.spyOn(sweepStorage, 'remove').mockImplementation(async (bucket, paths) => {
      atRemove.resolve();
      await gate.promise;
      return send(bucket, paths);
    });
    const sweep = sweeper(b, sweepStorage).sweep();
    await atRemove.promise;
    held.release();
    const result = await upload;
    gate.resolve();
    await sweep;

    expect(result).toBeInstanceOf(UploadExpiredError);
    expect(await observer.evidence.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(0);
    expect(await evidenceObjects()).toEqual([]);
    expect(await intents()).toEqual([]);
  });
});

describe('LP1-02 — late bytes, whatever else fails (`qa-auditor` round 2)', () => {
  /** An upload whose bytes wait at `gate`; resolves `started` once the intent is committed and the call is made. */
  function slowUpload(store: StorageService, gate: Promise<void>, started: { resolve(): void }) {
    const send = store.upload.bind(store);
    vi.spyOn(store, 'upload').mockImplementationOnce(async (...args) => {
      started.resolve();
      await gate;
      return send(...args);
    });
  }

  async function backdate(id: string) {
    await observer.$executeRaw`
      UPDATE storage_intents
      SET created_at = now() - ${UPLOAD_GRACE_SECONDS + 60}::int * interval '1 second'
      WHERE id = ${id}::uuid`;
  }

  it('bytes landing after the sweep removed them, while its intent is still open: the re-enqueue is not swallowed', async () => {
    quiet();
    const record = await draft();
    const sweepStorage = localStorage();
    const removed = deferred();
    const closed = deferred();
    const remove = sweepStorage.remove.bind(sweepStorage);
    vi.spyOn(sweepStorage, 'remove').mockImplementation(async (bucket, paths) => {
      await remove(bucket, paths);
      removed.resolve();
      await closed.promise; // the sweep holds its claim open past the removal
    });
    const started = deferred();
    slowUpload(storage, removed.promise, started);
    // The request's own removal of the late bytes fails too: the reset intent
    // must then outlive the sweep's close — which holds only under its lease.
    vi.spyOn(storage, 'remove').mockRejectedValueOnce(new Error(INJECTED));

    const upload = outcome(
      lifecycleServices(a, storage).evidence.upload(tenant.users.dataEntry, record.id, pdfFile()),
    );
    await started.promise;
    const [intent] = await intents();
    await backdate(intent.id);
    const sweep = sweeper(b, sweepStorage).sweep();
    // The bytes land after the sweep's removal; the upload's adoption fails;
    // its re-enqueue meets the sweep's still-open intent.
    const refused = await upload;
    closed.resolve();
    await sweep;

    expect(refused).toBeInstanceOf(UploadExpiredError);
    // The late bytes are there, and still named: the reset intent outlived the sweep's close.
    expect(await objectExists(observer, EVIDENCE_BUCKET, intent.objectPath)).toBe(true);
    expect(await intents()).toHaveLength(1);
    await makeDue();
    await sweeper().sweep();
    expect(await objectExists(observer, EVIDENCE_BUCKET, intent.objectPath)).toBe(false);
    expect(await intents()).toEqual([]);
    expect(await observer.evidence.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(0);
  });

  it('the intent naming late bytes carries its tenant when it must outlive a failed removal', async () => {
    quiet();
    const record = await draft();
    const started = deferred();
    const gate = deferred();
    slowUpload(storage, gate.promise, started);
    const upload = outcome(
      lifecycleServices(a, storage).evidence.upload(tenant.users.dataEntry, record.id, pdfFile()),
    );
    await started.promise;
    const [intent] = await intents();
    await backdate(intent.id);
    await sweeper().sweep(); // abandons, removes nothing yet, closes
    expect(await intents()).toEqual([]);
    vi.spyOn(storage, 'remove').mockRejectedValueOnce(new Error(INJECTED));
    gate.resolve();
    expect(await upload).toBeInstanceOf(UploadExpiredError);

    expect(await intents()).toMatchObject([
      {
        kind: 'delete',
        objectPath: intent.objectPath,
        reason: 'upload.expired',
        organisationId: tenant.organisationId,
        subsidiaryId: tenant.subsidiaryId,
      },
    ]);
    await makeDue();
    await sweeper().sweep();
    expect(await objectExists(observer, EVIDENCE_BUCKET, intent.objectPath)).toBe(false);
  });

  it('bytes landing after the sweep abandoned their upload, and the record gone meanwhile: still removed', async () => {
    quiet();
    const record = await draft();
    const started = deferred();
    const gate = deferred();
    slowUpload(storage, gate.promise, started);

    const upload = outcome(
      lifecycleServices(a, storage).evidence.upload(tenant.users.dataEntry, record.id, pdfFile()),
    );
    await started.promise;
    const [intent] = await intents();
    await backdate(intent.id);
    await sweeper().sweep();
    // Another failure the transaction would meet before its adoption — if adoption were not first.
    await observer.activityRecord.delete({ where: { id: record.id } });
    gate.resolve();
    const refused = await upload;

    expect(refused).toBeInstanceOf(UploadExpiredError);
    expect(await objectExists(observer, EVIDENCE_BUCKET, intent.objectPath)).toBe(false);
    expect(await intents()).toEqual([]);
  });
});

describe('LP1-02 — deleting evidence, failed at each boundary', () => {
  it('detaching the last link while Storage fails: the file is gone and audited, its bytes wait as an intent, a sweep removes them', async () => {
    quiet();
    const record = await draft();
    const file = await uploaded([record.id]);
    vi.spyOn(storage, 'remove').mockRejectedValueOnce(new Error(INJECTED));

    const res = await lifecycleServices(a, storage).evidence.detach(tenant.users.dataEntry, record.id, file.id);

    expect(res.fileDeleted).toBe(true);
    expect(await observer.evidence.count({ where: { id: file.id } })).toBe(0);
    expect(await observer.auditLog.count({ where: { entityId: file.id, action: 'delete' } })).toBe(1);
    expect(await objectExists(observer, EVIDENCE_BUCKET, file.storagePath)).toBe(true);
    const [intent] = await intents();
    expect(intent).toMatchObject({ kind: 'delete', objectPath: file.storagePath, reason: 'evidence.unlinked', attempts: 1 });

    await makeDue();
    await sweeper().sweep();
    expect(await objectExists(observer, EVIDENCE_BUCKET, file.storagePath)).toBe(false);
    expect(await intents()).toEqual([]);
  });

  it('DELETE /evidence/:id, the process dying after the commit: the intent waits, unclaimed, and a sweep removes the bytes', async () => {
    const record = await draft();
    const file = await uploaded([record.id]);
    const services = lifecycleServices(a, storage);
    // The commit happened; the post-commit removal never ran.
    vi.spyOn(services.intents, 'runNow').mockResolvedValueOnce(undefined);

    await services.evidence.remove(tenant.users.dataEntry, file.id);

    expect(await observer.evidence.count({ where: { id: file.id } })).toBe(0);
    expect(await objectExists(observer, EVIDENCE_BUCKET, file.storagePath)).toBe(true);
    expect(await intents()).toMatchObject([
      { kind: 'delete', objectPath: file.storagePath, reason: 'evidence.delete', attempts: 0, claimedUntil: null },
    ]);

    // Due at once — a delete intent waits for no backoff until it has failed.
    const report = await sweeper().sweep();
    expect(report.removed).toBeGreaterThanOrEqual(1);
    expect(await objectExists(observer, EVIDENCE_BUCKET, file.storagePath)).toBe(false);
    expect(await intents()).toEqual([]);
  });

  it('a record delete while Storage fails: record and file are gone, their bytes wait as an intent, a sweep removes them', async () => {
    quiet();
    const record = await draft();
    const file = await uploaded([record.id]);
    vi.spyOn(storage, 'remove').mockRejectedValueOnce(new Error(INJECTED));

    await lifecycleServices(a, storage).records.remove(tenant.users.dataEntry, record.id);

    expect(await observer.activityRecord.count({ where: { id: record.id } })).toBe(0);
    expect(await observer.evidence.count({ where: { id: file.id } })).toBe(0);
    expect(await objectExists(observer, EVIDENCE_BUCKET, file.storagePath)).toBe(true);
    expect(await intents()).toHaveLength(1);

    await makeDue();
    await sweeper().sweep();
    expect(await objectExists(observer, EVIDENCE_BUCKET, file.storagePath)).toBe(false);
    expect(await intents()).toEqual([]);
  });

  it('the delete transaction fails: no intent is left, and the row keeps its bytes', async () => {
    quiet();
    const record = await draft();
    const file = await uploaded([record.id]);

    const results = await Promise.all([
      outcome(lifecycleServices(failingAuditClient(a), storage).evidence.remove(tenant.users.dataEntry, file.id)),
    ]);
    expect(results[0]).toBeInstanceOf(Error);
    const detach = await outcome(
      lifecycleServices(failingAuditClient(a), storage).evidence.detach(tenant.users.dataEntry, record.id, file.id),
    );
    expect(detach).toBeInstanceOf(Error);

    await expectIntactBytes(await observer.evidence.findUniqueOrThrow({ where: { id: file.id } }));
    expect(await intents()).toEqual([]);
  });

  it('Storage confirms but closing the intent fails: the lease runs out, a sweep removes again (idempotently) and closes it', async () => {
    quiet();
    const record = await draft();
    const file = await uploaded([record.id]);
    const services = lifecycleServices(a, storage);
    // The detach commits; its own post-commit removal is replaced by one on a
    // client whose first raw statement — the conditional close — fails.
    vi.spyOn(services.intents, 'runNow').mockResolvedValueOnce(undefined);
    await services.evidence.detach(tenant.users.dataEntry, record.id, file.id);
    const flaky = connect();
    try {
      const close = vi.spyOn(flaky, '$executeRaw').mockRejectedValueOnce(new Error('injected close failure'));
      await sweeper(flaky).runNow([{ bucket: EVIDENCE_BUCKET, path: file.storagePath }]);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await flaky.$disconnect();
    }

    expect(await objectExists(observer, EVIDENCE_BUCKET, file.storagePath)).toBe(false);
    const [claimed] = await intents();
    expect(claimed.claimedUntil!.getTime()).toBeGreaterThan(Date.now());
    // Still leased: a sweep leaves it alone.
    expect((await sweeper().sweep()).removed).toBe(0);
    expect(await intents()).toHaveLength(1);

    await makeDue();
    expect((await sweeper().sweep()).removed).toBeGreaterThanOrEqual(1);
    expect(await intents()).toEqual([]);
  });
});

describe('LP1-02 — the sweeper: bounded, observable, safe', () => {
  /** `n` real objects under the tenant's prefix, each with a due delete intent. */
  async function dueDeletes(n: number) {
    const paths = Array.from({ length: n }, (_, i) => `${tenant.subsidiaryId}/due-${i}.pdf`);
    for (const path of paths) {
      await storage.upload(EVIDENCE_BUCKET, path, Buffer.from(`%PDF-1.4 ${path}`), 'application/pdf');
    }
    // One statement each: distinct next_attempt_at, so claim order is the
    // insertion order and a bound test cannot pass by the luck of uuids.
    for (const path of paths) {
      await sweeper(observer).enqueueDeletes(observer, [{ bucket: EVIDENCE_BUCKET as Bucket, path }], {
        reason: 'test',
        subsidiaryId: tenant.subsidiaryId,
      });
    }
    return paths;
  }

  it('one enqueue naming an object twice writes one intent (a duplicate would be a statement error)', async () => {
    const path = `${tenant.subsidiaryId}/twice.pdf`;
    const ref = { bucket: EVIDENCE_BUCKET as Bucket, path };
    await sweeper(observer).enqueueDeletes(observer, [ref, ref], { reason: 'test' });
    expect(await intents()).toHaveLength(1);
  });

  it('two sweepers at once remove each object exactly once', async () => {
    const paths = await dueDeletes(6);
    const first = localStorage();
    const second = localStorage();
    const removedBy = [vi.spyOn(first, 'remove'), vi.spyOn(second, 'remove')];

    await Promise.all([sweeper(a, first).sweep(), sweeper(b, second).sweep()]);

    const removed = removedBy.flatMap((spy) => spy.mock.calls.flatMap(([, p]) => p as string[]));
    expect(removed.sort()).toEqual([...paths].sort());
    expect(await evidenceObjects()).toEqual([]);
    expect(await intents()).toEqual([]);
  });

  it('an intent written a moment ago is due for the very next statement — its time is never rounded past now()', async () => {
    // Measured at timestamptz(3): 64 of 300 intents read as not yet due in the
    // next statement, because a default of now() rounds UP to the millisecond.
    for (let i = 0; i < 100; i += 1) {
      const path = `${tenant.subsidiaryId}/tick-${i}`;
      await sweeper(observer).enqueueDeletes(observer, [{ bucket: EVIDENCE_BUCKET, path }], { reason: 'test' });
      const [{ due }] = await observer.$queryRaw<{ due: boolean }[]>`
        SELECT next_attempt_at <= now() AS due FROM storage_intents WHERE object_path = ${path}`;
      expect(due, `intent ${i}`).toBe(true);
    }
  });

  it('one sweep handles at most its limit, and reports what waits', async () => {
    await dueDeletes(5);
    const report = await sweeper().sweep(2);
    expect(report.removed).toBe(2);
    expect(report.backlog.deletes).toBe(3);
    expect(await evidenceObjects()).toHaveLength(3);
  });

  it('the bound holds under a plan that rescans the claim — 2 of 5, not 5 (`qa-auditor`)', async () => {
    quiet();
    const due = await dueDeletes(5);
    const stale = Array.from({ length: 5 }, (_, i) => `${tenant.subsidiaryId}/stale-${i}.pdf`);
    for (const path of stale) {
      await sweeper(observer).beginUpload({ bucket: EVIDENCE_BUCKET, path }, { reason: 'test' });
    }
    await observer.$executeRaw`
      UPDATE storage_intents
      SET created_at = now() - ${UPLOAD_GRACE_SECONDS + 60}::int * interval '1 second'
      WHERE kind = 'upload' AND starts_with(object_path, ${`${tenant.subsidiaryId}/stale-`})`;
    // The plan that made `WHERE id IN (SELECT … LIMIT n)` take n more per rescan.
    const forced = connect();
    try {
      for (const setting of ['enable_material', 'enable_hashagg', 'enable_sort', 'enable_hashjoin', 'enable_mergejoin']) {
        await forced.$executeRawUnsafe(`SET ${setting} = off`);
      }
      const report = await sweeper(forced).sweep(2);
      expect(report.abandoned).toBe(2);
      expect(report.removed).toBe(2);
    } finally {
      await forced.$disconnect();
    }
    expect((await evidenceObjects()).map((o) => o.path).filter((p) => due.includes(p))).toHaveLength(3);
    expect((await intents()).filter((i) => i.kind === 'upload')).toHaveLength(3);
  });

  it('the abandon bound holds under a plan that rescans it — with an index a future query could add (`qa-auditor`)', async () => {
    // Oldest first, each dated right after its insert: physical order is created_at order.
    for (let i = 0; i < 5; i += 1) {
      const path = `${tenant.subsidiaryId}/stale-${i}.pdf`;
      await sweeper(observer).beginUpload({ bucket: EVIDENCE_BUCKET, path }, { reason: 'test' });
      await observer.$executeRaw`
        UPDATE storage_intents
        SET created_at = now() - ${UPLOAD_GRACE_SECONDS + 600 - i * 60}::int * interval '1 second'
        WHERE object_path = ${path}`;
    }
    class Rollback extends Error {}
    // The owner: only it may create an index, even one rolled back.
    const forced = connectOwner();
    let abandoned = -1;
    try {
      await forced
        .$transaction(async (tx) => {
          // Rolled back with the test: the index that made `WHERE id IN (SELECT … LIMIT 2)` abandon 5.
          await tx.$executeRawUnsafe('CREATE INDEX lp1_02_probe_kind_created ON storage_intents (kind, created_at)');
          for (const setting of ['enable_material', 'enable_hashagg', 'enable_sort', 'enable_hashjoin', 'enable_mergejoin']) {
            await tx.$executeRawUnsafe(`SET LOCAL ${setting} = off`);
          }
          abandoned = await sweeper(tx as unknown as PrismaService).abandonStale(2);
          throw new Rollback();
        })
        .catch((error: unknown) => {
          if (!(error instanceof Rollback)) throw error;
        });
    } finally {
      await forced.$disconnect();
    }
    expect(abandoned).toBe(2);
  });

  it('a failing removal backs off exponentially, never gives up, and is reported as stuck', async () => {
    quiet();
    const errors = vi.mocked(Logger.prototype.error);
    const [path] = await dueDeletes(1);
    const failing = localStorage();
    vi.spyOn(failing, 'remove').mockRejectedValue(new Error(INJECTED));

    const waits: number[] = [];
    let report;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await makeDue();
      report = await sweeper(b, failing).sweep();
      const [{ wait, attempts }] = await observer.$queryRaw<{ wait: number; attempts: number }[]>`
        SELECT extract(epoch FROM next_attempt_at - now())::float8 AS wait, attempts
        FROM storage_intents WHERE object_path = ${path}`;
      expect(attempts).toBe(attempt);
      waits.push(Math.round(wait / 30));
    }
    // 30 s, 60 s, 120 s, 240 s, 480 s — in units of the 30 s base.
    expect(waits).toEqual([1, 2, 4, 8, 16]);
    expect(report!.backlog.stuck).toBeGreaterThanOrEqual(1);
    expect(errors.mock.calls.some(([m]) => String(m).includes('have failed 5 or more times'))).toBe(true);
    expect(await objectExists(observer, EVIDENCE_BUCKET, path)).toBe(true);
  });

  it('STORAGE_CLEANUP_HOLD: nothing is removed and the intents wait; lifted, the next sweep removes them', async () => {
    quiet();
    const paths = await dueDeletes(2);
    vi.stubEnv('STORAGE_CLEANUP_HOLD', 'true');

    const held = await sweeper().sweep();
    expect(held).toMatchObject({ held: true, removed: 0 });
    expect(held.backlog.deletes).toBeGreaterThanOrEqual(2);
    await sweeper().runNow(paths.map((path) => ({ bucket: EVIDENCE_BUCKET as Bucket, path })));
    expect(await evidenceObjects()).toHaveLength(2);

    vi.unstubAllEnvs();
    await sweeper().sweep();
    expect(await evidenceObjects()).toEqual([]);
  });

  it('an intent naming bytes a row owns: the bytes are kept, the intent closed and reported', async () => {
    quiet();
    const record = await draft();
    const file = await uploaded([record.id]);
    // A row and an intent that disagree — e.g. a database restored to before the delete.
    await sweeper().enqueueDeletes(observer, [{ bucket: EVIDENCE_BUCKET, path: file.storagePath }], {
      reason: 'test',
      subsidiaryId: tenant.subsidiaryId,
    });

    const report = await sweeper().sweep();

    expect(report.kept).toBe(1);
    await expectIntactBytes(file);
    expect(await intents()).toEqual([]);
  });

  it('Storage never overwrites an object: a second write to a key is refused and the first bytes stay', async () => {
    const path = `${tenant.subsidiaryId}/written-once.pdf`;
    const original = Buffer.from('%PDF-1.4 original');
    await storage.upload(EVIDENCE_BUCKET, path, original, 'application/pdf');
    await expect(
      storage.upload(EVIDENCE_BUCKET, path, Buffer.from('%PDF-1.4 replaced'), 'application/pdf'),
    ).rejects.toThrow(/already exists/);
    expect(sha256(await storage.download(EVIDENCE_BUCKET, path))).toBe(sha256(original));
  });

  it('refuses to remove under a database role that RLS filters — "no row owns it" would be a guess', async () => {
    // `observer` is the runtime role (LP1-03): BYPASSRLS, so it sees every row.
    expect(await sweeper(observer).seesEveryRow()).toBe(true);
    // The owner, because only a member of `authenticated` may assume it.
    const restricted = connectOwner();
    try {
      await restricted.$executeRawUnsafe('SET ROLE authenticated');
      // The same question under RLS: this role sees no evidence row at all.
      expect(await restricted.evidence.count()).toBe(0);
      expect(await sweeper(restricted).seesEveryRow()).toBe(false);
    } finally {
      await restricted.$disconnect();
    }
  });

  it('an import source a batch owns is kept too, whatever an intent says — the guard asks the right table', async () => {
    quiet();
    const report = await importer(a).import(tenant.users.dataEntry, importCsv(), { dryRun: false });
    const batch = await observer.importBatch.findUniqueOrThrow({ where: { id: report.batchId! } });
    await sweeper().enqueueDeletes(observer, [{ bucket: IMPORT_SOURCES_BUCKET, path: batch.storagePath! }], {
      reason: 'test',
      organisationId: tenant.organisationId,
    });

    expect((await sweeper().sweep()).kept).toBe(1);
    expect(sha256(await storage.download(IMPORT_SOURCES_BUCKET, batch.storagePath!))).toBe(batch.sha256);
  });

  it('the visibility check covers Storage\'s catalogue too — seeing every owning row is not enough', async () => {
    class Rollback extends Error {}
    // The owner: it alone may alter the tables and assume `authenticated`.
    const restricted = connectOwner();
    let seen: boolean | null = null;
    try {
      await restricted
        .$transaction(async (tx) => {
          // Rolled back: this role now sees every evidence and import_batches row, but not storage.objects.
          await tx.$executeRawUnsafe('ALTER TABLE evidence DISABLE ROW LEVEL SECURITY');
          await tx.$executeRawUnsafe('ALTER TABLE import_batches DISABLE ROW LEVEL SECURITY');
          await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
          seen = await sweeper(observer).seesEveryRow(tx);
          throw new Rollback();
        })
        .catch((error: unknown) => {
          if (!(error instanceof Rollback)) throw error;
        });
    } finally {
      await restricted.$disconnect();
    }
    expect(seen).toBe(false);
  });

  it('never removes an orphan — an object no row owns and no intent names', async () => {
    const path = `${tenant.subsidiaryId}/orphan.pdf`;
    await storage.upload(EVIDENCE_BUCKET, path, Buffer.from('%PDF-1.4\n'), 'application/pdf');
    await sweeper().sweep();
    expect(await objectExists(observer, EVIDENCE_BUCKET, path)).toBe(true);
  });
});

describe('LP1-02 — reconciliation: both directions', () => {
  const ALL = { limit: 100_000 };

  function reconcile() {
    return new StorageReconcileService(b, storage, sweeper());
  }

  it('reports orphans, rows whose object is gone, and bytes that no longer match the stored hash', async () => {
    const record = await draft();
    const gone = await uploaded([record.id]);
    const changed = await uploaded([record.id]);
    const orphan = `${tenant.subsidiaryId}/orphan.pdf`;
    await storage.upload(EVIDENCE_BUCKET, orphan, Buffer.from('%PDF-1.4\n'), 'application/pdf');
    await storage.remove(EVIDENCE_BUCKET, [gone.storagePath]);
    await storage.remove(EVIDENCE_BUCKET, [changed.storagePath]);
    await storage.upload(EVIDENCE_BUCKET, changed.storagePath, Buffer.from('%PDF-1.4 tampered'), 'application/pdf');

    const orphans = await reconcile().orphans(EVIDENCE_BUCKET, ALL);
    expect(orphans.map((o) => o.path)).toContain(orphan);
    expect(orphans.map((o) => o.path)).not.toContain(changed.storagePath);

    const missing = await reconcile().missingObjects(EVIDENCE_BUCKET, ALL);
    expect(missing.find((m) => m.rowId === gone.id)).toMatchObject({
      problem: 'no-object',
      records: [{ id: record.id, status: ActivityRecordStatus.draft }],
    });

    const verified = await reconcile().verifyHashes(EVIDENCE_BUCKET, ALL);
    const mine = verified.problems.filter((p) => p.path.startsWith(`${tenant.subsidiaryId}/`));
    expect(mine.map((p) => [p.rowId, p.problem]).sort()).toEqual(
      [
        [changed.id, 'hash-mismatch'],
        [gone.id, 'no-object'],
      ].sort(),
    );
  });

  it('does not count an import source its batch owns as an orphan — nor reclaim it', async () => {
    quiet();
    const report = await importer(a).import(tenant.users.dataEntry, importCsv(), { dryRun: false });
    const batch = await observer.importBatch.findUniqueOrThrow({ where: { id: report.batchId! } });
    expect((await reconcile().orphans(IMPORT_SOURCES_BUCKET, ALL)).map((o) => o.path)).not.toContain(batch.storagePath);
    await reconcile().reclaimOrphans(IMPORT_SOURCES_BUCKET, 0, 100_000, tenantPrefixes(tenant)['import-sources']);
    expect(sha256(await storage.download(IMPORT_SOURCES_BUCKET, batch.storagePath!))).toBe(batch.sha256);
  });

  it('pages rows missing their object by id, too', async () => {
    const record = await draft();
    const first = await uploaded([record.id]);
    const second = await uploaded([record.id]);
    await storage.remove(EVIDENCE_BUCKET, [first.storagePath, second.storagePath]);
    const mine = new Set([first.id, second.id]);
    const page1 = (await reconcile().missingObjects(EVIDENCE_BUCKET, { limit: 1 })).filter((m) => mine.has(m.rowId));
    expect(page1).toHaveLength(1);
    const page2 = (await reconcile().missingObjects(EVIDENCE_BUCKET, { limit: 1, after: page1[0].rowId })).filter((m) =>
      mine.has(m.rowId),
    );
    expect(page2).toHaveLength(1);
    expect(page2[0].rowId).not.toBe(page1[0].rowId);
  });

  it('pages its checks by id: each page starts after the last', async () => {
    const record = await draft();
    await uploaded([record.id]);
    await uploaded([record.id]);
    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const result = await reconcile().verifyHashes(EVIDENCE_BUCKET, { limit: 1, after });
      expect(result.checked).toBe(1);
      after = result.last!;
      seen.push(after);
    }
    expect(new Set(seen).size).toBe(3);
    expect([...seen].sort()).toEqual(seen);
  });

  it('reclaims only under the prefix it is given — another key\'s orphan is left alone', async () => {
    quiet();
    const mine = `${tenant.subsidiaryId}/mine.pdf`;
    // Outside the tenant's evidence prefix (its organisation id, not its subsidiary's).
    const other = `${tenant.organisationId}/not-mine.pdf`;
    for (const path of [mine, other]) {
      await storage.upload(EVIDENCE_BUCKET, path, Buffer.from('%PDF-1.4\n'), 'application/pdf');
    }
    try {
      await reconcile().reclaimOrphans(EVIDENCE_BUCKET, 0, 1000, tenantPrefixes(tenant).evidence);
      expect(await objectExists(observer, EVIDENCE_BUCKET, mine)).toBe(false);
      expect(await objectExists(observer, EVIDENCE_BUCKET, other)).toBe(true);
    } finally {
      await localStorage().remove(EVIDENCE_BUCKET, [other]);
    }
  });

  it('does not count an in-flight upload as an orphan', async () => {
    const path = `${tenant.subsidiaryId}/in-flight.pdf`;
    await sweeper().beginUpload({ bucket: EVIDENCE_BUCKET, path }, { reason: 'evidence.upload' });
    await storage.upload(EVIDENCE_BUCKET, path, Buffer.from('%PDF-1.4\n'), 'application/pdf');
    expect((await reconcile().orphans(EVIDENCE_BUCKET, ALL)).map((o) => o.path)).not.toContain(path);
  });

  it('after a restore, forgetting upload intents turns their objects into reported orphans — only under the hold', async () => {
    const path = `${tenant.subsidiaryId}/restored-in-flight.pdf`;
    // As restored from the restore point: an upload in flight then, committed later in a lost history.
    await sweeper().beginUpload({ bucket: EVIDENCE_BUCKET, path }, { reason: 'evidence.upload' });
    await storage.upload(EVIDENCE_BUCKET, path, Buffer.from('%PDF-1.4 only copy'), 'application/pdf');

    // A removal the restored database had committed to: it must survive the forget.
    const pendingDelete = `${tenant.subsidiaryId}/pending-delete.pdf`;
    await sweeper().enqueueDeletes(observer, [{ bucket: EVIDENCE_BUCKET, path: pendingDelete }], { reason: 'test' });

    await expect(reconcile().forgetUploadIntents()).rejects.toThrow(/STORAGE_CLEANUP_HOLD/);
    vi.stubEnv('STORAGE_CLEANUP_HOLD', '1');
    const forgotten = await reconcile().forgetUploadIntents();
    expect(forgotten).toContainEqual({ bucket: EVIDENCE_BUCKET, path });
    expect(forgotten).not.toContainEqual({ bucket: EVIDENCE_BUCKET, path: pendingDelete });
    vi.unstubAllEnvs();
    expect((await intents()).map((i) => [i.objectPath, i.kind])).toEqual([[pendingDelete, 'delete']]);
    await observer.storageIntent.deleteMany({ where: { objectPath: pendingDelete } });

    // The hold is lifted: no intent is left to abandon, so the bytes stay — for a person to judge.
    expect(await intents()).toEqual([]);
    await sweeper().sweep();
    expect(await objectExists(observer, EVIDENCE_BUCKET, path)).toBe(true);
    expect((await reconcile().orphans(EVIDENCE_BUCKET, ALL)).map((o) => o.path)).toContain(path);
  });

  it('reclaims only orphans past the age threshold, never while STORAGE_CLEANUP_HOLD is set', async () => {
    quiet();
    const path = `${tenant.subsidiaryId}/orphan.pdf`;
    await storage.upload(EVIDENCE_BUCKET, path, Buffer.from('%PDF-1.4\n'), 'application/pdf');

    // A minute old, against a one-hour threshold: kept.
    expect((await reconcile().reclaimOrphans(EVIDENCE_BUCKET, 1, 1000, tenantPrefixes(tenant).evidence)).reclaimed.map((o) => o.path)).not.toContain(path);
    expect(await objectExists(observer, EVIDENCE_BUCKET, path)).toBe(true);

    vi.stubEnv('STORAGE_CLEANUP_HOLD', '1');
    await expect(reconcile().reclaimOrphans(EVIDENCE_BUCKET, 0, 1000, tenantPrefixes(tenant).evidence)).rejects.toThrow(/STORAGE_CLEANUP_HOLD/);
    expect(await objectExists(observer, EVIDENCE_BUCKET, path)).toBe(true);
    vi.unstubAllEnvs();

    const { reclaimed } = await reconcile().reclaimOrphans(EVIDENCE_BUCKET, 0, 1000, tenantPrefixes(tenant).evidence);
    expect(reclaimed.map((o) => o.path)).toContain(path);
    expect(await objectExists(observer, EVIDENCE_BUCKET, path)).toBe(false);
    expect(await intents()).toEqual([]);
  });
});

describe('LP1-02 — concurrent approval cannot silently lose evidence (real Storage)', () => {
  /** A held, B runs, A released once B has settled or is blocked — the LP1-01 race, on real Storage. */
  async function race(
    hold: [Prisma.ModelName, string | string[]],
    first: (s: ReturnType<typeof lifecycleServices>) => Promise<unknown>,
    second: (s: ReturnType<typeof lifecycleServices>) => Promise<unknown>,
  ) {
    const held = holdBefore(a, hold[0], hold[1]);
    const pidB = await backendPid(b);
    const firstOutcome = outcome(first(lifecycleServices(held.client, storage)));
    await held.reached();
    const secondPromise = second(lifecycleServices(b, storage));
    const secondOutcome = outcome(secondPromise);
    const how = await settledOrBlocked(secondPromise, pidB, observer);
    held.release();
    return { first: await firstOutcome, second: await secondOutcome, how };
  }

  /** Every record that left draft has every file it links, with bytes that hash to the row. */
  async function committedRecordsKeepTheirBytes() {
    const links = await observer.activityRecordEvidence.findMany({
      where: {
        subsidiaryId: tenant.subsidiaryId,
        activityRecord: { status: { notIn: [ActivityRecordStatus.draft, ActivityRecordStatus.rejected] } },
      },
      include: { evidence: true },
    });
    for (const link of links) await expectIntactBytes(link.evidence);
    return links.length;
  }

  async function sharedFile() {
    const first = await draft();
    const second = await draft({ periodValue: 'February' });
    const file = await uploaded([first.id, second.id]);
    return { first, second, file };
  }

  it('a submit held before its write: the delete waits and is refused — the approved record keeps its bytes', async () => {
    const { first, file } = await sharedFile();
    const r = await race(
      ['ActivityRecord', ['update', 'updateMany']],
      (s) => s.records.submit(tenant.users.dataEntry, first.id),
      (s) => s.evidence.remove(tenant.users.dataEntry, file.id),
    );
    expect(r.how).toBe('blocked');
    expect(r.first).toBe('ok');
    expect(r.second).toBeInstanceOf(RecordChangedError);

    await lifecycleServices(b, storage).records.approve(tenant.users.superAdmin, first.id);
    expect((await observer.activityRecord.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
      ActivityRecordStatus.approved,
    );
    expect(await committedRecordsKeepTheirBytes()).toBe(1);
    expect(await intents()).toEqual([]);
  });

  it('a delete held before its write: the submit waits and is refused — no record leaves draft without its file', async () => {
    const { first, file } = await sharedFile();
    const r = await race(
      ['Evidence', ['delete', 'deleteMany']],
      (s) => s.evidence.remove(tenant.users.dataEntry, file.id),
      (s) => s.records.submit(tenant.users.dataEntry, first.id),
    );
    expect(r.how).toBe('blocked');
    expect(r.first).toBe('ok');
    expect(r.second).toBeInstanceOf(EvidenceRequiredError);
    expect((await observer.activityRecord.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
      ActivityRecordStatus.draft,
    );
    expect(await objectExists(observer, EVIDENCE_BUCKET, file.storagePath)).toBe(false);
    expect(await committedRecordsKeepTheirBytes()).toBe(0);
    expect(await intents()).toEqual([]);
  });
});

describe('LP1-02 — an applied import\'s source file, failed at each boundary', () => {
  const csv = importCsv;

  async function sources() {
    return (await tenantObjects(observer, tenant)).filter((o) => o.bucket === IMPORT_SOURCES_BUCKET);
  }

  async function batches() {
    return observer.importBatch.findMany({ where: { organisationId: tenant.organisationId } });
  }

  it('an apply keeps the file under its batch, with bytes that hash to the batch row', async () => {
    quiet();
    const report = await importer(a).import(tenant.users.dataEntry, csv(), { dryRun: false });
    const [batch] = await batches();
    expect(batch.id).toBe(report.batchId);
    expect(sha256(await storage.download(IMPORT_SOURCES_BUCKET, batch.storagePath!))).toBe(batch.sha256);
    expect(await intents()).toEqual([]);
  });

  it('Storage refuses the file: no batch, no object, no intent', async () => {
    quiet();
    vi.spyOn(storage, 'upload').mockRejectedValueOnce(new Error(INJECTED));
    expect(await outcome(importer(a).import(tenant.users.dataEntry, csv(), { dryRun: false }))).toBeInstanceOf(Error);
    expect(await batches()).toEqual([]);
    expect(await sources()).toEqual([]);
    expect(await intents()).toEqual([]);
  });

  it('the batch row cannot be written: the file is removed and the intent closed', async () => {
    quiet();
    const noBatch = a.$extends({
      query: {
        importBatch: {
          async create() {
            throw new Error('injected batch failure');
          },
        },
      },
    }) as unknown as PrismaService;
    expect(await outcome(importer(noBatch).import(tenant.users.dataEntry, csv(), { dryRun: false }))).toBeInstanceOf(
      Error,
    );
    expect(await batches()).toEqual([]);
    expect(await sources()).toEqual([]);
    expect(await intents()).toEqual([]);
  });

  it('the batch row cannot be written AND the removal fails: the file waits as an intent, a sweep removes it', async () => {
    quiet();
    const noBatch = a.$extends({
      query: {
        importBatch: {
          async create() {
            throw new Error('injected batch failure');
          },
        },
      },
    }) as unknown as PrismaService;
    vi.spyOn(storage, 'remove').mockRejectedValueOnce(new Error(INJECTED));

    await outcome(importer(noBatch).import(tenant.users.dataEntry, csv(), { dryRun: false }));

    const [left] = await sources();
    expect(left).toBeDefined();
    expect(await intents()).toMatchObject([{ kind: 'delete', objectPath: left.path, reason: 'import.source' }]);
    await makeDue();
    await sweeper().sweep();
    expect(await sources()).toEqual([]);
    expect(await intents()).toEqual([]);
  });
});
