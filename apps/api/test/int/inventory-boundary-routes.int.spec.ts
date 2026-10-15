/**
 * LP3-04's write path on the real database (W1, W13; Decisions 2026-10-15
 * (fifth), E1–E9): the seven routes through the deployed app as the runtime
 * role — who may do what (E2), a version's life from create to confirm (E3,
 * E4), data_entry's granted view and the versions it never sees (W3), whose
 * subsidiary and site a declaration may name — and the service against
 * concurrent writers: the header lock serialises every write (W8, PR B's
 * (6)), a copy is never torn, a lost race is `conflict`, a failed write leaves
 * no audit row and an audited one no partial write, and no valid sequence of
 * writes ever reaches the guard (TA014, E7).
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { HttpException, type INestApplication } from '@nestjs/common';
import type {
  InventoryBoundaryVersionDTO,
  InventoryBoundaryVersionSummary,
  InventoryCategory,
  PutInventoryBoundarySubsidiaryRequest,
} from '@tonyai/shared-types';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import type { RequestUser } from '../../src/auth/auth.types';
import { errorCodeOf, toErrorBody } from '../../src/common/api-error';
import { declarationOf, declarationRows, type StoredDeclaration } from '../../src/inventory-boundary/boundary-declaration';
import { readDeclaration } from '../../src/inventory-boundary/boundary-rows';
import { InventoryBoundariesService } from '../../src/inventory-boundary/inventory-boundaries.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { backendPid, connect, connectOwner, createTenant, holdBefore, settledOrBlocked, type Tenant } from './db';
import { ABORTED_AFTER_AUDIT, abortAfterAuditClient, failingAuditClient, INJECTED_AUDIT_FAILURE } from './services';

const JWT_SECRET = randomBytes(32).toString('hex');
let app: INestApplication;
let base: string;
let owner: PrismaService;
let observer: PrismaService;
let runtime: PrismaService;

/** A tenant per test: subsidiary S (granted to its data_entry user) with
 * sites L1 and L2, and a sibling S2 — not granted — with site M1. */
let t: Tenant;
let S: string;
let S2: string;
let L1: string;
let L2: string;
let M1: string;
let admin: RequestUser;

const CATEGORIES: readonly InventoryCategory[] = ['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants'];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.INT_RUNTIME_DATABASE_URL;
  process.env.SUPABASE_JWT_SCHEME = 'hs256';
  process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
  process.env.STORAGE_SWEEP_INTERVAL_SECONDS = '0';
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module');
  const { configureApp } = await import('../../src/app-setup');
  const { JsonLogger } = await import('../../src/observability/json-logger');
  const { RuntimeLimits } = await import('../../src/common/runtime-limits');
  app = await NestFactory.create(AppModule, { logger: ['error'] });
  const quiet = Object.assign(new JsonLogger(), { event: () => undefined });
  configureApp(app, quiet, { requestLogging: false, runtimeLimits: app.get(RuntimeLimits) });
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/api/v1`.replace('[::1]', '127.0.0.1');
  const [{ user }] = await app.get(PrismaService).$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`;
  if (user !== 'tonyai_runtime') throw new Error(`the application under test connects as ${user}, not tonyai_runtime`);
  owner = connectOwner(2);
  observer = connectOwner(1);
  runtime = connect(2);
}, 60_000);

afterAll(async () => {
  await Promise.all([owner?.$disconnect(), observer?.$disconnect(), runtime?.$disconnect()]);
  await app?.close();
});

beforeEach(async () => {
  t = await createTenant();
  S = t.subsidiaryId;
  admin = t.users.superAdmin;
  const site = async (subsidiaryId: string, name: string) =>
    (await owner.location.create({ data: { subsidiaryId, name, geographyCode: 'UK' } })).id;
  L1 = await site(S, 'Int-test L1');
  L2 = await site(S, 'Int-test L2');
  S2 = (await owner.subsidiary.create({
    data: { organisationId: t.organisationId, legalName: `Int-test sibling ${randomUUID().slice(0, 8)}`, geographyCode: 'TR' },
  })).id;
  M1 = await site(S2, 'Int-test M1 only the sibling has');
});

// The organisation's deletion takes its versions, frozen ones included (W10).
afterEach(async () => {
  await t?.cleanup();
});

// --------------------------------------------------------------------------
// Bodies

/** S's complete declaration: electricity metered per site, gas at the
 * company, the rest excluded, a named unsupported exclusion. No gap. */
function completeS(over: Partial<PutInventoryBoundarySubsidiaryRequest> = {}): PutInventoryBoundarySubsidiaryRequest {
  return {
    firstMonth: 1,
    lastMonth: 12,
    sites: [{ locationId: L1, firstMonth: 1, lastMonth: 12 }, { locationId: L2, firstMonth: 4, lastMonth: 12 }],
    attribution: [
      { category: 'Electricity', level: 'sites', reportingPeriod: 'monthly' },
      { category: 'Natural Gas', level: 'company', reportingPeriod: 'quarterly' },
      { category: 'Fuel', level: 'company', reportingPeriod: 'annual' },
      { category: 'Mobile Combustion', level: 'company', reportingPeriod: 'annual' },
      { category: 'Refrigerants', level: 'company', reportingPeriod: 'annual' },
    ],
    applicability: [
      { locationId: null, category: 'Natural Gas', applicability: 'included' },
      { locationId: null, category: 'Fuel', applicability: 'excluded', reason: 'No fuel burnt on site' },
      { locationId: null, category: 'Mobile Combustion', applicability: 'excluded', reason: 'No company vehicles' },
      { locationId: null, category: 'Refrigerants', applicability: 'excluded', reason: 'No refrigeration plant' },
      { locationId: L1, category: 'Electricity', applicability: 'included' },
      { locationId: L2, category: 'Electricity', applicability: 'included' },
    ],
    sources: [
      { locationId: null, name: 'Gas supply', mapping: { kind: 'mapped', category: 'Natural Gas', activityType: null }, applicability: 'included', evidenceReportingPeriod: 'quarterly' },
      {
        locationId: null, name: 'District heat', mapping: { kind: 'unsupported', reason: 'No factor in the library' }, scope: 2,
        applicability: 'excluded', reason: 'Below the materiality threshold',
      },
      { locationId: L1, name: 'L1 main meter', mapping: { kind: 'mapped', category: 'Electricity', activityType: null }, applicability: 'included', evidenceReportingPeriod: 'monthly' },
      { locationId: L2, name: 'L2 main meter', mapping: { kind: 'mapped', category: 'Electricity', activityType: null }, applicability: 'included', evidenceReportingPeriod: null },
    ],
    ...over,
  };
}

/** A holding-only subsidiary: every category excluded at the company. No gap. */
function excludedAll(reason = 'Holding company with no operations'): PutInventoryBoundarySubsidiaryRequest {
  return {
    firstMonth: 1,
    lastMonth: 12,
    sites: [],
    attribution: CATEGORIES.map((category) => ({ category, level: 'company', reportingPeriod: 'annual' })),
    applicability: CATEGORIES.map((category) => ({ locationId: null, category, applicability: 'excluded', reason })),
    sources: [],
  };
}

// --------------------------------------------------------------------------
// Helpers

async function tokenFor(userId: string): Promise<string> {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience('authenticated')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

interface Answer {
  status: number;
  text: string;
  code: string | undefined;
}

async function call(user: RequestUser, method: string, path: string, body?: unknown): Promise<Answer> {
  const headers: Record<string, string> = { authorization: `Bearer ${await tokenFor(user.id)}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { code?: string }).code;
  } catch {
    code = undefined;
  }
  return { status: res.status, text, code };
}

const json = <T>(a: Answer): T => JSON.parse(a.text) as T;

/** The service on its own client — a held one, a failing one. */
const serviceOn = (client: PrismaService) => new InventoryBoundariesService(client, new AuditService(client));

/** The code a client receives for a thrown refusal: the filter's (`toErrorBody`). */
const answered = (e: unknown) => (e instanceof HttpException ? toErrorBody(e.getStatus(), e.getResponse()).code : undefined);

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

/** A version of the tenant's, by the service, with these declarations. */
async function versionWith(
  declarations: Array<[string, PutInventoryBoundarySubsidiaryRequest]>,
  reportingYear = 2026,
): Promise<string> {
  const service = serviceOn(runtime);
  const { id } = await service.create(admin, { reportingYear });
  for (const [subsidiaryId, body] of declarations) await service.putSubsidiary(admin, id, subsidiaryId, body);
  return id;
}

/** A subsidiary's stored declaration, read back; null when undeclared. */
async function declared(boundaryId: string, subsidiaryId: string): Promise<StoredDeclaration | null> {
  const rows = await readDeclaration(owner, boundaryId, subsidiaryId);
  return rows && declarationOf(rows);
}

/** A declaration without its source ids, which are new on every write. */
const withoutIds = (d: StoredDeclaration | null) =>
  d && { ...d, sources: d.sources.map(({ id: _id, ...rest }) => rest) };

/** A body as `declared` reads it back: in its one order, without source ids. */
const canonical = (body: PutInventoryBoundarySubsidiaryRequest) =>
  withoutIds(declarationOf(declarationRows({ boundaryId: '', organisationId: '', subsidiaryId: '' }, body, () => '')));

/** Everything of the tenant's boundary: every version, every row, every audit row. */
async function boundaryState(): Promise<string> {
  const versions = await owner.inventoryBoundary.findMany({ where: { organisationId: t.organisationId }, orderBy: { id: 'asc' } });
  const where = { boundaryId: { in: versions.map((v) => v.id) } };
  const rows = await Promise.all([
    owner.inventoryBoundarySubsidiary.findMany({ where, orderBy: [{ boundaryId: 'asc' }, { subsidiaryId: 'asc' }] }),
    owner.inventoryBoundarySite.findMany({ where, orderBy: [{ boundaryId: 'asc' }, { locationId: 'asc' }] }),
    owner.inventoryAttributionPolicy.findMany({ where, orderBy: [{ boundaryId: 'asc' }, { subsidiaryId: 'asc' }, { category: 'asc' }] }),
    owner.inventoryApplicabilityCell.findMany({ where, orderBy: [{ boundaryId: 'asc' }, { subsidiaryId: 'asc' }, { locationKey: 'asc' }, { category: 'asc' }] }),
    owner.inventorySource.findMany({ where, orderBy: { id: 'asc' } }),
  ]);
  const audit = await owner.auditLog.findMany({ where: { organisationId: t.organisationId, entity: 'inventory_boundary' }, orderBy: { id: 'asc' } });
  return JSON.stringify({ versions, rows, audit });
}

const auditOf = (entityId: string) =>
  owner.auditLog.findMany({ where: { entity: 'inventory_boundary', entityId }, orderBy: { createdAt: 'asc' } });

// --------------------------------------------------------------------------

describe('who may do what (E2): super_admin writes and confirms; everyone else reads', () => {
  it('refuses every write by consultant, executive_viewer and data_entry with forbidden — changing nothing — and lets each read', async () => {
    const id = await versionWith([[S, completeS()]]);
    const before = await boundaryState();
    for (const role of ['consultant', 'executiveViewer', 'dataEntry'] as const) {
      const user = t.users[role];
      for (const [method, path, body] of [
        ['POST', '/inventory-boundaries', { reportingYear: 2027 }],
        ['POST', '/inventory-boundaries', { reportingYear: 2027, copyOf: id }],
        ['PUT', `/inventory-boundaries/${id}/subsidiaries/${S}`, completeS()],
        ['DELETE', `/inventory-boundaries/${id}/subsidiaries/${S}`, undefined],
        ['POST', `/inventory-boundaries/${id}/confirm`, undefined],
        ['DELETE', `/inventory-boundaries/${id}`, undefined],
      ] as const) {
        const answer = await call(user, method, path, body);
        expect([answer.status, answer.code], `${role} ${method} ${path}`).toEqual([403, 'forbidden']);
      }
      expect((await call(user, 'GET', '/inventory-boundaries?reportingYear=2026')).status, role).toBe(200);
      expect((await call(user, 'GET', `/inventory-boundaries/${id}`)).status, role).toBe(200);
    }
    expect(await boundaryState()).toBe(before);
  });

  it("refuses a reader's 1 MB declaration of empty rows before it is validated — forbidden, small — and a writer's past the limits with one message (security-rls P1)", async () => {
    const id = await versionWith([]);
    const empties = (n: number) => ({ firstMonth: 1, lastMonth: 12, sites: [], attribution: [], applicability: [], sources: Array(n).fill({}) });
    const flood = empties(340_000);
    expect(Buffer.byteLength(JSON.stringify(flood))).toBeLessThan(1_048_576);
    for (const role of ['consultant', 'executiveViewer', 'dataEntry'] as const) {
      const answer = await call(t.users[role], 'PUT', `/inventory-boundaries/${id}/subsidiaries/${S}`, flood);
      expect([answer.status, answer.code], role).toEqual([403, 'forbidden']);
      expect(answer.text.length, role).toBeLessThan(1_000);
    }
    for (const body of [flood, empties(2_001)]) {
      const answer = await call(admin, 'PUT', `/inventory-boundaries/${id}/subsidiaries/${S}`, body);
      expect([answer.status, answer.code]).toEqual([400, 'validation_failed']);
      expect(json<{ message: string[] }>(answer).message).toEqual(['sources must contain no more than 2000 elements']);
    }
    expect(await declared(id, S)).toBeNull();
  });

  it('lets super_admin do every one of them', async () => {
    const created = await call(admin, 'POST', '/inventory-boundaries', { reportingYear: 2026 });
    expect(created.status).toBe(201);
    const { id } = json<InventoryBoundaryVersionDTO>(created);
    expect((await call(admin, 'PUT', `/inventory-boundaries/${id}/subsidiaries/${S2}`, excludedAll())).status).toBe(200);
    expect((await call(admin, 'DELETE', `/inventory-boundaries/${id}/subsidiaries/${S2}`)).status).toBe(200);
    // A removal is an `update` holding what it removed (E8; `qa-auditor` P2).
    const [, declaredS2, removedS2] = await auditOf(id);
    expect(removedS2.action).toBe('update');
    expect(removedS2.diff).toEqual({ subsidiaryId: S2, before: (declaredS2.diff as { after: unknown }).after, after: null });
    expect((await call(admin, 'PUT', `/inventory-boundaries/${id}/subsidiaries/${S}`, completeS())).status).toBe(200);
    expect((await call(admin, 'POST', `/inventory-boundaries/${id}/confirm`)).status).toBe(200);
    const copy = await call(admin, 'POST', '/inventory-boundaries', { reportingYear: 2026, copyOf: id });
    expect(copy.status).toBe(201);
    const deleted = await call(admin, 'DELETE', `/inventory-boundaries/${json<InventoryBoundaryVersionDTO>(copy).id}`);
    expect([deleted.status, deleted.text]).toEqual([204, '']);
  });
});

describe("a version's life (E3, E4, W7, W10)", () => {
  it('is created empty, declared one subsidiary at a time, confirmed whole — then takes no write and keeps its names', async () => {
    const created = await call(admin, 'POST', '/inventory-boundaries', { reportingYear: 2026 });
    const v1 = json<InventoryBoundaryVersionDTO>(created);
    expect(v1).toMatchObject({
      reportingYear: 2026, version: 1, decision: 'unconfirmed', decidedBy: null, decidedAt: null, frozenAt: null,
      createdBy: admin.id, view: 'organisation', boundaryGaps: [],
    });
    expect(v1.boundary.subsidiaryIds).toEqual([]);
    // An empty version is no inventory: not confirmable.
    expect((await call(admin, 'POST', `/inventory-boundaries/${v1.id}/confirm`)).code).toBe('boundary_incomplete');

    const putS = json<InventoryBoundaryVersionDTO>(await call(admin, 'PUT', `/inventory-boundaries/${v1.id}/subsidiaries/${S}`, completeS()));
    expect(putS.boundaryGaps).toEqual([]);
    expect(putS.boundary.subsidiaryIds).toEqual([S]);
    // A mapped source's scope is its category's; an unsupported one's its own.
    expect(putS.boundary.sources.map((s) => [s.name, s.scope]).sort()).toEqual([
      ['District heat', 2], ['Gas supply', 1], ['L1 main meter', 2], ['L2 main meter', 2],
    ]);
    // A site from April owes April to December, monthly, at its policy's cadence.
    const l2 = putS.boundary.sources.find((s) => s.name === 'L2 main meter');
    expect(l2?.applicability === 'included' && l2.obligations.map((o) => o.periodValue)).toEqual(
      ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    );

    // S2 without its Fuel policy: stored, reported, and blocking a confirmation.
    const gappy = excludedAll();
    const putS2 = json<InventoryBoundaryVersionDTO>(await call(admin, 'PUT', `/inventory-boundaries/${v1.id}/subsidiaries/${S2}`, {
      ...gappy,
      attribution: gappy.attribution.filter((p) => p.category !== 'Fuel'),
      applicability: gappy.applicability.filter((c) => c.category !== 'Fuel'),
    }));
    expect(putS2.boundaryGaps).toEqual([{
      code: 'applicability_undetermined', entity: { subsidiaryId: S2, locationId: null }, category: 'Fuel',
      sourceIds: [], obligationIds: [], recordIds: [],
    }]);
    expect((await call(admin, 'POST', `/inventory-boundaries/${v1.id}/confirm`)).code).toBe('boundary_incomplete');
    expect(await owner.inventoryBoundary.findUniqueOrThrow({ where: { id: v1.id } })).toMatchObject({ frozenAt: null, decision: 'unconfirmed' });

    await call(admin, 'PUT', `/inventory-boundaries/${v1.id}/subsidiaries/${S2}`, excludedAll());
    const confirmed = await call(admin, 'POST', `/inventory-boundaries/${v1.id}/confirm`);
    expect(confirmed.status).toBe(200);
    const done = json<InventoryBoundaryVersionDTO>(confirmed);
    expect(done).toMatchObject({ decision: 'confirmed', decidedBy: admin.id, boundaryGaps: [] });
    expect(done.frozenAt).not.toBeNull();
    // One step, the database's clock (the guard stamps both).
    expect(done.decidedAt).toBe(done.frozenAt);
    expect(done.boundary.decidedAt).toBe(done.decidedAt);
    // The names froze into the version (W7): a rename later does not reach it.
    const frozenRows = await owner.inventoryBoundarySubsidiary.findMany({ where: { boundaryId: v1.id } });
    expect(frozenRows.every((r) => r.subsidiaryName !== null && r.geographyCode !== null)).toBe(true);
    const nameOfS = done.boundary.entities.find((e) => e.subsidiaryId === S && e.locationId === null)?.subsidiaryName;
    await owner.subsidiary.update({ where: { id: S }, data: { tradingName: 'Renamed after the freeze' } });
    const reread = json<InventoryBoundaryVersionDTO>(await call(admin, 'GET', `/inventory-boundaries/${v1.id}`));
    expect(reread.boundary.entities.find((e) => e.subsidiaryId === S && e.locationId === null)?.subsidiaryName).toBe(nameOfS);

    // Frozen: every writer refused (W10), confirm too.
    for (const [method, path, body] of [
      ['PUT', `/inventory-boundaries/${v1.id}/subsidiaries/${S}`, completeS()],
      ['DELETE', `/inventory-boundaries/${v1.id}/subsidiaries/${S}`, undefined],
      ['DELETE', `/inventory-boundaries/${v1.id}`, undefined],
      ['POST', `/inventory-boundaries/${v1.id}/confirm`, undefined],
    ] as const) {
      const answer = await call(admin, method, path, body);
      expect([answer.status, answer.code], `${method} ${path}`).toEqual([409, 'boundary_frozen']);
    }

    // The year's next version; one open at most, the newest (E4); a deleted
    // open version frees its number.
    const v2 = json<InventoryBoundaryVersionDTO>(await call(admin, 'POST', '/inventory-boundaries', { reportingYear: 2026 }));
    expect(v2.version).toBe(2);
    const second = await call(admin, 'POST', '/inventory-boundaries', { reportingYear: 2026 });
    expect([second.status, second.code]).toEqual([409, 'boundary_draft_open']);
    expect((await call(admin, 'DELETE', `/inventory-boundaries/${v2.id}`)).status).toBe(204);
    const again = json<InventoryBoundaryVersionDTO>(await call(admin, 'POST', '/inventory-boundaries', { reportingYear: 2026 }));
    expect([again.version, again.id === v2.id]).toEqual([2, false]);
    // Another year is its own sequence.
    expect(json<InventoryBoundaryVersionDTO>(await call(admin, 'POST', '/inventory-boundaries', { reportingYear: 2027 })).version).toBe(1);

    const list = json<InventoryBoundaryVersionSummary[]>(await call(t.users.consultant, 'GET', '/inventory-boundaries?reportingYear=2026'));
    expect(list.map((v) => [v.version, v.id])).toEqual([[2, again.id], [1, v1.id]]);
    expect(Object.keys(list[0]).sort()).toEqual(
      ['createdAt', 'createdBy', 'decidedAt', 'decidedBy', 'decision', 'frozenAt', 'id', 'reportingYear', 'version'],
    );

    // One audit row per write, in its own transaction's order.
    const trail = await auditOf(v1.id);
    expect(trail.map((r) => r.action)).toEqual(['create', 'update', 'update', 'update', 'confirm']);
    expect(trail.every((r) => r.userId === admin.id && r.role === 'super_admin' && r.organisationId === t.organisationId)).toBe(true);
    const [, firstS2, secondS2] = trail.slice(1);
    expect(firstS2.diff).toMatchObject({ subsidiaryId: S2, before: null });
    expect((secondS2.diff as { before: unknown }).before).toEqual((firstS2.diff as { after: unknown }).after);
    expect(trail[4].diff).toMatchObject({ reportingYear: 2026, version: 1, decidedAt: done.decidedAt, frozenAt: done.frozenAt });
    const v2Trail = await auditOf(v2.id);
    expect(v2Trail.map((r) => r.action)).toEqual(['create', 'delete']);
    expect(v2Trail[1].diff).toMatchObject({ before: { id: v2.id, version: 2, subsidiaryIds: [] } });
  });

  it("refuses to confirm a version captured unconfirmed — its copy is confirmed instead (PR B's (4a), E3)", async () => {
    const id = await versionWith([[S, completeS()]]);
    // A dataset's capture freezes it unconfirmed (PR C); as the owner here.
    await owner.inventoryBoundary.update({ where: { id }, data: { frozenAt: new Date() } });
    const refused = await call(admin, 'POST', `/inventory-boundaries/${id}/confirm`);
    expect([refused.status, refused.code]).toEqual([409, 'boundary_confirm_requires_copy']);
    const captured = json<InventoryBoundaryVersionDTO>(await call(admin, 'GET', `/inventory-boundaries/${id}`));
    expect(captured).toMatchObject({ decision: 'unconfirmed', decidedBy: null, decidedAt: null });
    expect(captured.frozenAt).not.toBeNull();
    expect((await call(admin, 'PUT', `/inventory-boundaries/${id}/subsidiaries/${S}`, completeS())).code).toBe('boundary_frozen');
    const copy = json<InventoryBoundaryVersionDTO>(await call(admin, 'POST', '/inventory-boundaries', { reportingYear: 2026, copyOf: id }));
    expect(copy.version).toBe(2);
    const confirmed = await call(admin, 'POST', `/inventory-boundaries/${copy.id}/confirm`);
    expect(confirmed.status).toBe(200);
    expect((await auditOf(copy.id))[0].diff).toEqual({ reportingYear: 2026, version: 2, copyOf: id });
  });

  it.each([
    ['applicability_undetermined', () => completeS({ applicability: completeS().applicability.filter((c) => c.locationId !== L2) })],
    ['unsupported_source', () => completeS({
      sources: [...completeS().sources, {
        locationId: null, name: 'Steam', mapping: { kind: 'unsupported', reason: 'No factor in the library' }, scope: 1,
        reportingPeriod: 'annual', applicability: 'included', evidenceReportingPeriod: null,
      }],
    })],
    ['attribution_conflict', () => completeS({ sources: completeS().sources.filter((s) => s.name !== 'Gas supply') })],
  ] as const)('refuses to confirm a version with a %s gap — boundary_incomplete, and the version stays open', async (code, body) => {
    const id = await versionWith([[S, body()]]);
    const version = json<InventoryBoundaryVersionDTO>(await call(admin, 'GET', `/inventory-boundaries/${id}`));
    expect(version.boundaryGaps.map((g) => g.code)).toContain(code);
    const refused = await call(admin, 'POST', `/inventory-boundaries/${id}/confirm`);
    expect([refused.status, refused.code]).toEqual([409, 'boundary_incomplete']);
    expect((await auditOf(id)).map((r) => r.action)).toEqual(['create', 'update']);
  });

  it('copies across years: the declarations as they are, months included — names read live again until it freezes', async () => {
    const id2026 = await versionWith([[S, completeS()], [S2, excludedAll()]]);
    await serviceOn(runtime).confirm(admin, id2026);
    await owner.subsidiary.update({ where: { id: S }, data: { tradingName: 'Renamed for 2027' } });
    const copy = json<InventoryBoundaryVersionDTO>(await call(admin, 'POST', '/inventory-boundaries', { reportingYear: 2027, copyOf: id2026 }));
    expect(copy).toMatchObject({ reportingYear: 2027, version: 1, decision: 'unconfirmed', frozenAt: null, boundaryGaps: [] });
    for (const subsidiaryId of [S, S2]) {
      expect(withoutIds(await declared(copy.id, subsidiaryId))).toEqual(withoutIds(await declared(id2026, subsidiaryId)));
    }
    const fromIds = new Set((await owner.inventorySource.findMany({ where: { boundaryId: id2026 } })).map((s) => s.id));
    expect((await owner.inventorySource.findMany({ where: { boundaryId: copy.id } })).some((s) => fromIds.has(s.id))).toBe(false);
    expect((await owner.inventoryBoundarySubsidiary.findMany({ where: { boundaryId: copy.id } })).every((r) => r.subsidiaryName === null)).toBe(true);
    expect((await owner.inventoryBoundarySite.findMany({ where: { boundaryId: copy.id } })).every((r) => r.locationName === null)).toBe(true);
    expect(copy.boundary.entities.find((e) => e.subsidiaryId === S && e.locationId === null)?.subsidiaryName).toBe('Renamed for 2027');
    const source = json<InventoryBoundaryVersionDTO>(await call(admin, 'GET', `/inventory-boundaries/${id2026}`));
    expect(source.boundary.entities.find((e) => e.subsidiaryId === S && e.locationId === null)?.subsidiaryName).not.toBe('Renamed for 2027');
  });
});

describe("data_entry's view (W3): its granted subsidiaries' part, and nothing of a version declaring none", () => {
  it('lists only versions declaring a granted subsidiary, filters every collection, and answers the rest as missing', async () => {
    const both = await versionWith([[S, completeS()], [S2, excludedAll('Only the sibling says this')]]);
    await serviceOn(runtime).confirm(admin, both);
    const siblingOnly = await versionWith([[S2, excludedAll()]]);
    const empty = await versionWith([], 2025);
    const entry = t.users.dataEntry;

    const list2026 = json<InventoryBoundaryVersionSummary[]>(await call(entry, 'GET', '/inventory-boundaries?reportingYear=2026'));
    expect(list2026.map((v) => v.id)).toEqual([both]);
    expect(json<InventoryBoundaryVersionSummary[]>(await call(entry, 'GET', '/inventory-boundaries?reportingYear=2025'))).toEqual([]);
    expect(json<InventoryBoundaryVersionSummary[]>(await call(t.users.consultant, 'GET', '/inventory-boundaries?reportingYear=2026')).map((v) => v.id))
      .toEqual([siblingOnly, both]);

    const view = await call(entry, 'GET', `/inventory-boundaries/${both}`);
    const dto = json<InventoryBoundaryVersionDTO>(view);
    expect(dto.view).toBe('granted_subsidiaries');
    expect(dto.boundary.subsidiaryIds).toEqual([S]);
    expect(dto.boundary.entities.map((e) => e.locationId)).toEqual([null, L1, L2].sort((a, b) => String(a ?? '').localeCompare(String(b ?? ''))));
    const sibling = await owner.subsidiary.findUniqueOrThrow({ where: { id: S2 } });
    for (const marker of [S2, M1, sibling.legalName, 'Only the sibling says this']) {
      expect(view.text, marker).not.toContain(marker);
    }
    // Everyone else reads the whole inventory.
    const whole = json<InventoryBoundaryVersionDTO>(await call(t.users.executiveViewer, 'GET', `/inventory-boundaries/${both}`));
    expect([whole.view, whole.boundary.subsidiaryIds.length]).toEqual(['organisation', 2]);

    const missing = await call(entry, 'GET', `/inventory-boundaries/${randomUUID()}`);
    expect([missing.status, missing.code]).toEqual([404, 'boundary_not_found']);
    for (const hidden of [siblingOnly, empty]) {
      const answer = await call(entry, 'GET', `/inventory-boundaries/${hidden}`);
      expect([answer.status, answer.text]).toEqual([missing.status, missing.text]);
    }
  });
});

describe('whose subsidiary and site a declaration may name', () => {
  it("refuses a sibling's site as location_not_found — byte for byte as a missing one — and an undeclared subsidiary's removal as subsidiary_not_found", async () => {
    const id = await versionWith([]);
    const withSite = (locationId: string) => completeS({
      sites: [{ locationId, firstMonth: 1, lastMonth: 12 }],
      applicability: completeS().applicability.filter((c) => c.locationId === null),
      sources: completeS().sources.filter((s) => s.locationId === null),
    });
    const sibling = await call(admin, 'PUT', `/inventory-boundaries/${id}/subsidiaries/${S}`, withSite(M1));
    const missing = await call(admin, 'PUT', `/inventory-boundaries/${id}/subsidiaries/${S}`, withSite(randomUUID()));
    expect([sibling.status, sibling.code]).toEqual([404, 'location_not_found']);
    expect(sibling.text).toBe(missing.text);
    // One own site beside a sibling's is refused as a whole, the same way (`qa-auditor` P3).
    const mixed = await call(admin, 'PUT', `/inventory-boundaries/${id}/subsidiaries/${S}`, completeS({
      sites: [{ locationId: L1, firstMonth: 1, lastMonth: 12 }, { locationId: M1, firstMonth: 1, lastMonth: 12 }],
      applicability: completeS().applicability.filter((c) => c.locationId !== L2),
      sources: completeS().sources.filter((s) => s.locationId !== L2),
    }));
    expect([mixed.status, mixed.text]).toEqual([404, sibling.text]);
    // What the database would refuse, the DTOs refuse first — never the guard's 500 (`qa-auditor` P2).
    const early = await call(admin, 'PUT', `/inventory-boundaries/${id}/subsidiaries/${S}`, completeS({ firstMonth: 4 }));
    expect([early.status, early.code]).toEqual([400, 'validation_failed']);
    const noId = await call(admin, 'POST', '/inventory-boundaries', { reportingYear: 2027, copyOf: 'not-an-id' });
    expect([noId.status, noId.code]).toEqual([400, 'validation_failed']);
    const undeclared = await call(admin, 'DELETE', `/inventory-boundaries/${id}/subsidiaries/${S2}`);
    expect([undeclared.status, undeclared.code]).toEqual([404, 'subsidiary_not_found']);
    expect((await call(admin, 'PUT', `/inventory-boundaries/${id}/subsidiaries/${randomUUID()}`, excludedAll())).code).toBe('subsidiary_not_found');
    expect(await declared(id, S)).toBeNull();
  });

  it("holds a subsidiary of 300 sites, attributed per site, in one PUT — past the global 100 KB cap (follow-up (4))", async () => {
    const sites = (await owner.location.createManyAndReturn({
      data: Array.from({ length: 300 }, (_, i) => ({ subsidiaryId: S, name: `Int-test store ${i}`, geographyCode: 'UK' })),
    })).map((l) => l.id);
    const base2 = completeS();
    const body = completeS({
      sites: sites.map((locationId) => ({ locationId, firstMonth: 1, lastMonth: 12 })),
      applicability: [
        ...base2.applicability.filter((c) => c.locationId === null),
        ...sites.map((locationId) => ({ locationId, category: 'Electricity' as const, applicability: 'included' as const })),
      ],
      sources: [
        ...base2.sources.filter((s) => s.locationId === null),
        ...sites.map((locationId, i) => ({
          locationId, name: `Store ${i} main meter`, mapping: { kind: 'mapped' as const, category: 'Electricity' as const, activityType: null },
          applicability: 'included' as const, evidenceReportingPeriod: 'monthly' as const,
        })),
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(102_400);
    const id = await versionWith([]);
    const answer = await call(admin, 'PUT', `/inventory-boundaries/${id}/subsidiaries/${S}`, body);
    expect(answer.status, answer.text.slice(0, 300)).toBe(200);
    expect(json<InventoryBoundaryVersionDTO>(answer).boundaryGaps).toEqual([]);
    const tooBig = await call(admin, 'POST', '/inventory-boundaries', { reportingYear: 2027, padding: 'x'.repeat(102_400) });
    expect([tooBig.status, tooBig.code]).toEqual([413, 'payload_too_large']);
  });
});

describe('concurrent writers (W8, E5; PR B (6))', () => {
  it("two creates of one year's next version: one wins, the other is told conflict", async () => {
    const clientA = connect(1);
    const clientB = connect(1);
    try {
      const hold = holdBefore(clientA, 'InventoryBoundary', 'create');
      const first = serviceOn(hold.client).create(admin, { reportingYear: 2026 });
      await hold.reached();
      const second = await serviceOn(clientB).create(admin, { reportingYear: 2026 });
      expect(second.version).toBe(1);
      hold.release();
      expect(answered(await failure(first))).toBe('conflict');
      const versions = await owner.inventoryBoundary.findMany({ where: { organisationId: t.organisationId } });
      expect(versions.map((v) => v.id)).toEqual([second.id]);
      expect(await owner.auditLog.count({ where: { organisationId: t.organisationId, entity: 'inventory_boundary', action: 'create' } })).toBe(1);
    } finally {
      await Promise.all([clientA.$disconnect(), clientB.$disconnect()]);
    }
  });

  /** Holds A's write after its header lock, starts B, and proves B waits on it. */
  async function serialised<A, B>(
    holdModel: Parameters<typeof holdBefore>[1],
    holdOperation: string,
    runA: (service: InventoryBoundariesService) => Promise<A>,
    runB: (service: InventoryBoundariesService) => Promise<B>,
  ): Promise<{ a: PromiseSettledResult<A>; b: PromiseSettledResult<B> }> {
    const clientA = connect(1);
    const clientB = connect(1);
    try {
      const hold = holdBefore(clientA, holdModel, holdOperation);
      const a = runA(serviceOn(hold.client));
      await hold.reached();
      const pidB = await backendPid(clientB);
      const b = runB(serviceOn(clientB));
      expect(await settledOrBlocked(b, pidB, observer)).toBe('blocked');
      hold.release();
      const [ra, rb] = await Promise.allSettled([a, b]);
      return { a: ra, b: rb };
    } finally {
      await Promise.all([clientA.$disconnect(), clientB.$disconnect()]);
    }
  }

  it('serialises two PUTs of one subsidiary: the second waits, and its audit row holds what the first wrote', async () => {
    const id = await versionWith([[S, completeS()]]);
    const first = completeS({ firstMonth: 2, sites: [{ locationId: L1, firstMonth: 2, lastMonth: 12 }, { locationId: L2, firstMonth: 4, lastMonth: 12 }] });
    const second = completeS({ lastMonth: 11, sites: [{ locationId: L1, firstMonth: 1, lastMonth: 11 }, { locationId: L2, firstMonth: 4, lastMonth: 11 }] });
    const { a, b } = await serialised(
      'InventoryBoundarySubsidiary', 'deleteMany',
      (s) => s.putSubsidiary(admin, id, S, first),
      (s) => s.putSubsidiary(admin, id, S, second),
    );
    expect([a.status, b.status]).toEqual(['fulfilled', 'fulfilled']);
    const [, , byA, byB] = await auditOf(id);
    expect((byB.diff as { before: unknown }).before).toEqual((byA.diff as { after: unknown }).after);
    expect(withoutIds(await declared(id, S))).toEqual(canonical(second));
  });

  it('a copy waits for an edit of its source and takes it whole — and an edit waits for a copy reading it', async () => {
    const id = await versionWith([[S, completeS()]]);
    const edited = completeS({ sources: completeS().sources.filter((s) => s.name !== 'District heat') });
    const { a, b } = await serialised(
      'InventoryBoundarySubsidiary', 'deleteMany',
      (s) => s.putSubsidiary(admin, id, S, edited),
      (s) => s.create(admin, { reportingYear: 2027, copyOf: id }),
    );
    expect([a.status, b.status]).toEqual(['fulfilled', 'fulfilled']);
    const copy = (b as PromiseFulfilledResult<InventoryBoundaryVersionDTO>).value;
    expect(withoutIds(await declared(copy.id, S))).toEqual(withoutIds(await declared(id, S)));
    expect((await declared(copy.id, S))?.sources.map((s) => s.name)).not.toContain('District heat');

    const id2028 = (await serialised(
      'InventoryBoundary', 'create',
      (s) => s.create(admin, { reportingYear: 2028, copyOf: id }),
      (s) => s.putSubsidiary(admin, id, S, completeS()),
    )).a;
    expect(id2028.status).toBe('fulfilled');
    const copy2028 = (id2028 as PromiseFulfilledResult<InventoryBoundaryVersionDTO>).value;
    // Taken before the edit committed: without District heat, as the source was.
    expect((await declared(copy2028.id, S))?.sources.map((s) => s.name)).not.toContain('District heat');
    expect((await declared(id, S))?.sources.map((s) => s.name)).toContain('District heat');
  });

  it('a confirmation and an edit, either way round: the loser is refused by name — never a 500', async () => {
    const id = await versionWith([[S, completeS()]]);
    const incomplete = completeS({ sources: completeS().sources.filter((s) => s.name !== 'Gas supply') });
    const editFirst = await serialised(
      'InventoryBoundarySubsidiary', 'deleteMany',
      (s) => s.putSubsidiary(admin, id, S, incomplete),
      (s) => s.confirm(admin, id),
    );
    expect(editFirst.a.status).toBe('fulfilled');
    expect(errorCodeOf((editFirst.b as PromiseRejectedResult).reason)).toBe('boundary_incomplete');

    await serviceOn(runtime).putSubsidiary(admin, id, S, completeS());
    const confirmFirst = await serialised(
      'InventoryBoundary', 'update',
      (s) => s.confirm(admin, id),
      (s) => s.putSubsidiary(admin, id, S, incomplete),
    );
    expect(confirmFirst.a.status).toBe('fulfilled');
    expect(errorCodeOf((confirmFirst.b as PromiseRejectedResult).reason)).toBe('boundary_frozen');
  });

  it("an edit waiting on a version's deletion finds it gone: boundary_not_found", async () => {
    const id = await versionWith([[S, completeS()]]);
    const { a, b } = await serialised(
      'InventoryBoundary', 'delete',
      (s) => s.remove(admin, id),
      (s) => s.putSubsidiary(admin, id, S, completeS()),
    );
    expect(a.status).toBe('fulfilled');
    expect(errorCodeOf((b as PromiseRejectedResult).reason)).toBe('boundary_not_found');
    expect(await owner.inventoryBoundarySubsidiary.count({ where: { boundaryId: id } })).toBe(0);
  });

  it('a site or the subsidiary deleted between the check and the write: conflict, and nothing written', async () => {
    const id = await versionWith([[S, completeS()]]);
    const before = await boundaryState();
    const L3 = (await owner.location.create({ data: { subsidiaryId: S, name: 'Int-test L3', geographyCode: 'UK' } })).id;
    const client = connect(1);
    try {
      const hold = holdBefore(client, 'InventoryBoundarySite', 'createMany');
      const write = serviceOn(hold.client).putSubsidiary(admin, id, S, completeS({
        sites: [...completeS().sites, { locationId: L3, firstMonth: 1, lastMonth: 12 }],
      }));
      await hold.reached();
      await owner.location.delete({ where: { id: L3 } });
      hold.release();
      expect(answered(await failure(write))).toBe('conflict');
    } finally {
      await client.$disconnect();
    }
    expect(await boundaryState()).toBe(before);

    const S3 = (await owner.subsidiary.create({ data: { organisationId: t.organisationId, legalName: 'Int-test short-lived', geographyCode: 'UK' } })).id;
    const client2 = connect(1);
    try {
      const hold = holdBefore(client2, 'InventoryBoundarySubsidiary', 'create');
      const write = serviceOn(hold.client).putSubsidiary(admin, id, S3, excludedAll());
      await hold.reached();
      await owner.subsidiary.delete({ where: { id: S3 } });
      hold.release();
      expect(answered(await failure(write))).toBe('conflict');
    } finally {
      await client2.$disconnect();
    }
    expect(await boundaryState()).toBe(before);
  });
});

describe('audit atomicity: the write and its audit row commit together or not at all', () => {
  const writes: Array<[string, (s: InventoryBoundariesService, id: string) => Promise<unknown>]> = [
    ['create', (s) => s.create(admin, { reportingYear: 2027 })],
    ['create (copy)', (s, id) => s.create(admin, { reportingYear: 2027, copyOf: id })],
    ['put', (s, id) => s.putSubsidiary(admin, id, S2, excludedAll())],
    ['delete a subsidiary', (s, id) => s.deleteSubsidiary(admin, id, S)],
    ['confirm', (s, id) => s.confirm(admin, id)],
    ['delete the version', (s, id) => s.remove(admin, id)],
  ];

  it.each(writes)('%s: a failed audit insert leaves no write; a write rolled back after it leaves no audit row', async (_name, write) => {
    const id = await versionWith([[S, completeS()]]);
    const before = await boundaryState();
    const failing = failingAuditClient(runtime);
    expect(String(await failure(write(serviceOn(failing), id)))).toContain(INJECTED_AUDIT_FAILURE);
    expect(await boundaryState()).toBe(before);
    const client = connect(2);
    try {
      expect(String(await failure(write(serviceOn(abortAfterAuditClient(client)), id)))).toContain(ABORTED_AFTER_AUDIT);
    } finally {
      await client.$disconnect();
    }
    expect(await boundaryState()).toBe(before);
    // And the write itself succeeds, so the two above refused something real.
    await write(serviceOn(runtime), id);
    expect(await boundaryState()).not.toBe(before);
  });
});

describe('no valid sequence of writes reaches the guard (TA014, E7)', () => {
  it("narrows months under declared sites, moves a policy's cadence under its sources, moves a source, drops a site, removes a subsidiary and the version", async () => {
    const service = serviceOn(runtime);
    const id = await versionWith([[S, completeS()], [S2, excludedAll()]]);
    // Months narrowed below sites that the old declaration held wider.
    await service.putSubsidiary(admin, id, S, completeS({
      firstMonth: 6, lastMonth: 9,
      sites: [{ locationId: L1, firstMonth: 6, lastMonth: 9 }, { locationId: L2, firstMonth: 7, lastMonth: 8 }],
    }));
    // Electricity's cadence moved under its included sources (the cadence key).
    const quarterly = completeS({
      attribution: completeS().attribution.map((p) => (p.category === 'Electricity' ? { ...p, reportingPeriod: 'quarterly' as const } : p)),
    });
    const moved = await service.putSubsidiary(admin, id, S, quarterly);
    expect(moved.boundary.sources.filter((s) => s.applicability === 'included' && s.mapping.kind === 'mapped' && s.mapping.category === 'Electricity')
      .map((s) => s.applicability === 'included' && s.reportingPeriod)).toEqual(['quarterly', 'quarterly']);
    // A source moved from the company entity to a site, and a site dropped.
    await service.putSubsidiary(admin, id, S, completeS({
      sites: [{ locationId: L1, firstMonth: 1, lastMonth: 12 }],
      attribution: completeS().attribution.map((p) => (p.category === 'Natural Gas' ? { ...p, level: 'sites' as const } : p)),
      applicability: [
        ...completeS().applicability.filter((c) => c.locationId === null && c.category !== 'Natural Gas'),
        { locationId: L1, category: 'Electricity', applicability: 'included' },
        { locationId: L1, category: 'Natural Gas', applicability: 'included' },
      ],
      sources: [
        { locationId: L1, name: 'Gas supply', mapping: { kind: 'mapped', category: 'Natural Gas', activityType: null }, applicability: 'included', evidenceReportingPeriod: null },
        { locationId: L1, name: 'L1 main meter', mapping: { kind: 'mapped', category: 'Electricity', activityType: null }, applicability: 'included', evidenceReportingPeriod: 'monthly' },
      ],
    }));
    await service.deleteSubsidiary(admin, id, S2);
    // A declared site's own delete is still the guard's (W9) — answered 409 by its path, untouched here.
    await service.remove(admin, id);
    expect(await owner.inventoryBoundary.count({ where: { id } })).toBe(0);
    expect((await auditOf(id)).map((r) => r.action)).toEqual(['create', 'update', 'update', 'update', 'update', 'update', 'update', 'delete']);
  });
});
