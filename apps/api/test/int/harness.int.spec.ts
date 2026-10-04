import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  backendPid,
  connect,
  connectOwner,
  countTenantRows,
  createRecord,
  createTenant,
  deferred,
  holdBefore,
  settledOrBlocked,
  withRollback,
  type Tenant,
} from './db';

// Proves the harness itself: rollback isolation, tenant teardown, the barrier
// and lock-wait detection. Each would make a later race test pass or fail for
// the wrong reason if it did not work.

let a: PrismaService;
let b: PrismaService;
let observer: PrismaService;

beforeAll(() => {
  a = connect();
  b = connect();
  observer = connect();
});

afterAll(async () => {
  await Promise.all([a, b, observer].map((c) => c.$disconnect()));
});

describe('withRollback', () => {
  it('leaves no row behind, though the row existed inside the transaction', async () => {
    const legalName = `Int-test rollback ${Date.now()}`;
    // Organisations are the owner's to create (the runtime role reads them).
    const owner = connectOwner();
    let seen: { id: string; insideTx: number; otherConnection: number };
    try {
      seen = await withRollback(owner, async (tx) => {
        const org = await tx.organisation.create({
          data: { legalName, country: 'GB', geographyCode: 'UK' },
        });
        return {
          id: org.id,
          insideTx: await tx.organisation.count({ where: { id: org.id } }),
          // Another connection must not see an uncommitted row.
          otherConnection: await observer.organisation.count({ where: { id: org.id } }),
        };
      });
    } finally {
      await owner.$disconnect();
    }

    expect(seen.insideTx).toBe(1);
    expect(seen.otherConnection).toBe(0);
    expect(await a.organisation.count({ where: { id: seen.id } })).toBe(0);
    expect(await b.organisation.count({ where: { legalName } })).toBe(0);
  });

  it('still rethrows a real error from the callback', async () => {
    await expect(
      withRollback(a, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('createTenant', () => {
  it('cleanup() removes every row the tenant created, audit rows included', async () => {
    const tenant = await createTenant();
    await createRecord(a, tenant);
    await a.auditLog.create({
      data: {
        userId: tenant.users.superAdmin.id,
        organisationId: tenant.organisationId,
        role: 'super_admin',
        action: 'create',
        entity: 'activity_record',
      },
    });
    expect(await countTenantRows(a, tenant)).toEqual({
      organisations: 1,
      subsidiaries: 1,
      profiles: 4,
      grants: 1,
      records: 1,
      audit: 1,
    });

    await tenant.cleanup();

    expect(await countTenantRows(a, tenant)).toEqual({
      organisations: 0,
      subsidiaries: 0,
      profiles: 0,
      grants: 0,
      records: 0,
      audit: 0,
    });
  });
});

describe('interleaving', () => {
  let tenant: Tenant;

  beforeEach(async () => {
    tenant = await createTenant();
  });

  afterEach(async () => {
    await tenant.cleanup();
  });

  it('holdBefore stops request A between its read and its write while B completes', async () => {
    const record = await createRecord(a, tenant, { activityValue: 100 });
    const hold = holdBefore(a, 'ActivityRecord', 'update');

    // A: read-check-write, the shape of every lifecycle method.
    const requestA = (async () => {
      const read = await hold.client.activityRecord.findUniqueOrThrow({ where: { id: record.id } });
      await hold.client.activityRecord.update({
        where: { id: record.id },
        data: { activityValue: read.activityValue + 1 },
      });
    })();

    await hold.reached();
    await b.activityRecord.update({ where: { id: record.id }, data: { activityValue: 500 } });
    hold.release();
    await requestA;

    // A wrote from its stale read after B committed: the lost update the
    // barrier exists to reproduce.
    const final = await b.activityRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(final.activityValue).toBe(101);
  });

  it('holdBefore fails fast when the held query is never reached', async () => {
    const hold = holdBefore(a, 'ActivityRecord', 'delete');
    await expect(hold.reached(50)).rejects.toThrow('never reached ActivityRecord.delete');
  });

  it('connect() clients hold one connection each, on distinct backends', async () => {
    const [pidA, pidA2, pidB] = [await backendPid(a), await backendPid(a), await backendPid(b)];
    expect(pidA2).toBe(pidA);
    expect(pidB).not.toBe(pidA);
  });

  it('settledOrBlocked sees request B waiting on A’s row lock', async () => {
    const record = await createRecord(a, tenant);
    const locked = deferred();
    const release = deferred();

    const requestA = a.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM activity_records WHERE id = ${record.id}::uuid FOR UPDATE`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const pidB = await backendPid(b);
    const requestB = b.activityRecord.update({
      where: { id: record.id },
      data: { activityValue: 7 },
    });
    expect(await settledOrBlocked(requestB, pidB, observer)).toBe('blocked');

    release.resolve();
    await requestA;
    await requestB;
    expect(await settledOrBlocked(requestB, pidB, observer)).toBe('settled');
  });
});
