import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecordStatus, Prisma, UserRole } from '@tonyai/db';
import type { Category } from '@tonyai/shared-types';
import { BULK_UPLOAD_COLUMNS } from '@tonyai/shared-types';
import { AuditService } from '../../src/audit/audit.service';
import type { RequestUser } from '../../src/auth/auth.types';
import { BulkUploadService } from '../../src/bulk-upload/bulk-upload.service';
import type { StorageService } from '../../src/storage/storage.service';
import { lifecycleServices, storageStub } from './services';
import { AccessAdminService } from '../../src/auth/access-admin.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  addMember,
  attachEvidence,
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

/**
 * Central reporting on the real database (inc26-central-reporter-onboarding,
 * tasks 2.6–2.8): triggers TA024–TA027 for the runtime role and the owner, the
 * previous image's write shapes, and the races they close at READ COMMITTED on
 * two connections.
 */

let owner: PrismaService;
let runtime: PrismaService;
let observer: PrismaService;
let tenant: Tenant;

beforeAll(() => {
  owner = connectOwner(2);
  runtime = connect();
  observer = connect();
});

afterAll(async () => {
  await owner.$disconnect();
  await runtime.$disconnect();
  await observer.$disconnect();
});

beforeEach(async () => {
  tenant = await createTenant();
});

afterEach(async () => {
  await tenant?.cleanup();
});

/** The SQLSTATE a write was refused with (a trigger's, a CHECK's, a key's). */
function sqlstate(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2010') return String((e.meta as { code?: unknown } | undefined)?.code ?? '');
    if (e.code === 'P2003') return '23503';
    return e.code;
  }
  if (e instanceof Prisma.PrismaClientUnknownRequestError) {
    return /PostgresError \{ code: "([0-9A-Z]{5})"/.exec(e.message)?.[1] ?? null;
  }
  return null;
}

async function refused(write: Promise<unknown>): Promise<{ state: string | null; message: string }> {
  try {
    await write;
  } catch (e) {
    return { state: sqlstate(e), message: (e as Error).message };
  }
  throw new Error('expected the database to refuse this write');
}

/** The company `S` (tenant.subsidiaryId) and its standard user's categories. */
const S = () => tenant.subsidiaryId;
/** The reporter's main company (tenant.otherSubsidiaryId). */
const T = () => tenant.otherSubsidiaryId;

async function setOwnCategories(categories: Category[]) {
  await runtime.userSubsidiaryAccess.update({
    where: { userId_subsidiaryId: { userId: tenant.users.standardUser.id, subsidiaryId: S() } },
    data: { categories: [...categories].sort() },
  });
}

/** A standard user whose main company is T, with a grant at S of `grant`. */
async function reporterAt(grant: Category[]): Promise<string> {
  const reporter = await addMember(owner, tenant, UserRole.standard_user, { grants: [T()], categories: ['Water'] });
  await runtime.userSubsidiaryAccess.create({
    data: { userId: reporter.id, subsidiaryId: S(), organisationId: tenant.organisationId, kind: 'central_reporter', categories: [...grant].sort() },
  });
  return reporter.id;
}

async function site(name: string, subsidiaryId = S()): Promise<string> {
  const row = await owner.location.create({ data: { subsidiaryId, name, geographyCode: 'UK' }, select: { id: true } });
  return row.id;
}

/** Another company of the tenant's organisation, written by the owner. */
async function company(name: string): Promise<string> {
  const row = await owner.subsidiary.create({
    data: { organisationId: tenant.organisationId, legalName: name, geographyCode: 'UK' },
    select: { id: true },
  });
  return row.id;
}

/**
 * Two transactions on two connections: `first` runs and holds its transaction
 * open; `second` starts and must block on the first; then the first commits.
 * Answers each one's outcome.
 */
async function race(
  first: (tx: Prisma.TransactionClient) => Promise<unknown>,
  second: (tx: Prisma.TransactionClient) => Promise<unknown>,
  clients: { a?: PrismaService; b?: PrismaService } = {},
): Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]> {
  const a = clients.a ?? connect();
  const b = clients.b ?? connect();
  try {
    const inA = deferred();
    const releaseA = deferred();
    const pA = a.$transaction(async (tx) => {
      await first(tx);
      inA.resolve();
      await releaseA.promise;
    }, { timeout: 20_000 });
    pA.catch(() => inA.resolve());
    await inA.promise;
    const pidB = await backendPid(b);
    const pB = b.$transaction(async (tx) => second(tx), { timeout: 20_000 });
    const state = await settledOrBlocked(pB, pidB, observer);
    expect(state).toBe('blocked');
    releaseA.resolve();
    return (await Promise.allSettled([pA, pB])) as [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];
  } finally {
    if (!clients.a) await a.$disconnect();
    if (!clients.b) await b.$disconnect();
  }
}

const stateOf = (r: PromiseSettledResult<unknown>) => (r.status === 'fulfilled' ? 'ok' : sqlstate(r.reason));

describe('TA024: a category at a company is opened to one party (task 2.6)', () => {
  it("refuses a grant row where the company's own user holds the category, on a direct insert", async () => {
    const reporter = await addMember(owner, tenant, UserRole.standard_user, { grants: [T()], categories: ['Water'] });
    const r = await refused(runtime.userSubsidiaryAccess.create({
      data: { userId: reporter.id, subsidiaryId: S(), organisationId: tenant.organisationId, kind: 'central_reporter', categories: ['Electricity'] },
    }));
    expect(r.state).toBe('TA024');
    expect(r.message).toContain('single_entry_conflict: side=company_users');
  });

  it('refuses an assignment where a central reporter holds the category, on a direct insert', async () => {
    await setOwnCategories(['Water']);
    await reporterAt(['Electricity']);
    const user = await addMember(owner, tenant, UserRole.standard_user, { grants: [T()] });
    const r = await refused(runtime.userSubsidiaryAccess.create({
      data: { userId: user.id, subsidiaryId: S(), organisationId: tenant.organisationId, categories: ['Electricity', 'Water'] },
    }));
    expect(r.state).toBe('TA024');
    expect(r.message).toContain('single_entry_conflict: side=central_reporter');
    // A different category is opened.
    await runtime.userSubsidiaryAccess.create({
      data: { userId: user.id, subsidiaryId: S(), organisationId: tenant.organisationId, categories: ['Water'] },
    });
  });

  it('refuses a change of categories that opens the category to both', async () => {
    await setOwnCategories(['Water']);
    await reporterAt(['Electricity']);
    expect((await refused(setOwnCategories(['Electricity', 'Water']))).state).toBe('TA024');
  });

  it('refuses a change of kind that opens the category to both', async () => {
    await setOwnCategories(['Water']);
    const second = await addMember(owner, tenant, UserRole.standard_user, { grants: [S()], categories: ['Water'] });
    const r = await refused(runtime.userSubsidiaryAccess.update({
      where: { userId_subsidiaryId: { userId: second.id, subsidiaryId: S() } },
      data: { kind: 'central_reporter' },
    }));
    expect(r.state).toBe('TA024');
  });

  it('refuses a change of holder that opens the category to both (an owner write)', async () => {
    // A stray grant carried onto a masterkey is no party; handed to a standard user it is.
    await owner.userSubsidiaryAccess.create({
      data: { userId: tenant.users.masterkey.id, subsidiaryId: S(), organisationId: tenant.organisationId, kind: 'central_reporter', categories: ['Electricity'] },
    });
    const user = await addMember(owner, tenant, UserRole.standard_user, { grants: [T()] });
    const r = await refused(owner.userSubsidiaryAccess.update({
      where: { userId_subsidiaryId: { userId: tenant.users.masterkey.id, subsidiaryId: S() } },
      data: { userId: user.id },
    }));
    expect(r.state).toBe('TA024');
  });

  it('does not count a stray masterkey grant holding every category', async () => {
    await owner.userSubsidiaryAccess.create({
      data: { userId: tenant.users.masterkey.id, subsidiaryId: S(), organisationId: tenant.organisationId, kind: 'central_reporter', categories: ['Electricity', 'Water'] },
    });
    // The company's own user keeps and widens its categories.
    await setOwnCategories(['Electricity', 'Water', 'Waste']);
  });

  it('refuses a grant row with no category, and a kind it does not know', async () => {
    const reporter = await addMember(owner, tenant, UserRole.standard_user, { grants: [T()] });
    expect((await refused(runtime.userSubsidiaryAccess.create({
      data: { userId: reporter.id, subsidiaryId: S(), organisationId: tenant.organisationId, kind: 'central_reporter', categories: [] },
    }))).state).toBe('23514');
    expect((await refused(runtime.userSubsidiaryAccess.create({
      data: { userId: reporter.id, subsidiaryId: S(), organisationId: tenant.organisationId, kind: 'owner', categories: ['Water'] },
    }))).state).toBe('23514');
  });

  for (const order of ['grant first', 'assignment first'] as const) {
    it(`lets exactly one of a grant and an assignment racing for one category commit (${order})`, async () => {
      await setOwnCategories(['Water']);
      const reporter = await addMember(owner, tenant, UserRole.standard_user, { grants: [T()], categories: ['Water'] });
      const grant = (tx: Prisma.TransactionClient) => tx.userSubsidiaryAccess.create({
        data: { userId: reporter.id, subsidiaryId: S(), organisationId: tenant.organisationId, kind: 'central_reporter', categories: ['Electricity'] },
      });
      const assign = (tx: Prisma.TransactionClient) => tx.userSubsidiaryAccess.update({
        where: { userId_subsidiaryId: { userId: tenant.users.standardUser.id, subsidiaryId: S() } },
        data: { categories: ['Electricity', 'Water'] },
      });
      const [first, second] = order === 'grant first' ? await race(grant, assign) : await race(assign, grant);
      expect(stateOf(first)).toBe('ok');
      expect(stateOf(second)).toBe('TA024');
    });
  }
});

describe('TA025: the reporting entity, worked out and frozen (task 2.7)', () => {
  it("stores a central reporter's record, written with no value (the previous image's shape), with the main company", async () => {
    await setOwnCategories(['Water']);
    const reporter = await reporterAt(['Electricity']);
    const record = await createRecord(runtime, tenant, { createdBy: reporter });
    expect(record.reportedBySubsidiaryId).toBe(T());
    // The company's own user's record stores no value: its own company.
    const own = await createRecord(runtime, tenant, { periodValue: 'February', category: 'Water', activityUnit: 'm3' });
    expect(own.reportedBySubsidiaryId).toBeNull();
  });

  it('refuses a supplied company that differs, and accepts the same one', async () => {
    await setOwnCategories(['Water']);
    const reporter = await reporterAt(['Electricity']);
    const elsewhere = await company('Int-test elsewhere');
    expect((await refused(createRecord(runtime, tenant, { createdBy: reporter, reportedBySubsidiaryId: elsewhere }))).state).toBe('TA025');
    expect((await refused(createRecord(runtime, tenant, { periodValue: 'March', category: 'Water', activityUnit: 'm3', reportedBySubsidiaryId: T() }))).state).toBe('TA025');
    const same = await createRecord(runtime, tenant, { createdBy: reporter, reportedBySubsidiaryId: T() });
    expect(same.reportedBySubsidiaryId).toBe(T());
  });

  it('refuses a reporter that holds no single assigned company', async () => {
    await setOwnCategories(['Water']);
    const reporter = await reporterAt(['Electricity']);
    const second = await company('Int-test second main');
    await owner.userSubsidiaryAccess.create({ data: { userId: reporter, subsidiaryId: second, organisationId: tenant.organisationId, categories: ['Water'] } });
    const r = await refused(createRecord(runtime, tenant, { createdBy: reporter }));
    expect(r.state).toBe('TA025');
    expect(r.message).toContain('central_reporter_needs_main_entity');
  });

  it("refuses an update of the column, and of the company of a record whose reporting entity is its own", async () => {
    await setOwnCategories(['Water']);
    const reporter = await reporterAt(['Electricity']);
    const reported = await createRecord(runtime, tenant, { createdBy: reporter });
    for (const client of [runtime, owner]) {
      expect((await refused(client.activityRecord.update({ where: { id: reported.id }, data: { reportedBySubsidiaryId: S() } }))).state).toBe('TA025');
      expect((await refused(client.activityRecord.update({ where: { id: reported.id }, data: { reportedBySubsidiaryId: null } }))).state).toBe('TA025');
    }
    const own = await createRecord(runtime, tenant, { periodValue: 'February', category: 'Water', activityUnit: 'm3' });
    expect((await refused(owner.activityRecord.update({ where: { id: own.id }, data: { subsidiaryId: T() } }))).state).toBe('TA025');
    // Any other change passes and keeps the stored value.
    const edited = await runtime.activityRecord.update({ where: { id: reported.id }, data: { activityValue: 101 } });
    expect(edited.reportedBySubsidiaryId).toBe(T());
  });

  it("refuses, for the owner's session, moving the reporting company or the owning company to another organisation, and still moves a company with no such record", async () => {
    await setOwnCategories(['Water']);
    const reporter = await reporterAt(['Electricity']);
    await createRecord(runtime, tenant, { createdBy: reporter });
    const foreign = await createTenant();
    try {
      for (const id of [T(), S()]) {
        const r = await refused(owner.subsidiary.update({ where: { id }, data: { organisationId: foreign.organisationId, parentId: foreign.subsidiaryId } }));
        expect(r.state).toBe('TA027');
      }
      const free = await company('Int-test free to move');
      await owner.subsidiary.update({ where: { id: free }, data: { organisationId: foreign.organisationId, parentId: foreign.subsidiaryId } });
      expect((await owner.subsidiary.findUniqueOrThrow({ where: { id: free } })).organisationId).toBe(foreign.organisationId);
    } finally {
      await foreign.cleanup();
    }
  });

  for (const order of ['record first', 'move first'] as const) {
    it(`never stores a record and moves its reporting company both (${order})`, async () => {
      await setOwnCategories(['Water']);
      const reporter = await reporterAt(['Electricity']);
      const foreign = await createTenant();
      try {
        const store = (tx: Prisma.TransactionClient) => tx.activityRecord.create({
          data: {
            subsidiaryId: S(), reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'January', category: 'Electricity',
            scope: 2, activityValue: 100, activityUnit: 'kWh', calculation: { tCo2e: 0, factorId: 'int-test-placeholder' },
            createdBy: reporter, status: ActivityRecordStatus.draft,
          },
        });
        // An operator's move withdraws the company's access rows first (their
        // keys name its organisation), then moves it.
        const move = async (tx: Prisma.TransactionClient) => {
          await tx.userSubsidiaryAccess.deleteMany({ where: { subsidiaryId: T() } });
          await tx.subsidiary.update({ where: { id: T() }, data: { organisationId: foreign.organisationId, parentId: foreign.subsidiaryId } });
        };
        const ownerA = connectOwner();
        const ownerB = connectOwner();
        try {
          const [first, second] = order === 'record first'
            ? await race(store, move, { b: ownerB })
            : await race(move, store, { a: ownerA });
          const outcomes = [stateOf(first), stateOf(second)];
          expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
          expect(outcomes[1]).toBe(order === 'record first' ? 'TA027' : 'TA025');
          const stored = await owner.activityRecord.count({ where: { createdBy: reporter } });
          const moved = (await owner.subsidiary.findUniqueOrThrow({ where: { id: T() } })).organisationId === foreign.organisationId;
          expect(stored + (moved ? 1 : 0)).toBe(1);
        } finally {
          await ownerA.$disconnect();
          await ownerB.$disconnect();
        }
      } finally {
        await foreign.cleanup();
      }
    });
  }
});

describe('TA026: one party enters a category for a company in a period (task 2.8)', () => {
  /** The company's own user holds Electricity at S first; the reporter holds Fuel. */
  async function parties() {
    const reporter = await reporterAt(['Fuel']);
    return { own: tenant.users.standardUser.id, reporter };
  }
  const record = (createdBy: string, data: Partial<Prisma.ActivityRecordUncheckedCreateInput> = {}) =>
    createRecord(runtime, tenant, { createdBy, ...data });

  it('refuses a handover inside a period, in both directions, and allows the next period', async () => {
    await setOwnCategories(['Electricity', 'Water']);
    const { own, reporter } = await parties();
    const second = await site('Int-test second site');
    await record(own, { periodValue: 'March' });
    // The category is handed over: taken from the company's users, given to the reporter.
    await setOwnCategories(['Water']);
    await runtime.userSubsidiaryAccess.update({ where: { userId_subsidiaryId: { userId: reporter, subsidiaryId: S() } }, data: { categories: ['Electricity', 'Fuel'] } });
    const r = await refused(record(reporter, { periodValue: 'March', locationId: second }));
    expect(r.state).toBe('TA026');
    expect(r.message).toContain('single_entry_period_conflict: side=company_users');
    await record(reporter, { periodValue: 'April', locationId: second });
    // And back: the reporter's April closes April to the company's own users.
    await runtime.userSubsidiaryAccess.update({ where: { userId_subsidiaryId: { userId: reporter, subsidiaryId: S() } }, data: { categories: ['Fuel'] } });
    await setOwnCategories(['Electricity', 'Water']);
    const back = await refused(record(own, { periodValue: 'April' }));
    expect(back.state).toBe('TA026');
    expect(back.message).toContain('side=central_reporter');
  });

  it("allows the same party's second facility and second activity type", async () => {
    await setOwnCategories(['Water']);
    const reporter = await reporterAt(['Fuel']);
    const second = await site('Int-test second site');
    await record(reporter, { category: 'Fuel', activityType: 'diesel', activityUnit: 'litres', scope: 1 });
    await record(reporter, { category: 'Fuel', activityType: 'diesel', activityUnit: 'litres', scope: 1, locationId: second });
    await record(reporter, { category: 'Fuel', activityType: 'petrol', activityUnit: 'litres', scope: 1 });
    expect(await owner.activityRecord.count({ where: { createdBy: reporter } })).toBe(3);
  });

  it("does not count a voided record, nor a super_admin's or a masterkey's", async () => {
    await setOwnCategories(['Electricity', 'Water']);
    const { own, reporter } = await parties();
    const second = await site('Int-test second site');
    const voided = await record(own, { periodValue: 'June', status: ActivityRecordStatus.approved });
    await runtime.activityRecord.update({
      where: { id: voided.id },
      data: { status: ActivityRecordStatus.voided, voidReason: 'int-test', voidedBy: tenant.users.masterkey.id, voidedAt: new Date() },
    });
    await record(tenant.users.superAdmin.id, { periodValue: 'July' });
    await record(tenant.users.masterkey.id, { periodValue: 'August' });
    await setOwnCategories(['Water']);
    await runtime.userSubsidiaryAccess.update({ where: { userId_subsidiaryId: { userId: reporter, subsidiaryId: S() } }, data: { categories: ['Electricity'] } });
    for (const periodValue of ['June', 'July', 'August']) await record(reporter, { periodValue, locationId: second });
    expect(await owner.activityRecord.count({ where: { createdBy: reporter } })).toBe(3);
  });

  it('refuses an edit that moves a draft into a taken period, and leaves it unchanged', async () => {
    await setOwnCategories(['Electricity', 'Water']);
    const { own, reporter } = await parties();
    await record(own, { periodValue: 'March' });
    await setOwnCategories(['Water']);
    await runtime.userSubsidiaryAccess.update({ where: { userId_subsidiaryId: { userId: reporter, subsidiaryId: S() } }, data: { categories: ['Electricity'] } });
    const draft = await record(reporter, { periodValue: 'April' });
    expect((await refused(runtime.activityRecord.update({ where: { id: draft.id }, data: { periodValue: 'March' } }))).state).toBe('TA026');
    expect((await owner.activityRecord.findUniqueOrThrow({ where: { id: draft.id } })).periodValue).toBe('April');
  });

  for (const order of ['own user first', 'reporter first'] as const) {
    it(`stores exactly one of two parties' records racing for one period at two facilities (${order})`, async () => {
      await setOwnCategories(['Water']);
      const reporter = await reporterAt(['Electricity']);
      const second = await site('Int-test second site');
      const input = (createdBy: string, locationId: string | null): Prisma.ActivityRecordUncheckedCreateInput => ({
        subsidiaryId: S(), locationId, reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'May', category: 'Electricity',
        scope: 2, activityValue: 100, activityUnit: 'kWh', calculation: { tCo2e: 0, factorId: 'int-test-placeholder' },
        createdBy, status: ActivityRecordStatus.draft,
      });
      const ownWrite = (tx: Prisma.TransactionClient) => tx.activityRecord.create({ data: input(tenant.users.standardUser.id, null) });
      const reporterWrite = (tx: Prisma.TransactionClient) => tx.activityRecord.create({ data: input(reporter, second) });
      const [first, secondResult] = order === 'own user first' ? await race(ownWrite, reporterWrite) : await race(reporterWrite, ownWrite);
      expect(stateOf(first)).toBe('ok');
      expect(stateOf(secondResult)).toBe('TA026');
      expect(await owner.activityRecord.count({ where: { subsidiaryId: S(), periodValue: 'May' } })).toBe(1);
    });
  }

  it("refuses a direct write of a reporter's record in a period the company's own user holds", async () => {
    await setOwnCategories(['Electricity', 'Water']);
    const { own, reporter } = await parties();
    await record(own, { periodValue: 'September' });
    await runtime.userSubsidiaryAccess.update({ where: { userId_subsidiaryId: { userId: reporter, subsidiaryId: S() } }, data: { categories: ['Fuel'] } });
    const second = await site('Int-test second site');
    // The DB does not judge categories (the API does); it judges the period.
    expect((await refused(owner.activityRecord.create({
      data: {
        id: randomUUID(), subsidiaryId: S(), locationId: second, reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'September',
        category: 'Electricity', scope: 2, activityValue: 1, activityUnit: 'kWh', calculation: { tCo2e: 0 }, createdBy: reporter,
        status: ActivityRecordStatus.draft,
      },
    }))).state).toBe('TA026');
  });
});

const accessAdmin = (client: PrismaService) => new AccessAdminService(client, new AuditService(client));

describe('the API answers a single-entry refusal the database raised in a race (task 3.3)', () => {
  it("a grant held after its check, overtaken by another writer's assignment, is answered single_entry_conflict with its side and an empty list", async () => {
    await setOwnCategories(['Water']);
    const reporter = await addMember(owner, tenant, UserRole.standard_user, { grants: [T()], categories: ['Water'] });
    // The masterkey's grant has checked single entry and stops before its insert.
    const hold = holdBefore(runtime, 'UserSubsidiaryAccess', 'createMany');
    const grant = accessAdmin(hold.client).setCentralReporterGrant(tenant.users.masterkey, reporter.id, {
      subsidiaryIds: [S()], categories: ['Electricity'],
    });
    await hold.reached();
    // Another writer — not through the administrative lock (the previous image,
    // the owner) — opens Electricity at S to the company's own user meanwhile.
    await owner.userSubsidiaryAccess.update({
      where: { userId_subsidiaryId: { userId: tenant.users.standardUser.id, subsidiaryId: S() } },
      data: { categories: ['Electricity', 'Water'] },
    });
    hold.release();
    const refusal = await grant.catch((e: { response?: unknown }) => e.response);
    expect(refusal).toMatchObject({ code: 'single_entry_conflict', params: { side: 'company_users' }, conflicts: [] });
    expect(await owner.userSubsidiaryAccess.count({ where: { userId: reporter.id } })).toBe(1);
    expect(await owner.auditLog.count({ where: { entityId: reporter.id, entity: 'subsidiary_access' } })).toBe(0);
  });
});

describe('a carried-over account is converted by the masterkey\'s grant (task 3.6)', () => {
  /** An account carried over with three assigned companies of differing categories, written by the owner. */
  async function carriedOver() {
    const third = await company('Int-test third company');
    const account = await addMember(owner, tenant, UserRole.standard_user, { grants: [T(), third] });
    await owner.userSubsidiaryAccess.create({
      data: { userId: account.id, subsidiaryId: S(), organisationId: tenant.organisationId, categories: ['Waste'] },
    });
    await owner.userSubsidiaryAccess.update({ where: { userId_subsidiaryId: { userId: account.id, subsidiaryId: T() } }, data: { categories: ['Electricity'] } });
    await owner.userSubsidiaryAccess.update({ where: { userId_subsidiaryId: { userId: account.id, subsidiaryId: third } }, data: { categories: ['Mobile Combustion'] } });
    return { account, third };
  }
  const rows = async (userId: string) =>
    Object.fromEntries((await owner.userSubsidiaryAccess.findMany({ where: { userId }, orderBy: { subsidiaryId: 'asc' } }))
      .map((r) => [r.subsidiaryId, `${r.kind}:${r.categories.join(',')}`]));

  it('works unchanged before any grant: it holds its three companies, every row assigned', async () => {
    await setOwnCategories(['Water']);
    const { account, third } = await carriedOver();
    expect(await rows(account.id)).toEqual(Object.fromEntries([
      [S(), 'assigned:Waste'], [T(), 'assigned:Electricity'], [third, 'assigned:Mobile Combustion'],
    ].sort((x, y) => x[0]!.localeCompare(y[0]!))));
    // A record for each company names the company itself as its reporting entity.
    for (const [subsidiaryId, category, unit] of [[T(), 'Electricity', 'kWh'], [third, 'Water', 'm3']] as const) {
      const record = await createRecord(runtime, tenant, { subsidiaryId, category, activityUnit: unit, createdBy: account.id });
      expect(record.reportedBySubsidiaryId).toBeNull();
    }
  });

  it('a grant naming two: the third stays the main company with its categories, the two take the grant\'s, each audited before and after', async () => {
    await setOwnCategories(['Water']);
    const { account, third } = await carriedOver();
    await accessAdmin(runtime).setCentralReporterGrant(tenant.users.masterkey, account.id, {
      subsidiaryIds: [T(), third], categories: ['Mobile Combustion'],
    });
    expect(await rows(account.id)).toEqual(Object.fromEntries([
      [S(), 'assigned:Waste'], [T(), 'central_reporter:Mobile Combustion'], [third, 'central_reporter:Mobile Combustion'],
    ].sort((x, y) => x[0]!.localeCompare(y[0]!))));
    const audits = await owner.auditLog.findMany({ where: { entityId: account.id, entity: 'subsidiary_access' } });
    const bySubsidiary = (x: unknown, y: unknown) => (x as { subsidiaryId: string }).subsidiaryId.localeCompare((y as { subsidiaryId: string }).subsidiaryId);
    expect(audits.map((a) => a.diff).sort(bySubsidiary)).toEqual([
      { subsidiaryId: T(), before: { kind: 'assigned', categories: ['Electricity'] }, after: { kind: 'central_reporter', categories: ['Mobile Combustion'] } },
      { subsidiaryId: third, before: { kind: 'assigned', categories: ['Mobile Combustion'] }, after: { kind: 'central_reporter', categories: ['Mobile Combustion'] } },
    ].sort(bySubsidiary));
    expect(JSON.stringify(audits)).not.toContain(account.email);
  });

  it('a grant naming one of three is refused, and nothing changes', async () => {
    await setOwnCategories(['Water']);
    const { account, third } = await carriedOver();
    const before = await rows(account.id);
    await expect(accessAdmin(runtime).setCentralReporterGrant(tenant.users.masterkey, account.id, { subsidiaryIds: [third], categories: ['Mobile Combustion'] }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'central_reporter_needs_main_entity' }) });
    expect(await rows(account.id)).toEqual(before);
  });

  it('a single-entry conflict is refused, and nothing changes', async () => {
    await setOwnCategories(['Water']);
    const { account, third } = await carriedOver();
    // Another standard user assigned to the third company holds Mobile Combustion.
    await addMember(owner, tenant, UserRole.standard_user, { grants: [third], categories: ['Mobile Combustion'] });
    const before = await rows(account.id);
    const refusal = await accessAdmin(runtime).setCentralReporterGrant(tenant.users.masterkey, account.id, {
      subsidiaryIds: [T(), third], categories: ['Mobile Combustion'],
    }).catch((e: { response?: unknown }) => e.response);
    expect(refusal).toMatchObject({ code: 'single_entry_conflict', params: { side: 'company_users' }, conflicts: [{ subsidiaryId: third, categories: ['Mobile Combustion'] }] });
    expect(await rows(account.id)).toEqual(before);
  });
});

describe('bulk upload by a central reporter (task 4.5)', () => {
  /** The reporter as the guard builds it: main company T (Water), the grant at S (Electricity). */
  async function reporterUser(): Promise<RequestUser> {
    const id = await reporterAt(['Electricity']);
    const profile = await owner.profile.findUniqueOrThrow({ where: { id } });
    return {
      id, email: profile.email, fullName: profile.fullName, role: 'standard_user', organisationId: tenant.organisationId,
      accessibleSubsidiaryIds: [T(), S()],
      categoryGrants: { [T()]: ['Water'], [S()]: ['Electricity'] },
      grantKinds: { [T()]: 'assigned', [S()]: 'central_reporter' },
    };
  }
  function importer(client: PrismaService = runtime): BulkUploadService {
    const store = storageStub();
    const { records, intents } = lifecycleServices(client, store);
    return new BulkUploadService(client, records, new AuditService(client), store as unknown as StorageService, intents);
  }
  type Cells = Partial<Record<(typeof BULK_UPLOAD_COLUMNS)[number], string>>;
  function file(...rows: Cells[]): Express.Multer.File {
    const line = (r: Cells) => {
      const cells: Cells = { subsidiaryId: S(), reportingYear: '2026', reportingPeriod: 'monthly', category: 'Electricity', activityValue: '100', activityUnit: 'kWh', ...r };
      return BULK_UPLOAD_COLUMNS.map((c) => cells[c] ?? '').join(',');
    };
    const buffer = Buffer.from([BULK_UPLOAD_COLUMNS.join(','), ...rows.map(line)].join('\n'));
    return { originalname: 'central-reporter.csv', mimetype: 'text/csv', size: buffer.length, buffer } as Express.Multer.File;
  }

  it('judges each row — a category outside the grant, a period the other party holds — and imports the rest with the reporting entity, in the dry run and the import', async () => {
    // The company's own user entered Electricity for March, then the category was handed over.
    await setOwnCategories(['Electricity', 'Water']);
    await createRecord(runtime, tenant, { periodValue: 'March' });
    await setOwnCategories(['Water']);
    const user = await reporterUser();
    // At another facility: a slot of its own, so only the period rule answers.
    const second = await site('Int-test reporter site');
    const upload = () => file(
      { periodValue: 'February' },
      { periodValue: 'February', category: 'Water', activityUnit: 'm3' },
      { periodValue: 'March', locationId: second },
    );
    for (const dryRun of [true, false]) {
      const report = await importer().import(user, upload(), { dryRun });
      expect(report.accepted.map((r) => r.row)).toEqual([2]);
      expect(report.errors.map((e) => [e.row, e.code]).sort()).toEqual([[3, 'category_not_granted'], [4, 'single_entry_period_conflict']]);
      expect(report.errors.find((e) => e.code === 'single_entry_period_conflict')?.params)
        .toEqual({ side: 'company_users', category: 'Electricity', year: 2026, period: 'March' });
    }
    const imported = await owner.activityRecord.findMany({ where: { createdBy: user.id } });
    expect(imported.map((r) => [r.periodValue, r.reportedBySubsidiaryId])).toEqual([['February', T()]]);
  });

  it('refuses the whole file, before any row is judged, when a row names a company outside the grant', async () => {
    await setOwnCategories(['Water']);
    const user = await reporterUser();
    const outside = await company('Int-test outside the grant');
    await expect(importer().import(user, file({ periodValue: 'February' }, { periodValue: 'February', subsidiaryId: outside }), { dryRun: false }))
      .rejects.toBeTruthy();
    expect(await owner.activityRecord.count({ where: { createdBy: user.id } })).toBe(0);
    expect(await owner.importBatch.count({ where: { uploadedBy: user.id } })).toBe(0);
  });

  it('a grant withdrawn after the fourth of ten rows: four records stay, each naming T, the six after are refused as for an unknown company', async () => {
    await setOwnCategories(['Water']);
    const user = await reporterUser();
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October'];
    // Pause the import between the fourth record's commit and the fifth row's
    // first read (its period-lock check, outside any transaction).
    const arrived = deferred();
    const gate = deferred();
    let created = 0;
    let paused = false;
    const held = runtime.$extends({
      query: {
        activityRecord: {
          async create({ args, query }) {
            const result = await query(args);
            created += 1;
            return result;
          },
        },
        periodLock: {
          async $allOperations({ args, query }) {
            if (created === 4 && !paused) {
              paused = true;
              arrived.resolve();
              await gate.promise;
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaService;
    const run = importer(held).import(user, file(...months.map((periodValue) => ({ periodValue }))), { dryRun: false });
    await arrived.promise;
    await owner.userSubsidiaryAccess.delete({ where: { userId_subsidiaryId: { userId: user.id, subsidiaryId: S() } } });
    gate.resolve();
    const report = await run;
    expect(report.accepted.map((r) => r.row)).toEqual([2, 3, 4, 5]);
    expect(report.errors.map((e) => [e.row, e.code])).toEqual([6, 7, 8, 9, 10, 11].map((row) => [row, 'not_found']));
    const stored = await owner.activityRecord.findMany({ where: { createdBy: user.id }, orderBy: { createdAt: 'asc' } });
    expect(stored.map((r) => [r.periodValue, r.reportedBySubsidiaryId])).toEqual(months.slice(0, 4).map((m) => [m, T()]));
  });
});

describe('a record follows the access committed when it is stored (task 4.2, C10)', () => {
  async function reporter(): Promise<RequestUser> {
    const id = await reporterAt(['Electricity']);
    const profile = await owner.profile.findUniqueOrThrow({ where: { id } });
    return {
      id, email: profile.email, fullName: profile.fullName, role: 'standard_user', organisationId: tenant.organisationId,
      accessibleSubsidiaryIds: [T(), S()],
      categoryGrants: { [T()]: ['Water'], [S()]: ['Electricity'] },
      grantKinds: { [T()]: 'assigned', [S()]: 'central_reporter' },
    };
  }
  const dto = {
    subsidiaryId: '', reportingYear: 2026, reportingPeriod: 'monthly' as const, periodValue: 'January',
    category: 'Electricity' as const, activityValue: 100, activityUnit: 'kWh',
  };

  it('a create held until the grant\'s withdrawal commits is refused as for an unknown company, with no record or audit row', async () => {
    await setOwnCategories(['Water']);
    const user = await reporter();
    // Held after its early checks, before its transaction.
    const hold = holdBefore(runtime, 'PeriodLock', 'findFirst');
    const create = lifecycleServices(hold.client).records.create(user, { ...dto, subsidiaryId: S() });
    await hold.reached();
    await accessAdmin(owner).setCentralReporterGrant(tenant.users.masterkey, user.id, { subsidiaryIds: [], categories: [] });
    hold.release();
    await expect(create).rejects.toMatchObject({ response: expect.objectContaining({ code: 'subsidiary_not_found' }) });
    expect(await owner.activityRecord.count({ where: { createdBy: user.id } })).toBe(0);
    expect(await owner.auditLog.count({ where: { userId: user.id, entity: 'activity_record' } })).toBe(0);
  });

  it('a create held until the main company\'s move commits names the new main company', async () => {
    await setOwnCategories(['Water']);
    const user = await reporter();
    const moved = await company('Int-test new main company');
    const hold = holdBefore(runtime, 'PeriodLock', 'findFirst');
    const create = lifecycleServices(hold.client).records.create(user, { ...dto, subsidiaryId: S() });
    await hold.reached();
    // A super_admin's move of the main company: T withdrawn, U assigned, in one change.
    await owner.$transaction(async (tx) => {
      await tx.userSubsidiaryAccess.delete({ where: { userId_subsidiaryId: { userId: user.id, subsidiaryId: T() } } });
      await tx.userSubsidiaryAccess.create({ data: { userId: user.id, subsidiaryId: moved, organisationId: tenant.organisationId, categories: ['Water'] } });
    });
    hold.release();
    const record = await create;
    expect(record.reportedBySubsidiaryId).toBe(moved);
    expect((await owner.activityRecord.findUniqueOrThrow({ where: { id: record.id } })).reportedBySubsidiaryId).toBe(moved);
  });

  it('a withdrawal sent while a create holds its lock waits, and the record stands', async () => {
    await setOwnCategories(['Water']);
    const user = await reporter();
    const a = connect();
    const b = connect();
    try {
      // Held inside its transaction, after the access rows are share-locked.
      const hold = holdBefore(a, 'ActivityRecord', 'create');
      const create = lifecycleServices(hold.client).records.create(user, { ...dto, subsidiaryId: S() });
      await hold.reached();
      const pidB = await backendPid(b);
      const withdrawal = accessAdmin(b).setCentralReporterGrant(tenant.users.masterkey, user.id, { subsidiaryIds: [], categories: [] });
      expect(await settledOrBlocked(withdrawal, pidB, observer)).toBe('blocked');
      hold.release();
      const record = await create;
      await withdrawal;
      expect(record.reportedBySubsidiaryId).toBe(T());
      expect(await owner.activityRecord.count({ where: { id: record.id, reportedBySubsidiaryId: T() } })).toBe(1);
      expect(await owner.userSubsidiaryAccess.count({ where: { userId: user.id, subsidiaryId: S() } })).toBe(0);
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });

  // --- the owner's review of WP8 (2026-11-26) -------------------------------------

  it("P2: a create whose access read began before the main company's move commits names the new main company", async () => {
    await setOwnCategories(['Water']);
    const user = await reporter();
    const moved = await company('Int-test moved main company');
    const a = connect();
    const b = connect();
    try {
      const moving = deferred();
      const commit = deferred();
      const move = a.$transaction(async (tx) => {
        await tx.userSubsidiaryAccess.delete({ where: { userId_subsidiaryId: { userId: user.id, subsidiaryId: T() } } });
        await tx.userSubsidiaryAccess.create({ data: { userId: user.id, subsidiaryId: moved, organisationId: tenant.organisationId, categories: ['Water'] } });
        moving.resolve();
        await commit.promise;
      }, { timeout: 20_000 });
      await moving.promise;
      // Its locking read waits on the deleted row; its snapshot predates the new one.
      const pidB = await backendPid(b);
      const create = lifecycleServices(b).records.create(user, { ...dto, subsidiaryId: S() });
      expect(await settledOrBlocked(create, pidB, observer)).toBe('blocked');
      commit.resolve();
      await move;
      const record = await create;
      expect(record.reportedBySubsidiaryId).toBe(moved);
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });

  it("P2: a create takes the companies before the access rows — a company delete's order — so the two cannot deadlock", async () => {
    await setOwnCategories(['Water']);
    const user = await reporter();
    const a = connect();
    const b = connect();
    try {
      const locked = deferred();
      const finish = deferred();
      let accessDeleted = false;
      // A company delete: the company FOR UPDATE, then its access rows; rolled back.
      const del = a.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM subsidiaries WHERE id = ${T()}::uuid FOR UPDATE`;
        locked.resolve();
        await finish.promise;
        await tx.$executeRaw`DELETE FROM user_subsidiary_access WHERE subsidiary_id = ${T()}::uuid`;
        accessDeleted = true;
        throw new Error('rollback');
      }, { timeout: 20_000 }).catch((e: Error) => e.message);
      await locked.promise;
      const pidB = await backendPid(b);
      const create = lifecycleServices(b).records.create(user, { ...dto, subsidiaryId: S() });
      // Waits on the company, holding none of the access rows yet…
      expect(await settledOrBlocked(create, pidB, observer)).toBe('blocked');
      // …so the delete's removal of them goes through.
      finish.resolve();
      expect(await del).toBe('rollback');
      expect(accessDeleted).toBe(true);
      const record = await create;
      expect(record.reportedBySubsidiaryId).toBe(T());
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });

  it('P1: an edit sent after the grant was withdrawn is refused inside its write, and changes nothing', async () => {
    await setOwnCategories(['Water']);
    const user = await reporter();
    const draft = await lifecycleServices(runtime).records.create(user, { ...dto, subsidiaryId: S(), periodValue: 'March' });
    await accessAdmin(owner).setCentralReporterGrant(tenant.users.masterkey, user.id, { subsidiaryIds: [], categories: [] });
    // `user` is the request's access, read before the withdrawal.
    await expect(lifecycleServices(runtime).records.update(user, draft.id, { activityValue: 250 }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'subsidiary_not_found' }) });
    expect((await owner.activityRecord.findUniqueOrThrow({ where: { id: draft.id } })).activityValue).toBe(100);
  });

  it("P1: an edit sent after its category was withdrawn is refused with category_not_granted", async () => {
    await setOwnCategories(['Water']);
    const user = await reporter();
    const draft = await lifecycleServices(runtime).records.create(user, { ...dto, subsidiaryId: S(), periodValue: 'April' });
    await accessAdmin(owner).setCentralReporterGrant(tenant.users.masterkey, user.id, { subsidiaryIds: [S()], categories: ['Fuel'] });
    await expect(lifecycleServices(runtime).records.update(user, draft.id, { activityValue: 250 }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'category_not_granted' }) });
    expect((await owner.activityRecord.findUniqueOrThrow({ where: { id: draft.id } })).activityValue).toBe(100);
  });

  it("P2: an exact repeat of the company user's record, entered by the reporter it was handed to, answers record_duplicate as the bulk upload does", async () => {
    const own = await createRecord(runtime, tenant, { periodValue: 'May' });
    await setOwnCategories(['Water']);
    const user = await reporter();
    await expect(lifecycleServices(runtime).records.create(user, {
      ...dto, subsidiaryId: S(), locationId: own.locationId, reportingYear: own.reportingYear, reportingPeriod: own.reportingPeriod as 'monthly',
      periodValue: own.periodValue, category: own.category as Category, activityType: own.activityType,
    })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'record_duplicate' }) });
    // Another facility of the same month is the period rule's.
    const other = await site('Int-test another facility');
    await expect(lifecycleServices(runtime).records.create(user, {
      ...dto, subsidiaryId: S(), locationId: other, reportingYear: own.reportingYear, reportingPeriod: own.reportingPeriod as 'monthly',
      periodValue: own.periodValue, category: own.category as Category, activityType: own.activityType,
    })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'single_entry_period_conflict' }) });
  });
});

describe('a reporting company is not deleted (task 4.6, C6)', () => {
  it("a direct delete of a company another company's record names meets the foreign key, and changes nothing", async () => {
    await setOwnCategories(['Water']);
    const reporter = await reporterAt(['Electricity']);
    await createRecord(runtime, tenant, { createdBy: reporter });
    // The reporter's own row at T goes with T by its key's cascade; the record's does not.
    const r = await refused(owner.subsidiary.delete({ where: { id: T() } }));
    expect(r.state).toBe('23503');
    expect(await owner.subsidiary.count({ where: { id: T() } })).toBe(1);
    expect(await owner.userSubsidiaryAccess.count({ where: { userId: reporter, subsidiaryId: T() } })).toBe(1);
  });
});

describe("a central reporter's record is decided for its owning company (task 4.7, D7)", () => {
  const decisions = () => lifecycleServices(runtime).records;
  /** A submitted, priced, evidenced Electricity record a reporter of T entered for S. */
  async function submittedByReporter() {
    await setOwnCategories(['Water']);
    const reporter = await reporterAt(['Electricity']);
    const record = await createRecord(runtime, tenant, { createdBy: reporter, status: ActivityRecordStatus.submitted, submittedAt: new Date() }, { priced: true });
    await attachEvidence(runtime, tenant, [record.id]);
    expect(record.reportedBySubsidiaryId).toBe(T());
    return { reporter, record, seen: record.submittedAt!.toISOString() };
  }
  const reportingSuperAdmin = () => addMember(owner, tenant, UserRole.super_admin, { grants: [T()] });
  const stored = (id: string) => owner.activityRecord.findUniqueOrThrow({ where: { id } });

  it("the owning company's super_admin approves; the reporting company's super_admin is answered record_not_found; the queue lists it for the right reader", async () => {
    const { record, seen } = await submittedByReporter();
    const other = await reportingSuperAdmin();
    const mine = await decisions().listPage(tenant.users.superAdmin, { awaitingMyDecision: true } as never);
    expect(mine.items.map((r) => r.id)).toContain(record.id);
    expect(mine.items.find((r) => r.id === record.id)).toMatchObject({ approver: 'super_admin', reportedBySubsidiaryId: T() });
    const theirs = await decisions().listPage(other, { awaitingMyDecision: true } as never);
    expect(theirs.items.map((r) => r.id)).not.toContain(record.id);
    await expect(decisions().approve(other, record.id, seen)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'record_not_found' }) });
    const approved = await decisions().approve(tenant.users.superAdmin, record.id, seen);
    expect(approved).toMatchObject({ status: 'approved', subsidiaryId: S(), reportedBySubsidiaryId: T() });
    expect((await stored(record.id)).reportedBySubsidiaryId).toBe(T());
  });

  it('the masterkey decides when the owning company has no active super_admin', async () => {
    const { record, seen } = await submittedByReporter();
    await owner.profile.update({ where: { id: tenant.users.superAdmin.id }, data: { disabledAt: new Date() } });
    const mine = await decisions().listPage(tenant.users.masterkey, { awaitingMyDecision: true } as never);
    expect(mine.items.map((r) => r.id)).toContain(record.id);
    const approved = await decisions().approve(tenant.users.masterkey, record.id, seen);
    expect(approved).toMatchObject({ status: 'approved', reportedBySubsidiaryId: T() });
  });

  it('a reporter made a super_admin after submitting is decided by a masterkey', async () => {
    const { reporter, record, seen } = await submittedByReporter();
    await owner.profile.update({ where: { id: reporter }, data: { role: UserRole.super_admin } });
    await expect(decisions().approve(tenant.users.superAdmin, record.id, seen))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'not_record_approver' }) });
    const approved = await decisions().approve(tenant.users.masterkey, record.id, seen);
    expect(approved).toMatchObject({ status: 'approved', reportedBySubsidiaryId: T() });
  });

  it("a disabled reporter's record is taken into review and returned by the owning company's super_admin", async () => {
    const { reporter, record, seen } = await submittedByReporter();
    await owner.profile.update({ where: { id: reporter }, data: { disabledAt: new Date() } });
    const inReview = await decisions().startReview(tenant.users.superAdmin, record.id, seen);
    expect(inReview).toMatchObject({ status: 'under_review', reportedBySubsidiaryId: T() });
    const returned = await decisions().reject(tenant.users.superAdmin, record.id, 'Check the meter', seen);
    expect(returned).toMatchObject({ status: 'rejected', reportedBySubsidiaryId: T() });
    expect((await stored(record.id)).reportedBySubsidiaryId).toBe(T());
  });
});

describe("a central reporter's approved figure counts at the owning company (task 4.8)", () => {
  it('counts at the owning company and its ancestors, and adds nothing to the reporting company', async () => {
    await setOwnCategories(['Water']);
    // The owning company A sits under the root S beside the reporting company T.
    const owning = await company('Int-test owning company');
    const reporter = await addMember(owner, tenant, UserRole.standard_user, { grants: [T()], categories: ['Water'] });
    await runtime.userSubsidiaryAccess.create({
      data: { userId: reporter.id, subsidiaryId: owning, organisationId: tenant.organisationId, kind: 'central_reporter', categories: ['Electricity'] },
    });
    const record = await createRecord(runtime, tenant, { subsidiaryId: owning, createdBy: reporter.id, status: ActivityRecordStatus.approved }, { priced: true });
    expect(record.reportedBySubsidiaryId).toBe(T());
    const figure = (record.calculation as { tCo2e: number }).tCo2e;
    expect(figure).toBeGreaterThan(0);
    const { EmissionsService } = await import('../../src/emissions/emissions.service');
    // The masterkey as the guard builds it now: every company of the organisation.
    const masterkey = { ...tenant.users.masterkey, accessibleSubsidiaryIds: [S(), T(), owning] };
    const answer = await new EmissionsService(runtime).rollUp(masterkey, { reportingYear: 2026 });
    const row = (id: string) => answer.rows.find((r) => r.subsidiaryId === id)!;
    expect(row(owning).own?.total).toBeCloseTo(figure, 9);
    expect(row(S()).rollUp?.total).toBeCloseTo(figure, 9);
    expect(row(T()).own?.total ?? 0).toBe(0);
    expect(row(T()).rollUp?.total ?? 0).toBe(0);
  });
});

describe('the architect review of 2026-11-26', () => {
  it('a status step is never judged again: a period that came to hold both parties still submits and approves (P2-1)', async () => {
    await setOwnCategories(['Water']);
    const reporter = await reporterAt(['Electricity']);
    const second = await site('Int-test second site');
    // A super_admin's record counts for no party; the reporter enters the same period.
    const own = await createRecord(runtime, tenant, { createdBy: tenant.users.superAdmin.id, periodValue: 'March' });
    const theirs = await createRecord(runtime, tenant, { createdBy: reporter, periodValue: 'March', locationId: second });
    // The super_admin is made a standard user: its record now counts as the company's own user's.
    await owner.profile.update({ where: { id: tenant.users.superAdmin.id }, data: { role: UserRole.standard_user } });
    for (const id of [own.id, theirs.id]) {
      await runtime.activityRecord.update({ where: { id }, data: { status: ActivityRecordStatus.submitted } });
      await runtime.activityRecord.update({ where: { id }, data: { status: ActivityRecordStatus.approved } });
    }
    expect(await owner.activityRecord.count({ where: { id: { in: [own.id, theirs.id] }, status: 'approved' } })).toBe(2);
    // An identity move into a taken period is still refused.
    const draft = await createRecord(runtime, tenant, { createdBy: reporter, periodValue: 'April', locationId: second });
    expect((await refused(runtime.activityRecord.update({ where: { id: draft.id }, data: { periodValue: 'March' } }))).state).toBe('TA026');
  });

  it('TA027 refuses a move under a stricter isolation level, which could not see a record committed meanwhile (P3-4)', async () => {
    const free = await company('Int-test free company');
    const foreign = await createTenant();
    try {
      const r = await refused(owner.$transaction(
        (tx) => tx.subsidiary.update({ where: { id: free }, data: { organisationId: foreign.organisationId, parentId: foreign.subsidiaryId } }),
        { isolationLevel: 'RepeatableRead' },
      ));
      expect(r.state).toBe('TA027');
    } finally {
      await foreign.cleanup();
    }
  });
});

describe('the QA and security reviews of 2026-11-26', () => {
  it('TA025 refuses a record carried to another company, with the column or without it (QA P2-1, security P3-2)', async () => {
    await setOwnCategories(['Water']);
    const reporter = await reporterAt(['Electricity']);
    const other = await company('Int-test destination');
    const own = await createRecord(runtime, tenant, { periodValue: 'February', category: 'Water', activityUnit: 'm3' });
    const reported = await createRecord(runtime, tenant, { createdBy: reporter });
    for (const client of [runtime, owner]) {
      expect((await refused(client.activityRecord.update({ where: { id: own.id }, data: { subsidiaryId: other, reportedBySubsidiaryId: S() } }))).state).toBe('TA025');
      expect((await refused(client.activityRecord.update({ where: { id: reported.id }, data: { subsidiaryId: other } }))).state).toBe('TA025');
    }
    // Restating the stored entity changes nothing and passes.
    const restated = await runtime.activityRecord.update({ where: { id: own.id }, data: { reportedBySubsidiaryId: S() } });
    expect(restated.reportedBySubsidiaryId).toBeNull();
  });

  it("TA026 judges a change of author: a masterkey's record handed to a company user in a reporter's period is refused (security P3-1)", async () => {
    await setOwnCategories(['Water']);
    const reporter = await reporterAt(['Electricity']);
    const second = await site('Int-test second site');
    const mk = await createRecord(runtime, tenant, { createdBy: tenant.users.masterkey.id, periodValue: 'May' });
    await createRecord(runtime, tenant, { createdBy: reporter, periodValue: 'May', locationId: second });
    expect((await refused(runtime.activityRecord.update({ where: { id: mk.id }, data: { createdBy: tenant.users.standardUser.id } }))).state).toBe('TA026');
  });

  it("the API's own period check counts neither a super_admin's record, a voided one, nor another category's (QA Q1, Q2, Q4)", async () => {
    await setOwnCategories(['Electricity', 'Water']);
    const reporterId = await reporterAt(['Fuel']);
    // The company's own user holds Water in June (another category), a voided Electricity record in June,
    // and a super_admin holds Electricity in June.
    await createRecord(runtime, tenant, { periodValue: 'June', category: 'Water', activityUnit: 'm3' });
    const voided = await createRecord(runtime, tenant, { periodValue: 'June', status: ActivityRecordStatus.approved }, { priced: true });
    await runtime.activityRecord.update({ where: { id: voided.id }, data: { status: ActivityRecordStatus.voided, voidReason: 'int', voidedBy: tenant.users.masterkey.id, voidedAt: new Date() } });
    const second = await site('Int-test second site');
    await createRecord(runtime, tenant, { createdBy: tenant.users.superAdmin.id, periodValue: 'June', locationId: second });
    // Hand Electricity to the reporter.
    await setOwnCategories(['Water']);
    await runtime.userSubsidiaryAccess.update({ where: { userId_subsidiaryId: { userId: reporterId, subsidiaryId: S() } }, data: { categories: ['Electricity', 'Fuel'] } });
    const profile = await owner.profile.findUniqueOrThrow({ where: { id: reporterId } });
    const reporter: RequestUser = {
      id: reporterId, email: profile.email, fullName: profile.fullName, role: 'standard_user', organisationId: tenant.organisationId,
      accessibleSubsidiaryIds: [T(), S()], categoryGrants: { [T()]: ['Water'], [S()]: ['Electricity', 'Fuel'] },
      grantKinds: { [T()]: 'assigned', [S()]: 'central_reporter' },
    };
    const third = await site('Int-test third site');
    const dto = {
      subsidiaryId: S(), locationId: third, reportingYear: 2026, reportingPeriod: 'monthly' as const, periodValue: 'June',
      category: 'Electricity' as const, activityValue: 100, activityUnit: 'kWh',
    };
    const preview = await lifecycleServices(runtime).records.previewCreate(reporter, dto);
    expect(preview.reportedBySubsidiaryId).toBe(T());
    // …while a company user's live Electricity record in another month does close that month.
    await runtime.userSubsidiaryAccess.update({ where: { userId_subsidiaryId: { userId: reporterId, subsidiaryId: S() } }, data: { categories: ['Fuel'] } });
    await setOwnCategories(['Electricity', 'Water']);
    await createRecord(runtime, tenant, { periodValue: 'July' });
    await expect(lifecycleServices(runtime).records.previewCreate(reporter, { ...dto, periodValue: 'July' }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'single_entry_period_conflict' }) });
  });
});

describe('the exact repeat and the slot kind, through the service (QA review of the owner-review round)', () => {
  async function fuelReporter(): Promise<RequestUser> {
    const id = await reporterAt(['Fuel']);
    const profile = await owner.profile.findUniqueOrThrow({ where: { id } });
    return {
      id, email: profile.email, fullName: profile.fullName, role: 'standard_user', organisationId: tenant.organisationId,
      accessibleSubsidiaryIds: [T(), S()],
      categoryGrants: { [T()]: ['Water'], [S()]: ['Fuel'] },
      grantKinds: { [T()]: 'assigned', [S()]: 'central_reporter' },
    };
  }
  const fuel = (periodValue: string, activityType: string) => ({
    subsidiaryId: S(), reportingYear: 2026, reportingPeriod: 'monthly' as const, periodValue,
    category: 'Fuel' as const, activityType, activityValue: 10, activityUnit: 'litres',
  });

  it("another activity type in the other party's period is the period rule's, not a duplicate", async () => {
    await createRecord(runtime, tenant, { category: 'Fuel', activityType: 'diesel', activityUnit: 'litres', periodValue: 'June' });
    await setOwnCategories(['Water']);
    const user = await fuelReporter();
    await expect(lifecycleServices(runtime).records.create(user, fuel('June', 'petrol')))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'single_entry_period_conflict' }) });
    await expect(lifecycleServices(runtime).records.create(user, fuel('June', 'diesel')))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'record_duplicate' }) });
  });

  it("a typed record where an untyped one stands answers TA002's conflict before the period rule", async () => {
    await createRecord(runtime, tenant, { category: 'Fuel', activityType: null, activityUnit: 'litres', periodValue: 'July' });
    await setOwnCategories(['Water']);
    const user = await fuelReporter();
    await expect(lifecycleServices(runtime).records.create(user, fuel('July', 'diesel')))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'slot_holds_untyped' }) });
  });
});

describe("the owner's second review of WP8 (2026-11-26)", () => {
  const dto = {
    subsidiaryId: '', reportingYear: 2026, reportingPeriod: 'monthly' as const, periodValue: 'August',
    category: 'Electricity' as const, activityValue: 100, activityUnit: 'kWh',
  };
  async function asRequest(id: string, role: 'standard_user' | 'super_admin', extra: Partial<RequestUser> = {}): Promise<RequestUser> {
    const profile = await owner.profile.findUniqueOrThrow({ where: { id } });
    return { id, email: profile.email, fullName: profile.fullName, role, organisationId: tenant.organisationId, accessibleSubsidiaryIds: [S()], ...extra };
  }

  it('P1: a super_admin made a standard user while its create waits writes nothing', async () => {
    const admin = await addMember(owner, tenant, UserRole.super_admin, { grants: [S()] });
    const user = await asRequest(admin.id, 'super_admin');
    const hold = holdBefore(runtime, 'PeriodLock', 'findFirst');
    const create = lifecycleServices(hold.client).records.create(user, { ...dto, subsidiaryId: S() });
    await hold.reached();
    await accessAdmin(owner).setRole(tenant.users.masterkey, admin.id, UserRole.standard_user);
    hold.release();
    await expect(create).rejects.toMatchObject({ response: expect.objectContaining({ code: 'record_create_forbidden' }) });
    expect(await owner.activityRecord.count({ where: { createdBy: admin.id } })).toBe(0);
  });

  it('P1: an author disabled while its create waits writes nothing', async () => {
    const admin = await addMember(owner, tenant, UserRole.super_admin, { grants: [S()] });
    const user = await asRequest(admin.id, 'super_admin');
    const hold = holdBefore(runtime, 'PeriodLock', 'findFirst');
    const create = lifecycleServices(hold.client).records.create(user, { ...dto, subsidiaryId: S() });
    await hold.reached();
    await owner.profile.update({ where: { id: admin.id }, data: { disabledAt: new Date() } });
    hold.release();
    await expect(create).rejects.toMatchObject({ response: expect.objectContaining({ code: 'record_create_forbidden' }) });
    expect(await owner.activityRecord.count({ where: { createdBy: admin.id } })).toBe(0);
  });

  it("P1: a super_admin's company withdrawn while its create waits is refused as unknown", async () => {
    const other = await company('Int-test second granted company');
    const admin = await addMember(owner, tenant, UserRole.super_admin, { grants: [S(), other] });
    const user = await asRequest(admin.id, 'super_admin', { accessibleSubsidiaryIds: [S(), other] });
    const hold = holdBefore(runtime, 'PeriodLock', 'findFirst');
    const create = lifecycleServices(hold.client).records.create(user, { ...dto, subsidiaryId: S() });
    await hold.reached();
    await owner.userSubsidiaryAccess.delete({ where: { userId_subsidiaryId: { userId: admin.id, subsidiaryId: S() } } });
    hold.release();
    await expect(create).rejects.toMatchObject({ response: expect.objectContaining({ code: 'subsidiary_not_found' }) });
  });

  it("P2: a grant change that removes one company and re-ticks another waits for a create, and neither deadlocks", async () => {
    await setOwnCategories(['Water']);
    const reporterId = await reporterAt(['Electricity']);
    // Its id sorts last, so a create that locked rows one by one would hold S's row
    // while it waited on this one's — the deadlock the profile lock prevents.
    const second = (await owner.subsidiary.create({
      data: { id: `ffffffff-${randomUUID().slice(9)}`, organisationId: tenant.organisationId, legalName: 'Int-test second grant company', geographyCode: 'UK' },
      select: { id: true },
    })).id;
    expect(second > S() && second > T()).toBe(true);
    await runtime.userSubsidiaryAccess.create({
      data: { userId: reporterId, subsidiaryId: second, organisationId: tenant.organisationId, kind: 'central_reporter', categories: ['Electricity'] },
    });
    const user = await asRequest(reporterId, 'standard_user', {
      accessibleSubsidiaryIds: [T(), S(), second],
      categoryGrants: { [T()]: ['Water'], [S()]: ['Electricity'], [second]: ['Electricity'] },
      grantKinds: { [T()]: 'assigned', [S()]: 'central_reporter', [second]: 'central_reporter' },
    });
    const a = connect();
    const b = connect();
    try {
      // The grant change, held after it removed one company's row and before it re-ticks the other.
      const hold = holdBefore(a, 'UserSubsidiaryAccess', 'update');
      const change = accessAdmin(hold.client).setCentralReporterGrant(tenant.users.masterkey, reporterId, {
        subsidiaryIds: [S()], categories: ['Electricity', 'Fuel'],
      });
      await hold.reached();
      // The create waits on the account's profile, holding none of its rows…
      const pidB = await backendPid(b);
      const create = lifecycleServices(b).records.create(user, { ...dto, subsidiaryId: S() });
      expect(await settledOrBlocked(create, pidB, observer)).toBe('blocked');
      // …so the change completes, and the create follows it.
      hold.release();
      await change;
      const record = await create;
      expect(record.reportedBySubsidiaryId).toBe(T());
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });
});
