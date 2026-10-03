import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { ActivityRecordStatus, type Prisma } from '@tonyai/db';
import {
  EvidenceRequiredError,
  PeriodLockedError,
  RecordChangedError,
} from '../../src/activity-records/errors';
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
import { lifecycleServices } from './services';

/**
 * F03 (Part C): lifecycle, period and evidence writers race.
 *
 * Each test holds request A just before its write — after every read and
 * check it makes — starts request B, and releases A once B has either
 * finished or is waiting on a lock. Under the lifecycle protocol
 * (`lifecycle-lock.ts`) B must be WAITING: A holds the period or row lock B
 * needs, so B's own checks run after A commits and see A's result. Each pair
 * runs in both orders. Every test asserts the final state is one a serial
 * order of the two calls could produce, that the loser got a typed refusal
 * (never a raw database error), and that the audit trail has one row per
 * successful call.
 *
 * Without the protocol B is not blocked: it finishes while A is held, A then
 * writes over B's result, and the final state is invalid — a submitted record
 * in a locked period, a record created into a closed period, a submitted
 * record whose evidence was detached, an edit landing on an approved record.
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
  tenant = await createTenant(a);
});

afterEach(async () => {
  await tenant.cleanup();
});

type Services = ReturnType<typeof lifecycleServices>;
type Outcome = 'ok' | unknown;

const outcome = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(
    () => 'ok' as const,
    (err: unknown) => err,
  );

/**
 * A is held just before its first `model.operation`; B runs; A is released
 * when B has settled or is blocked on a lock. Returns both outcomes and which
 * of the two B did.
 */
async function race(
  hold: [Prisma.ModelName, string | string[]],
  first: (s: Services) => Promise<unknown>,
  second: (s: Services) => Promise<unknown>,
) {
  const held = holdBefore(a, hold[0], hold[1]);
  const pidB = await backendPid(b);
  const firstOutcome = outcome(first(lifecycleServices(held.client)));
  await held.reached();
  const secondPromise = second(lifecycleServices(b));
  const secondOutcome = outcome(secondPromise);
  const how = await settledOrBlocked(secondPromise, pidB, observer);
  held.release();
  return { first: await firstOutcome, second: await secondOutcome, how };
}

async function statusOf(id: string) {
  return (await observer.activityRecord.findUniqueOrThrow({ where: { id } })).status;
}

async function auditActions(entityId: string) {
  const rows = await observer.auditLog.findMany({ where: { entityId }, select: { action: true } });
  return rows.map((r) => r.action).sort();
}

async function linkCount(recordId: string) {
  return observer.activityRecordEvidence.count({ where: { activityRecordId: recordId } });
}

async function lockCount() {
  return observer.periodLock.count({ where: { subsidiaryId: tenant.subsidiaryId } });
}

const january = {
  reportingYear: 2026,
  reportingPeriod: 'monthly',
  periodValue: 'January',
} as const;

const lockJanuary = (s: Services) =>
  s.periodLocks.lock(tenant.users.superAdmin, { subsidiaryId: tenant.subsidiaryId, ...january });

/** A draft the data-entry user can submit: an evidence-required category with its file. */
async function submittableDraft(data: Partial<Prisma.ActivityRecordUncheckedCreateInput> = {}) {
  const record = await createRecord(a, tenant, data);
  const file = await attachEvidence(a, tenant, [record.id]);
  return { record, file };
}

describe('F03 — edit, submit and approve', () => {
  // Water: an edit recomputes the calculation, and Water is the one category
  // that may be stored without an emission factor — so these tests do not
  // depend on the seed's factor library.
  const water = { category: 'Water', activityUnit: 'cubic_metres' };

  it('an edit held before its write: the submit waits, then validates and submits the edited figure', async () => {
    const { record } = await submittableDraft(water);
    const r = await race(
      ['ActivityRecord', ['update', 'updateMany']],
      (s) => s.records.update(tenant.users.dataEntry, record.id, { activityValue: 250 }),
      (s) => s.records.submit(tenant.users.dataEntry, record.id),
    );
    expect(r.how).toBe('blocked');
    expect(r).toMatchObject({ first: 'ok', second: 'ok' });

    await lifecycleServices(b).records.approve(tenant.users.superAdmin, record.id);
    const final = await observer.activityRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(final.status).toBe(ActivityRecordStatus.approved);
    expect(final.activityValue).toBe(250);
    expect(await auditActions(record.id)).toEqual(['approve', 'submit', 'update']);
    // The edit landed on the DRAFT, before the submit — not on the submitted
    // record after it, which is the same final row with an edit nobody
    // reviewed in between (what this interleaving did before LP1-01).
    const edit = await observer.auditLog.findFirstOrThrow({
      where: { entityId: record.id, action: 'update' },
    });
    expect((edit.diff as { after: { status: string } }).after.status).toBe(
      ActivityRecordStatus.draft,
    );
  });

  it('a submit held before its write: the edit waits, then is refused — the approved figure is the one submitted', async () => {
    const { record } = await submittableDraft(water);
    const r = await race(
      ['ActivityRecord', ['update', 'updateMany']],
      (s) => s.records.submit(tenant.users.dataEntry, record.id),
      (s) => s.records.update(tenant.users.dataEntry, record.id, { activityValue: 250 }),
    );
    expect(r.how).toBe('blocked');
    expect(r.first).toBe('ok');
    expect(r.second).toBeInstanceOf(RecordChangedError);

    await lifecycleServices(b).records.approve(tenant.users.superAdmin, record.id);
    const final = await observer.activityRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(final.status).toBe(ActivityRecordStatus.approved);
    expect(final.activityValue).toBe(record.activityValue);
    expect(await auditActions(record.id)).toEqual(['approve', 'submit']);
  });
});

describe('F03 — submit and period lock', () => {
  it('a submit held before its write: the lock waits, then counts the submitted record and refuses', async () => {
    const { record } = await submittableDraft();
    const r = await race(
      ['ActivityRecord', ['update', 'updateMany']],
      (s) => s.records.submit(tenant.users.dataEntry, record.id),
      lockJanuary,
    );
    expect(r.how).toBe('blocked');
    expect(r.first).toBe('ok');
    expect(r.second).toBeInstanceOf(ConflictException);
    expect((r.second as Error).message).toMatch(/awaiting review/);
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.submitted);
    expect(await lockCount()).toBe(0);
  });

  it('a lock held before its write: the submit waits, then finds the period closed', async () => {
    const { record } = await submittableDraft();
    const r = await race(['PeriodLock', 'create'], lockJanuary, (s) =>
      s.records.submit(tenant.users.dataEntry, record.id),
    );
    expect(r.how).toBe('blocked');
    expect(r.first).toBe('ok');
    expect(r.second).toBeInstanceOf(PeriodLockedError);
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.draft);
    expect(await lockCount()).toBe(1);
    expect(await auditActions(record.id)).toEqual([]);
  });
});

describe('F03 — create and period lock (a period with no lock row yet)', () => {
  const createWater = (s: Services) =>
    s.records.create(tenant.users.dataEntry, {
      subsidiaryId: tenant.subsidiaryId,
      ...january,
      category: 'Water',
      activityValue: 10,
      activityUnit: 'cubic_metres',
    });

  it('a create held before its insert: the lock waits, then closes the period over the new draft', async () => {
    const r = await race(['ActivityRecord', 'create'], createWater, lockJanuary);
    expect(r.how).toBe('blocked');
    expect(r).toMatchObject({ first: 'ok', second: 'ok' });
    // Serial order create → lock: a draft does not block a lock (only the
    // review queue and rejected records do), and it stays a draft.
    const records = await observer.activityRecord.findMany({ where: { subsidiaryId: tenant.subsidiaryId } });
    expect(records.map((x) => x.status)).toEqual([ActivityRecordStatus.draft]);
    expect(await lockCount()).toBe(1);
  });

  it('a lock held before its write: the create waits, then is refused — nothing is written into the closed period', async () => {
    const r = await race(['PeriodLock', 'create'], lockJanuary, createWater);
    expect(r.how).toBe('blocked');
    expect(r.first).toBe('ok');
    expect(r.second).toBeInstanceOf(PeriodLockedError);
    expect(await observer.activityRecord.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(0);
    expect(await lockCount()).toBe(1);
  });
});

describe('F03 — detach and submit', () => {
  it('a submit held before its write: the detach waits, then is refused — the record keeps the file it was submitted with', async () => {
    const { record, file } = await submittableDraft();
    const r = await race(
      ['ActivityRecord', ['update', 'updateMany']],
      (s) => s.records.submit(tenant.users.dataEntry, record.id),
      (s) => s.evidence.detach(tenant.users.dataEntry, record.id, file.id),
    );
    expect(r.how).toBe('blocked');
    expect(r.first).toBe('ok');
    expect(r.second).toBeInstanceOf(RecordChangedError);
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.submitted);
    expect(await linkCount(record.id)).toBe(1);
  });

  it('a detach held before its write: the submit waits, then counts no file and refuses', async () => {
    const { record, file } = await submittableDraft();
    const r = await race(
      ['ActivityRecordEvidence', 'deleteMany'],
      (s) => s.evidence.detach(tenant.users.dataEntry, record.id, file.id),
      (s) => s.records.submit(tenant.users.dataEntry, record.id),
    );
    expect(r.how).toBe('blocked');
    expect(r.first).toBe('ok');
    expect(r.second).toBeInstanceOf(EvidenceRequiredError);
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.draft);
    expect(await linkCount(record.id)).toBe(0);
  });
});

describe('F03 — deleting a shared file while one of its records goes to approval', () => {
  async function sharedFile() {
    const first = await createRecord(a, tenant);
    const second = await createRecord(a, tenant, { periodValue: 'February' });
    const file = await attachEvidence(a, tenant, [first.id, second.id]);
    return { first, second, file };
  }

  it('a submit held before its write: the delete waits, then is refused — the record is approved with its file', async () => {
    const { first, file } = await sharedFile();
    const r = await race(
      ['ActivityRecord', ['update', 'updateMany']],
      (s) => s.records.submit(tenant.users.dataEntry, first.id),
      (s) => s.evidence.remove(tenant.users.dataEntry, file.id),
    );
    expect(r.how).toBe('blocked');
    expect(r.first).toBe('ok');
    expect(r.second).toBeInstanceOf(RecordChangedError);

    await lifecycleServices(b).records.approve(tenant.users.superAdmin, first.id);
    expect(await statusOf(first.id)).toBe(ActivityRecordStatus.approved);
    expect(await linkCount(first.id)).toBe(1);
    expect(await observer.evidence.count({ where: { id: file.id } })).toBe(1);
  });

  it('a delete held before its write: the submit waits, then counts no file and refuses', async () => {
    const { first, second, file } = await sharedFile();
    const r = await race(
      ['Evidence', ['delete', 'deleteMany']],
      (s) => s.evidence.remove(tenant.users.dataEntry, file.id),
      (s) => s.records.submit(tenant.users.dataEntry, first.id),
    );
    expect(r.how).toBe('blocked');
    expect(r.first).toBe('ok');
    expect(r.second).toBeInstanceOf(EvidenceRequiredError);
    expect(await statusOf(first.id)).toBe(ActivityRecordStatus.draft);
    expect(await linkCount(first.id)).toBe(0);
    expect(await linkCount(second.id)).toBe(0);
  });
});

describe('F03 — void and period lock', () => {
  it('a lock held before its write: the void waits, then is refused — a locked figure is never voided', async () => {
    const record = await createRecord(a, tenant, { status: ActivityRecordStatus.approved });
    const r = await race(['PeriodLock', 'create'], lockJanuary, (s) =>
      s.records.void(tenant.users.superAdmin, record.id, 'Entered in error'),
    );
    expect(r.how).toBe('blocked');
    expect(r.first).toBe('ok');
    expect(r.second).toBeInstanceOf(RecordChangedError);
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.locked);
  });

  it('a void held before its write: the lock waits, then closes the period without the voided figure', async () => {
    const record = await createRecord(a, tenant, { status: ActivityRecordStatus.approved });
    const r = await race(
      ['ActivityRecord', ['update', 'updateMany']],
      (s) => s.records.void(tenant.users.superAdmin, record.id, 'Entered in error'),
      lockJanuary,
    );
    expect(r.how).toBe('blocked');
    expect(r).toMatchObject({ first: 'ok', second: 'ok' });
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.voided);
    expect(await lockCount()).toBe(1);
  });
});
