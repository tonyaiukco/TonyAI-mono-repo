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
 *
 * It logs in as the RUNTIME role (`tonyai_runtime`, LP1-03) — what the API
 * uses in a deployed environment — so a service under test fails here exactly
 * where a missing grant would fail it in production.
 */
export function connect(connections = 1): PrismaService {
  return clientFor(process.env.INT_RUNTIME_DATABASE_URL, connections);
}

/**
 * The same, logged in as the OWNER: for fixtures the runtime may not write
 * (organisations, profiles, synthetic audit-row cleanup) and for tests that
 * change the schema inside a rolled-back transaction or assume a client role.
 * Never hand it to a service under test.
 */
export function connectOwner(connections = 1): PrismaService {
  return clientFor(process.env.INT_OWNER_DATABASE_URL, connections);
}

function clientFor(raw: string | undefined, connections: number): PrismaService {
  const url = new URL(raw ?? '');
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
  users: Record<'superAdmin' | 'consultant' | 'dataEntry' | 'executiveViewer', RequestUser>;
  /** Every id this tenant's rows can be found by, for cleanup and leak checks. */
  profileIds: string[];
  cleanup(): Promise<void>;
}

/**
 * One organisation, one subsidiary, and a profile per role — the data_entry
 * profile with a real grant of the subsidiary. Written as the OWNER (the
 * runtime role cannot create organisations or profiles), on a client of its
 * own that `cleanup()` closes.
 */
export const TENANT_ORG_PREFIX = 'Int-test org ';
export const TENANT_EMAIL_PATTERN = 'int-%@tonyai.test';

export async function createTenant(): Promise<Tenant> {
  const prisma = connectOwner(2);
  const tag = randomUUID().slice(0, 8);
  try {
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
  } catch (err) {
    await prisma.$disconnect();
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
    executiveViewer: await makeUser(UserRole.executive_viewer, 'viewer'),
  };
  await prisma.userSubsidiaryAccess.create({
    data: { userId: users.dataEntry.id, subsidiaryId: subsidiary.id, organisationId: organisation.id },
  });
  const profileIds = Object.values(users).map((u) => u.id);

  return {
    organisationId: organisation.id,
    subsidiaryId: subsidiary.id,
    users,
    profileIds,
    // Test-only teardown of a synthetic tenant's own rows. Audit rows are
    // matched by this tenant's organisation and profiles only, so no real
    // trail is touched. Records go first, as the owner — the one role that
    // deletes a committed one, and no foreign key's action reaches them
    // (LP4-01: a subsidiary that holds records cannot be deleted); then the
    // organisation cascades to subsidiaries, sites, locks and evidence (not
    // Storage objects — a test that uploads removes its own, `storage.ts`). Storage intents carry no foreign key, so the
    // tenant's are matched by its ids and key prefixes. TRIPWIRE: if
    // audit_log ever gets a DB-level append-only guard (trigger or REVOKE
    // DELETE for the owner), do not weaken it for this — leave the tagged
    // rows instead.
    async cleanup() {
      try {
        await prisma.storageIntent.deleteMany({ where: tenantIntents([subsidiary.id], [organisation.id]) });
        await prisma.auditLog.deleteMany({
          where: { OR: [{ organisationId: organisation.id }, { userId: { in: profileIds } }] },
        });
        await prisma.profile.deleteMany({ where: { id: { in: profileIds } } });
        await prisma.activityRecord.deleteMany({ where: { subsidiary: { organisationId: organisation.id } } });
        await prisma.organisation.delete({ where: { id: organisation.id } });
      } finally {
        await prisma.$disconnect();
      }
    },
  };
}

/** The storage intents of synthetic tenants: by their ids, or by the key prefixes their objects live under. */
export function tenantIntents(subsidiaryIds: string[], organisationIds: string[]): Prisma.StorageIntentWhereInput {
  return {
    OR: [
      { subsidiaryId: { in: subsidiaryIds } },
      { organisationId: { in: organisationIds } },
      ...[...subsidiaryIds, ...organisationIds].map((id) => ({ objectPath: { startsWith: `${id}/` } })),
    ],
  };
}

/** Rows left behind by a tenant; all zero after `cleanup()`. */
export async function countTenantRows(prisma: PrismaService, tenant: Tenant) {
  const [organisations, subsidiaries, profiles, grants, records, audit] = await Promise.all([
    prisma.organisation.count({ where: { id: tenant.organisationId } }),
    prisma.subsidiary.count({ where: { organisationId: tenant.organisationId } }),
    prisma.profile.count({ where: { id: { in: tenant.profileIds } } }),
    prisma.userSubsidiaryAccess.count({ where: { userId: { in: tenant.profileIds } } }),
    prisma.activityRecord.count({ where: { subsidiaryId: tenant.subsidiaryId } }),
    prisma.auditLog.count({
      where: {
        OR: [{ organisationId: tenant.organisationId }, { userId: { in: tenant.profileIds } }],
      },
    }),
  ]);
  return { organisations, subsidiaries, profiles, grants, records, audit };
}

/**
 * A record row of the tenant's, as given — for the owner's direct insert of a
 * state the lifecycle cannot reach (a restore's), which only the owner may
 * write; everyone else goes through `createRecord`.
 */
export function recordInput(
  tenant: Tenant,
  data: Partial<Prisma.ActivityRecordUncheckedCreateInput> = {},
): Prisma.ActivityRecordUncheckedCreateInput {
  return {
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
  };
}

/**
 * The lifecycle's own steps from draft to each status — K5's transitions, in
 * the order the API takes them.
 */
const PATH_FROM_DRAFT: Record<ActivityRecordStatus, ActivityRecordStatus[]> = {
  draft: [],
  submitted: ['submitted'],
  under_review: ['submitted', 'under_review'],
  rejected: ['submitted', 'rejected'],
  approved: ['submitted', 'approved'],
  locked: ['submitted', 'approved', 'locked'],
  voided: ['submitted', 'approved', 'voided'],
};

/**
 * A record in the tenant's subsidiary. The calculation is a structural
 * placeholder (no factor is looked up) — lifecycle tests never read its value.
 * A record is born a draft (LP4-01's `activity_records_lifecycle_writer`), so
 * one asked for in another status is inserted as a draft and walked there by
 * the lifecycle's steps, on the caller's client — the runtime login or the
 * owner, the two sessions that may move a status.
 */
export async function createRecord(
  prisma: PrismaService,
  tenant: Tenant,
  data: Partial<Prisma.ActivityRecordUncheckedCreateInput> = {},
) {
  const { status = ActivityRecordStatus.draft, ...rest } = data;
  let record = await prisma.activityRecord.create({ data: recordInput(tenant, { ...rest, status: ActivityRecordStatus.draft }) });
  for (const step of PATH_FROM_DRAFT[status]) {
    record = await prisma.activityRecord.update({ where: { id: record.id }, data: { status: step } });
  }
  return record;
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

export interface TenantData {
  recordId: string;
  evidenceId: string;
  locationId: string;
  targetId: string;
  denominatorId: string;
  periodLockId: string;
  importBatchId: string;
}

/**
 * One row in every subsidiary-scoped table of the tenant, and an import batch
 * naming its subsidiary — for isolation tests that must find each of them
 * visible to the tenant and invisible to everyone else. Owner-written;
 * `cleanup()` removes the record, then the organisation cascades to the rest.
 */
export async function createTenantData(prisma: PrismaService, tenant: Tenant): Promise<TenantData> {
  const by = tenant.users.dataEntry.id;
  const subsidiaryId = tenant.subsidiaryId;
  const record = await createRecord(prisma, tenant);
  const evidence = await attachEvidence(prisma, tenant, [record.id]);
  const location = await prisma.location.create({
    data: { subsidiaryId, name: 'Int-test site', geographyCode: 'UK' },
  });
  const target = await prisma.target.create({
    data: {
      subsidiaryId,
      name: 'Int-test target',
      basis: 'internal_annual',
      scope: 'all',
      baselineYear: 2024,
      baselineTCo2e: 10,
      targetYear: 2030,
      targetTCo2e: 5,
      createdBy: by,
    },
  });
  const denominator = await prisma.subsidiaryDenominator.create({
    data: { subsidiaryId, year: 2026, metric: 'headcount', value: 10, unit: 'FTE', createdBy: by },
  });
  // A year no lifecycle test writes, so the lock blocks nothing.
  const periodLock = await prisma.periodLock.create({
    data: { subsidiaryId, reportingYear: 2019, reportingPeriod: 'monthly', periodValue: 'January', lockedBy: by },
  });
  const importBatch = await prisma.importBatch.create({
    data: {
      organisationId: tenant.organisationId,
      uploadedBy: by,
      fileName: 'int-test.csv',
      fileFormat: 'csv',
      sizeBytes: 1,
      sha256: '0'.repeat(64),
      totalRows: 1,
      subsidiaryIds: [subsidiaryId],
    },
  });
  return {
    recordId: record.id,
    evidenceId: evidence.id,
    locationId: location.id,
    targetId: target.id,
    denominatorId: denominator.id,
    periodLockId: periodLock.id,
    importBatchId: importBatch.id,
  };
}
