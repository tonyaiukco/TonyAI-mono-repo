import { randomUUID } from 'node:crypto';
import { ActivityRecordStatus, Prisma, UserRole } from '@tonyai/db';
import type { RequestUser } from '../../src/auth/auth.types';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * PostgreSQL integration-test helpers (LP0-03).
 *
 * Isolation does not depend on the shared seed. Two tools, chosen per test:
 *  - `withRollback` — for code that runs on a transaction client: everything the
 *    callback writes is rolled back, so the test leaves no row by construction.
 *  - `createTenant` — for code that owns its connection (services built on
 *    PrismaService, and every interleaving test, where two connections must see
 *    each other's commits): a synthetic organisation with fresh ids that no
 *    other test or seed row shares, deleted by `cleanup()`.
 */

/**
 * A new client holding exactly ONE connection, so "request A and request B on
 * two connections" is literal, and `backendPid` names the session a client's
 * queries run in. `connections` > 1 gives a pooled client instead, for a test
 * that must let a stray query outside a transaction reach the database (and
 * commit) rather than wait for the one connection the transaction holds.
 */
export function connect(connections = 1): PrismaService {
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.searchParams.set('connection_limit', String(connections));
  return new PrismaService({ datasourceUrl: url.toString() });
}

/** The PostgreSQL backend pid of a `connect()` client's single connection. */
export async function backendPid(client: PrismaService): Promise<number> {
  const [{ pid }] = await client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  return pid;
}

class RollbackSignal extends Error {}

/** Runs `fn` in a transaction that is always rolled back, and returns its result. */
export async function withRollback<T>(
  prisma: PrismaService,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      result = await fn(tx);
      throw new RollbackSignal();
    });
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
  return result as T;
}

export interface Tenant {
  organisationId: string;
  subsidiaryId: string;
  users: Record<'superAdmin' | 'consultant' | 'dataEntry', RequestUser>;
  /** Every id this tenant's rows can be found by, for cleanup and leak checks. */
  profileIds: string[];
  cleanup(): Promise<void>;
}

/** One organisation, one subsidiary, and a profile per workflow role. */
export const TENANT_ORG_PREFIX = 'Int-test org ';
export const TENANT_EMAIL_PATTERN = 'int-%@tonyai.test';

export async function createTenant(prisma: PrismaService): Promise<Tenant> {
  const tag = randomUUID().slice(0, 8);
  const organisation = await prisma.organisation.create({
    data: { legalName: `${TENANT_ORG_PREFIX}${tag}`, country: 'GB', geographyCode: 'UK' },
  });
  try {
    return await populateTenant(prisma, organisation.id, tag);
  } catch (err) {
    // A half-built tenant never reaches its caller's cleanup(); remove it here.
    await prisma.profile.deleteMany({ where: { email: { endsWith: `-${tag}@tonyai.test` } } });
    await prisma.organisation.delete({ where: { id: organisation.id } });
    throw err;
  }
}

async function populateTenant(
  prisma: PrismaService,
  organisationId: string,
  tag: string,
): Promise<Tenant> {
  const organisation = { id: organisationId };
  const subsidiary = await prisma.subsidiary.create({
    data: {
      organisationId: organisation.id,
      legalName: `Int-test subsidiary ${tag}`,
      geographyCode: 'UK',
    },
  });

  const makeUser = async (role: UserRole, label: string): Promise<RequestUser> => {
    const profile = await prisma.profile.create({
      data: {
        id: randomUUID(),
        email: `int-${label}-${tag}@tonyai.test`,
        fullName: `Int ${label} ${tag}`,
        role,
        organisationId: organisation.id,
      },
    });
    return {
      id: profile.id,
      email: profile.email,
      fullName: profile.fullName,
      role,
      organisationId: organisation.id,
      accessibleSubsidiaryIds: [subsidiary.id],
    };
  };

  const users = {
    superAdmin: await makeUser(UserRole.super_admin, 'admin'),
    consultant: await makeUser(UserRole.consultant, 'consultant'),
    dataEntry: await makeUser(UserRole.data_entry, 'entry'),
  };
  const profileIds = Object.values(users).map((u) => u.id);

  return {
    organisationId: organisation.id,
    subsidiaryId: subsidiary.id,
    users,
    profileIds,
    // Test-only teardown of a synthetic tenant's own rows. Audit rows are
    // matched by this tenant's organisation and profiles only, so no real
    // trail is touched; the organisation cascades to subsidiaries, records,
    // locks and evidence (not Storage objects — a test that uploads removes
    // its own). TRIPWIRE: if audit_log ever gets a DB-level append-only guard
    // (trigger or REVOKE DELETE for the owner), do not weaken it for this —
    // leave the tagged rows instead.
    async cleanup() {
      await prisma.auditLog.deleteMany({
        where: { OR: [{ organisationId: organisation.id }, { userId: { in: profileIds } }] },
      });
      await prisma.profile.deleteMany({ where: { id: { in: profileIds } } });
      await prisma.organisation.delete({ where: { id: organisation.id } });
    },
  };
}

/** Rows left behind by a tenant; all zero after `cleanup()`. */
export async function countTenantRows(prisma: PrismaService, tenant: Tenant) {
  const [organisations, subsidiaries, profiles, records, audit] = await Promise.all([
    prisma.organisation.count({ where: { id: tenant.organisationId } }),
    prisma.subsidiary.count({ where: { organisationId: tenant.organisationId } }),
    prisma.profile.count({ where: { id: { in: tenant.profileIds } } }),
    prisma.activityRecord.count({ where: { subsidiaryId: tenant.subsidiaryId } }),
    prisma.auditLog.count({
      where: {
        OR: [{ organisationId: tenant.organisationId }, { userId: { in: tenant.profileIds } }],
      },
    }),
  ]);
  return { organisations, subsidiaries, profiles, records, audit };
}

/**
 * A record in the tenant's subsidiary. The calculation is a structural
 * placeholder (no factor is looked up) — lifecycle tests never read its value.
 */
export async function createRecord(
  prisma: PrismaService,
  tenant: Tenant,
  data: Partial<Prisma.ActivityRecordUncheckedCreateInput> = {},
) {
  return prisma.activityRecord.create({
    data: {
      subsidiaryId: tenant.subsidiaryId,
      reportingYear: 2026,
      reportingPeriod: 'monthly',
      periodValue: 'January',
      category: 'Electricity',
      scope: 2,
      activityValue: 100,
      activityUnit: 'kWh',
      calculation: { tCo2e: 0, factorId: 'int-test-placeholder' },
      createdBy: tenant.users.dataEntry.id,
      status: ActivityRecordStatus.draft,
      ...data,
    },
  });
}

// ---------------------------------------------------------------------------
// Deterministic interleaving
// ---------------------------------------------------------------------------

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export interface Hold {
  /** Pass this to the code under test in place of its PrismaService. */
  client: PrismaService;
  /** Resolves once the code under test has reached the held query. */
  reached(timeoutMs?: number): Promise<void>;
  /** Lets the held query run. */
  release(): void;
}

/**
 * The barrier: a client that stops the FIRST `model.operation` query just
 * before it is sent, until `release()`. Everything the caller did before that
 * query — its reads and checks — has already run; the query itself has not.
 * So "hold request A between its check and its write" is
 * `holdBefore(prismaA, 'ActivityRecord', 'update')`.
 *
 * The hold survives a later refactor that moves the write into a transaction:
 * extensions propagate to interactive-transaction clients. It does NOT survive
 * a change of operation (`update` → `updateMany`): pass every name the code
 * under test may use, or `reached()` fails with "never reached".
 */
export function holdBefore(
  base: PrismaService,
  model: Prisma.ModelName,
  operation: string | string[],
): Hold {
  const operations = new Set(Array.isArray(operation) ? operation : [operation]);
  const arrived = deferred();
  const gate = deferred();
  let armed = true;
  const client = base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model: m, operation: op, args, query }) {
          if (armed && m === model && operations.has(op)) {
            armed = false;
            arrived.resolve();
            await gate.promise;
          }
          return query(args);
        },
      },
    },
  }) as unknown as PrismaService;

  return {
    client,
    reached: (timeoutMs = 10_000) =>
      withTimeout(arrived.promise, timeoutMs, `never reached ${model}.${[...operations].join('|')}`),
    release: () => gate.resolve(),
  };
}

/**
 * Waits until `pending` (request B) settles OR B's own session is waiting on a
 * lock — whichever comes first. The latter is how a test learns that B is
 * blocked behind request A's lock (once LP1-01 adds row locking), so it can
 * release A instead of deadlocking on B. Scoped to B's backend pid, so a lock
 * wait anywhere else in the database (a dev server, the e2e suite) cannot
 * release A early. `observer` must be a third client: A's and B's single
 * connections may both be busy. Outcome-deterministic: polling only decides
 * how soon we notice, never which branch is taken.
 */
export async function settledOrBlocked(
  pending: Promise<unknown>,
  pidB: number,
  observer: PrismaService,
  timeoutMs = 10_000,
): Promise<'settled' | 'blocked'> {
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (settled) return 'settled';
    const [{ blocked }] = await observer.$queryRaw<{ blocked: boolean }[]>`
      SELECT cardinality(pg_blocking_pids(${pidB}::int)) > 0 AS blocked`;
    if (settled) return 'settled';
    if (blocked) return 'blocked';
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`neither settled nor blocked within ${timeoutMs} ms`);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An evidence file of the tenant's subsidiary, linked to `recordIds`, written
 * straight to the database. No Storage object exists for it: the services
 * under test get a storage stub (`services.ts`), so nothing reaches a bucket.
 */
export async function attachEvidence(
  prisma: PrismaService,
  tenant: Tenant,
  recordIds: string[],
) {
  const file = await prisma.evidence.create({
    data: {
      subsidiaryId: tenant.subsidiaryId,
      storagePath: `${tenant.subsidiaryId}/${randomUUID()}-int-test.pdf`,
      fileName: 'int-test.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4,
      uploadedBy: tenant.users.dataEntry.id,
    },
  });
  await prisma.activityRecordEvidence.createMany({
    data: recordIds.map((activityRecordId) => ({
      activityRecordId,
      evidenceId: file.id,
      subsidiaryId: tenant.subsidiaryId,
      linkedBy: tenant.users.dataEntry.id,
    })),
  });
  return file;
}
