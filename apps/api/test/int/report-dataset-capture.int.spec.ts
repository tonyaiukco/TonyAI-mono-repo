/**
 * LP3-04 PR C on the real database (README "Inventory coverage and report
 * datasets"; Decisions 2026-10-15 (ninth), V1–V12): the dataset routes
 * through the deployed app as the runtime role, and the retained table's
 * guard (TA016) as every writer meets it.
 *
 * A capture freezes an open version in a READ COMMITTED transaction of its
 * own — super_admin's alone — before its REPEATABLE READ snapshot opens; a
 * retry freezes nothing; one that fails after its freeze leaves the version
 * frozen and no dataset (PR B follow-up (4a)). Everything a dataset holds is
 * one moment's: a rename, a withdrawal, a new record and a void committed
 * mid-capture are not in it. It is retained as its exact text — the
 * fingerprint recomputes from it, parsed and canonicalised — read back only by
 * a caller holding every subsidiary it references — otherwise, and across
 * organisations, as not found.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import {
  directCalorificBasisFor, scope2MethodFor,
  type PutInventoryBoundarySubsidiaryRequest, type ReportDataset, type ReportDatasetList, type ReportDatasetSummary,
} from '@tonyai/shared-types';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecordStatus } from '@tonyai/db';
import { AuditService } from '../../src/audit/audit.service';
import type { RequestUser } from '../../src/auth/auth.types';
import { errorCodeOf } from '../../src/common/api-error';
import { InventoryBoundariesService } from '../../src/inventory-boundary/inventory-boundaries.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { reportDatasetFingerprint } from '../../src/report-datasets/dataset-fingerprint';
import { listDatasetSummaries, readDatasetContent } from '../../src/report-datasets/dataset-store';
import { ReportDatasetsService } from '../../src/report-datasets/report-datasets.service';
import { apiTokenIssuer, attachEvidence, backendPid, connect, connectLoader, connectOwner, createRecord, createTenant, holdBefore, settledOrBlocked, withRollback, type Tenant } from './db';
import { ABORTED_AFTER_AUDIT, abortAfterAuditClient, failingAuditClient, INJECTED_AUDIT_FAILURE } from './services';

const JWT_SECRET = randomBytes(32).toString('hex');
/** No other spec prices or captures this year (PR B's fixture factor holds 2087). */
const YEAR = 2076;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

let app: INestApplication;
let base: string;
let owner: PrismaService;
let ownerB: PrismaService;
let runtime: PrismaService;
/** The fixture release every record of this spec is priced with (YEAR, UK electricity). */
let releaseId: string;

let t: Tenant;
let S: string;
let S2: string;
let L1: string;

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
  ownerB = connectOwner(1);
  runtime = connect(2);
  releaseId = await fixtureRelease(YEAR);
}, 60_000);

afterAll(async () => {
  if (releaseId) await dropRelease(releaseId);
  await Promise.all([owner?.$disconnect(), ownerB?.$disconnect(), runtime?.$disconnect()]);
  await app?.close();
});

beforeEach(async () => {
  t = await createTenant();
  S = t.subsidiaryId;
  L1 = (await owner.location.create({ data: { subsidiaryId: S, name: 'Int-test L1', geographyCode: 'UK' } })).id;
  S2 = (await owner.subsidiary.create({
    data: { organisationId: t.organisationId, legalName: `Int-test sibling ${randomUUID().slice(0, 8)}`, geographyCode: 'UK' },
  })).id;
});

// The organisation's deletion takes its versions and datasets, frozen and retained ones included (W10).
afterEach(async () => {
  await t?.cleanup();
});

// --------------------------------------------------------------------------
// Fixtures

/** A sealed fixture release with one UK electricity factor for `year` — no seed release prices that year. */
async function fixtureRelease(year: number): Promise<string> {
  return owner.$transaction(async (tx) => {
    const [{ next }] = await tx.$queryRaw<{ next: number }[]>`
      SELECT COALESCE(max(ordinal), 0) + 1 AS next FROM factor_releases WHERE publisher = 'TonyAI test fixture'`;
    const created = await tx.factorRelease.create({
      data: { publisher: 'TonyAI test fixture', title: 'Int test capture', edition: `int-${randomUUID()}`, ordinal: Number(next), status: 'fixture' },
    });
    await tx.emissionFactor.create({
      data: {
        releaseId: created.id, version: created.edition, category: 'Electricity', activityType: 'grid_electricity', gas: 'CO2e', gasCoverage: 'all_ghg',
        geographyCode: 'UK', reportingYear: year, dataYear: year, scope: 2, scope2Method: scope2MethodFor('Electricity'),
        calorificBasis: directCalorificBasisFor('Electricity', 'kWh'), factorValue: 0.2, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh',
        methodology: 'int test', source: 'int test',
      },
    });
    await tx.factorRelease.update({ where: { id: created.id }, data: { sealedAt: new Date() } });
    return created.id;
  });
}

async function dropRelease(id: string): Promise<void> {
  await owner.emissionFactor.deleteMany({ where: { releaseId: id } });
  await owner.factorRelease.deleteMany({ where: { id } });
}

/** S's whole declaration: L1's meter monthly, everything else excluded at the company. No gap. */
function declaration(): PutInventoryBoundarySubsidiaryRequest {
  return {
    firstMonth: 1,
    lastMonth: 12,
    sites: [{ locationId: L1, firstMonth: 1, lastMonth: 12 }],
    attribution: [
      { category: 'Electricity', level: 'sites', reportingPeriod: 'monthly' },
      { category: 'Natural Gas', level: 'company', reportingPeriod: 'annual' },
      { category: 'Fuel', level: 'company', reportingPeriod: 'annual' },
      { category: 'Mobile Combustion', level: 'company', reportingPeriod: 'annual' },
      { category: 'Refrigerants', level: 'company', reportingPeriod: 'annual' },
    ],
    applicability: [
      { locationId: L1, category: 'Electricity', applicability: 'included' },
      { locationId: null, category: 'Natural Gas', applicability: 'excluded', reason: 'No gas supply' },
      { locationId: null, category: 'Fuel', applicability: 'excluded', reason: 'No fuel burnt on site' },
      { locationId: null, category: 'Mobile Combustion', applicability: 'excluded', reason: 'No company vehicles' },
      { locationId: null, category: 'Refrigerants', applicability: 'excluded', reason: 'No refrigeration plant' },
    ],
    sources: [
      { locationId: L1, name: 'L1 main meter', mapping: { kind: 'mapped', category: 'Electricity', activityType: null }, applicability: 'included', evidenceReportingPeriod: null },
    ],
  };
}

/** A holding's whole declaration: every category excluded at the company. No gap. */
function holdingDeclaration(): PutInventoryBoundarySubsidiaryRequest {
  const categories = ['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants'] as const;
  return {
    firstMonth: 1, lastMonth: 12, sites: [],
    attribution: categories.map((category) => ({ category, level: 'company', reportingPeriod: 'annual' })),
    applicability: categories.map((category) => ({ locationId: null, category, applicability: 'excluded', reason: 'Holding company' })),
    sources: [],
  };
}

const admin = () => t.users.superAdmin;
/** A user as the guard would build it: every subsidiary of the organisation, now. */
async function withAccess(user: RequestUser): Promise<RequestUser> {
  const subs = await owner.subsidiary.findMany({ where: { organisationId: t.organisationId }, select: { id: true } });
  return { ...user, accessibleSubsidiaryIds: subs.map((s) => s.id) };
}

/** An open version of S for `year`, declared whole, written by the routes' service. */
async function openVersion(year = YEAR): Promise<string> {
  const service = new InventoryBoundariesService(runtime, new AuditService(runtime));
  const user = await withAccess(admin());
  const { id } = await service.create(user, { reportingYear: year });
  await service.putSubsidiary(user, id, S, declaration());
  return id;
}

/** An open version of `year` declaring S (whole) and S2 (a holding). */
async function twoSubsidiaryVersion(year = YEAR): Promise<string> {
  const service = new InventoryBoundariesService(runtime, new AuditService(runtime));
  const user = await withAccess(admin());
  const { id } = await service.create(user, { reportingYear: year });
  await service.putSubsidiary(user, id, S, declaration());
  await service.putSubsidiary(user, id, S2, holdingDeclaration());
  return id;
}

/** L1's twelve months of `year`, approved and priced by the fixture release. */
async function yearOfRecords(year = YEAR, status: ActivityRecordStatus = ActivityRecordStatus.approved) {
  const records: Array<Awaited<ReturnType<typeof createRecord>>> = [];
  for (const periodValue of MONTHS) {
    records.push(await createRecord(owner, t, {
      locationId: L1, reportingYear: year, periodValue, status, reviewedBy: admin().id, reviewedAt: new Date(),
    }, { priced: true }));
  }
  return records;
}

// --------------------------------------------------------------------------
// HTTP

async function tokenFor(userId: string): Promise<string> {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(apiTokenIssuer())
    .setSubject(userId)
    .setAudience('authenticated')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

interface Answer { status: number; text: string; code: string | undefined; contentType: string | null }

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
  return { status: res.status, text, code, contentType: res.headers.get('content-type') };
}

const capture = (user: RequestUser, body: Record<string, unknown>) => call(user, 'POST', '/report-datasets', body);
const summaryOf = (a: Answer) => JSON.parse(a.text) as ReportDatasetSummary;

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

// --------------------------------------------------------------------------
// Database reads

const versionRow = (id: string) => owner.inventoryBoundary.findUniqueOrThrow({ where: { id } });
const audits = (entity: string) =>
  owner.auditLog.findMany({ where: { organisationId: t.organisationId, entity }, orderBy: { createdAt: 'asc' } });
const stored = (id: string) => owner.reportDataset.findUniqueOrThrow({ where: { id } });
const datasetCount = () => owner.reportDataset.count({ where: { organisationId: t.organisationId } });

/** The PostgreSQL code a raw statement failed with. */
function sqlState(e: unknown): string | undefined {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2010') return (e.meta as { code?: string }).code;
  return undefined;
}

// --------------------------------------------------------------------------

describe('a capture over HTTP', () => {
  it("freezes an open version unconfirmed first, then retains the exact text it fingerprinted, with both audit rows", async () => {
    const boundaryId = await openVersion();
    const records = await yearOfRecords();
    const answer = await capture(admin(), { boundaryId });
    expect(answer.status, answer.text).toBe(201);
    const summary = summaryOf(answer);

    const version = await versionRow(boundaryId);
    expect(version.frozenAt).not.toBeNull();
    expect(version.decision).toBe('unconfirmed');

    const row = await stored(summary.datasetId);
    const dataset = JSON.parse(row.content) as ReportDataset;
    // Recomputable from what is stored — the issuance's check, ahead of it.
    expect(reportDatasetFingerprint(dataset)).toEqual(dataset.fingerprint);
    expect(row.fingerprintHex).toBe(dataset.fingerprint.hex);
    expect(summary).toEqual({
      datasetId: row.id, capturedAt: dataset.capturedAt, capturedBy: admin().id, context: { year: YEAR },
      selection: 'inventory', boundary: { id: boundaryId, version: version.version, decision: 'unconfirmed' }, fingerprint: dataset.fingerprint,
    });
    expect(row.capturedAt.toISOString()).toBe(dataset.capturedAt);
    expect(row.referencedSubsidiaryIds).toEqual([S]);
    expect(dataset.boundary.subsidiaryIds).toEqual([S]);
    expect(dataset.resolvedSubsidiaryIds).toEqual([S]);
    // The freeze copied the names in (W7).
    expect(dataset.boundary.entities.find((e) => e.locationId === L1)?.locationName).toBe('Int-test L1');

    // Twelve approved months, priced by the fixture: every obligation met, the
    // only gap the unconfirmed boundary's; the figure the records' own.
    expect(dataset.records.map((r) => r.id).sort()).toEqual(records.map((r) => r.id).sort());
    expect(dataset.coverage.obligations).toHaveLength(12);
    expect(dataset.coverage.obligations.every((o) => o.state === 'satisfied')).toBe(true);
    expect(dataset.coverage.gaps.map((g) => g.code)).toEqual(['boundary_unconfirmed']);
    expect(dataset.scopes[1]).toMatchObject({ scope: 2, coverage: 'partial', countedRecordIds: records.map((r) => r.id).sort() });
    expect(dataset.scopes[1].tCo2e).toBeCloseTo(12 * 100 * 0.2 / 1000, 12);
    expect(dataset.provenance.releases.map((r) => r.id)).toEqual([releaseId]);
    expect(dataset.provenance.records.every((r) => r.standing === 'non_authoritative' && r.issues.includes('fixture_release'))).toBe(true);

    const [freeze] = await audits('inventory_boundary').then((rows) => rows.filter((r) => r.action === 'freeze'));
    expect(freeze).toMatchObject({ userId: admin().id, entityId: boundaryId, diff: { cause: 'capture', frozenAt: version.frozenAt!.toISOString() } });
    const captures = await audits('report_dataset');
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ action: 'capture', entityId: row.id, diff: { fingerprint: row.fingerprintHex, records: 12 } });

    // Read back: the stored text, byte for byte, as JSON.
    const read = await call(t.users.executiveViewer, 'GET', `/report-datasets/${row.id}`);
    expect(read.status).toBe(200);
    expect(read.contentType).toMatch(/^application\/json/);
    expect(read.text).toBe(row.content);
    const list = await call(t.users.consultant, 'GET', `/report-datasets?year=${YEAR}`);
    expect(JSON.parse(list.text)).toEqual({ items: [summary], truncated: false });
  });

  it('retries on the frozen version: no second freeze, the same facts the same fingerprint', async () => {
    const boundaryId = await openVersion();
    await yearOfRecords();
    const first = summaryOf(await capture(admin(), { boundaryId }));
    const frozenAt = (await versionRow(boundaryId)).frozenAt;
    const second = await capture(admin(), { boundaryId });
    expect(second.status).toBe(201);
    expect(summaryOf(second).datasetId).not.toBe(first.datasetId);
    expect(summaryOf(second).fingerprint).toEqual(first.fingerprint);
    expect((await versionRow(boundaryId)).frozenAt).toEqual(frozenAt);
    expect((await audits('inventory_boundary')).filter((r) => r.action === 'freeze')).toHaveLength(1);
    expect(await datasetCount()).toBe(2);
  });

  it('lets only super_admin freeze an open version; a consultant captures one already frozen; data_entry and executive_viewer capture nothing', async () => {
    const boundaryId = await openVersion();
    for (const user of [t.users.dataEntry, t.users.executiveViewer]) {
      const refused = await capture(user, { boundaryId });
      expect([refused.status, refused.code]).toEqual([403, 'forbidden']);
    }
    const refused = await capture(t.users.consultant, { boundaryId });
    expect([refused.status, refused.code]).toEqual([403, 'forbidden']);
    expect((await versionRow(boundaryId)).frozenAt).toBeNull();
    expect(await audits('inventory_boundary').then((rows) => rows.filter((r) => r.action === 'freeze'))).toEqual([]);

    expect((await capture(admin(), { boundaryId })).status).toBe(201);
    expect((await capture(t.users.consultant, { boundaryId })).status).toBe(201);
    // Captured unconfirmed, it is confirmed only as a copy.
    const confirm = await call(admin(), 'POST', `/inventory-boundaries/${boundaryId}/confirm`);
    expect([confirm.status, confirm.code]).toEqual([409, 'boundary_confirm_requires_copy']);
  });

  it('captures a confirmed version with no gap and no freeze of its own', async () => {
    const boundaryId = await openVersion();
    expect((await call(admin(), 'POST', `/inventory-boundaries/${boundaryId}/confirm`)).status).toBe(200);
    await yearOfRecords();
    const dataset = JSON.parse((await stored(summaryOf(await capture(t.users.consultant, { boundaryId })).datasetId)).content) as ReportDataset;
    expect(dataset.boundary.decision).toBe('confirmed');
    expect(dataset.coverage.gaps).toEqual([]);
    expect(dataset.scopes[1].coverage).toBe('covered');
    expect((await audits('inventory_boundary')).map((r) => r.action)).not.toContain('freeze');
    const list = (JSON.parse((await call(admin(), 'GET', `/report-datasets?year=${YEAR}`)).text) as ReportDatasetList).items;
    expect(list.map((d) => d.boundary.decision)).toEqual(['confirmed']);
    expect(JSON.parse((await call(admin(), 'GET', `/report-datasets?year=${YEAR + 5}`)).text)).toEqual({ items: [], truncated: false });
  });

  it("reads exactly the selection's Scope 1/2 records of the year, their evidence and the year's locks, by the organisation's reported name", async () => {
    // A version declaring S and S2 (S2 a holding: every category excluded).
    const service = new InventoryBoundariesService(runtime, new AuditService(runtime));
    const user = await withAccess(admin());
    const { id: boundaryId } = await service.create(user, { reportingYear: YEAR });
    await service.putSubsidiary(user, boundaryId, S, declaration());
    await service.putSubsidiary(user, boundaryId, S2, {
      firstMonth: 1, lastMonth: 12, sites: [],
      attribution: (['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants'] as const).map((category) => ({ category, level: 'company', reportingPeriod: 'annual' })),
      applicability: (['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants'] as const).map((category) => ({ locationId: null, category, applicability: 'excluded', reason: 'Holding company' })),
      sources: [],
    });
    await owner.organisation.update({ where: { id: t.organisationId }, data: { tradingName: 'Int-test trading name' } });
    const electricity = await yearOfRecords();
    const gas = await createRecord(owner, t, { category: 'Natural Gas', reportingYear: YEAR, reportingPeriod: 'annual', periodValue: 'Annual', status: ActivityRecordStatus.approved });
    const sibling = await createRecord(owner, { ...t, subsidiaryId: S2 }, { reportingYear: YEAR, status: ActivityRecordStatus.approved });
    // Never captured: Scope 3, another year, another organisation's.
    await createRecord(owner, t, { category: 'Water', activityUnit: 'm3', reportingYear: YEAR, status: ActivityRecordStatus.approved });
    await createRecord(owner, t, { locationId: L1, reportingYear: YEAR + 1, status: ActivityRecordStatus.approved });
    const other = await createTenant();
    try {
      await createRecord(owner, other, { reportingYear: YEAR, status: ActivityRecordStatus.approved });
      const meterFile = await attachEvidence(owner, t, [electricity[0].id, electricity[1].id]);
      await owner.evidence.update({ where: { id: meterFile.id }, data: { sha256: 'b'.repeat(64) } });
      const gasFile = await attachEvidence(owner, t, [gas.id]);
      const lock = (subsidiaryId: string, reportingYear: number) => owner.periodLock.create({
        data: { subsidiaryId, reportingYear, reportingPeriod: 'annual', periodValue: 'Annual', lockedBy: admin().id },
      });
      const locks = [await lock(S, YEAR), await lock(S2, YEAR)];
      await lock(S, YEAR + 1);

      const read = async (body: Record<string, unknown>) =>
        JSON.parse((await stored(summaryOf(await capture(admin(), { boundaryId, ...body })).datasetId)).content) as ReportDataset;
      const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id).sort();

      const inventory = await read({});
      expect(inventory.organisationName).toBe('Int-test trading name');
      expect(inventory.resolvedSubsidiaryIds).toEqual([S, S2].sort());
      expect(ids(inventory.records)).toEqual(ids([...electricity, gas, sibling]));
      expect(inventory.evidence.map((e) => ({ id: e.id, recordIds: e.recordIds, contentFingerprint: e.contentFingerprint })).sort((a, b) => (a.id < b.id ? -1 : 1)))
        .toEqual([
          { id: meterFile.id, recordIds: [electricity[0].id, electricity[1].id].sort(), contentFingerprint: { algorithm: 'sha256', hex: 'b'.repeat(64) } },
          { id: gasFile.id, recordIds: [gas.id], contentFingerprint: null },
        ].sort((a, b) => (a.id < b.id ? -1 : 1)));
      expect(ids(inventory.periodLocks)).toEqual(ids(locks));
      // The excluded gas and the holding's record are captured, disclosed, never counted.
      expect(inventory.coverage.gaps.filter((g) => g.code === 'unmapped_record').flatMap((g) => g.recordIds).sort()).toEqual([gas.id, sibling.id].sort());

      const ofSibling = await read({ subsidiaryId: S2 });
      expect(ofSibling.resolvedSubsidiaryIds).toEqual([S2]);
      expect(ids(ofSibling.records)).toEqual([sibling.id]);
      expect(ofSibling.evidence).toEqual([]);
      expect(ids(ofSibling.periodLocks)).toEqual([locks[1].id]);

      const ofGas = await read({ category: 'Natural Gas' });
      expect(ids(ofGas.records)).toEqual([gas.id]);
      expect(ofGas.evidence.map((e) => e.id)).toEqual([gasFile.id]);
    } finally {
      await other.cleanup();
    }
  });

  it("captures an extract, naming its filters, and a Scope 3 one empty", async () => {
    const boundaryId = await openVersion();
    await yearOfRecords();
    const scope2 = summaryOf(await capture(admin(), { boundaryId, scope: 2 }));
    expect(scope2).toMatchObject({ selection: 'extract', context: { year: YEAR, scope: 2 } });
    const scope3 = JSON.parse((await stored(summaryOf(await capture(admin(), { boundaryId, scope: 3 })).datasetId)).content) as ReportDataset;
    expect(scope3.records).toEqual([]);
    expect(scope3.scopes.map((s) => s.coverage)).toEqual(['partial', 'partial', 'not_covered']);
    const list = (JSON.parse((await call(admin(), 'GET', `/report-datasets?year=${YEAR}`)).text) as ReportDatasetList).items;
    expect(list.map((d) => d.context)).toEqual([{ year: YEAR, scope: 3 }, { year: YEAR, scope: 2 }]);
  });

  it('refuses data_entry every read', async () => {
    const boundaryId = await openVersion();
    const { datasetId } = summaryOf(await capture(admin(), { boundaryId }));
    for (const path of [`/report-datasets/${datasetId}`, `/report-datasets?year=${YEAR}`]) {
      const refused = await call(t.users.dataEntry, 'GET', path);
      expect([refused.status, refused.code]).toEqual([403, 'forbidden']);
    }
  });

  it('refuses data_entry on all three routes before a malformed body, year or id is validated (Codex)', async () => {
    for (const [method, path, body] of [
      ['POST', '/report-datasets', { boundaryId: 'not-an-id', scope: 99 }],
      ['GET', '/report-datasets?year=bad', undefined],
      ['GET', '/report-datasets/not-an-id', undefined],
    ] as const) {
      const refused = await call(t.users.dataEntry, method, path, body);
      expect([refused.status, refused.code], `${method} ${path}`).toEqual([403, 'forbidden']);
    }
  });
});

describe("the header lock serialises a capture against every other writer (Codex's schedules)", () => {
  /** The first operation held inside its header lock; the second's session observed waiting on it. */
  async function race(first: (client: PrismaService) => Promise<unknown>, second: (client: PrismaService) => Promise<unknown>) {
    const a = connect(1);
    const b = connect(1);
    const held = holdBefore(a, 'InventoryBoundary', 'findUniqueOrThrow');
    const firstDone = first(held.client);
    try {
      await held.reached();
      const pid = await backendPid(b);
      const secondDone = second(b).then((value) => ({ value }), (error: unknown) => ({ error }));
      expect(await settledOrBlocked(secondDone, pid, owner)).toBe('blocked');
      held.release();
      return { first: await firstDone, second: await secondDone };
    } finally {
      held.release();
      await firstDone.catch(() => undefined);
      await Promise.all([a.$disconnect(), b.$disconnect()]);
    }
  }
  const datasets = (client: PrismaService) => new ReportDatasetsService(client, new AuditService(client));
  const boundaries = (client: PrismaService) => new InventoryBoundariesService(client, new AuditService(client));
  const freezes = async () => (await audits('inventory_boundary')).filter((row) => row.action === 'freeze').length;

  it.each(['capture', 'confirm', 'delete'] as const)('a capture holding the lock first: a second %s waits, then meets the frozen version', async (second) => {
    const boundaryId = await openVersion();
    const user = await withAccess(admin());
    const result = await race(
      (client) => datasets(client).capture(user, { boundaryId }),
      (client) => (second === 'capture' ? datasets(client).capture(user, { boundaryId })
        : second === 'confirm' ? boundaries(client).confirm(user, boundaryId) : boundaries(client).remove(user, boundaryId)),
    );
    const first = result.first as ReportDatasetSummary;
    expect(first.boundary.decision).toBe('unconfirmed');
    if (second === 'capture') {
      expect('value' in result.second && (result.second.value as ReportDatasetSummary).fingerprint).toEqual(first.fingerprint);
      expect(await datasetCount()).toBe(2);
    } else {
      expect('error' in result.second && errorCodeOf(result.second.error))
        .toBe(second === 'confirm' ? 'boundary_confirm_requires_copy' : 'boundary_frozen');
      expect(await datasetCount()).toBe(1);
    }
    expect(await freezes()).toBe(1);
  });

  it.each(['confirm', 'delete'] as const)('a %s holding the lock first: the capture waits, then captures the confirmed version or finds none', async (first) => {
    const boundaryId = await openVersion();
    const user = await withAccess(admin());
    const result = await race(
      (client) => (first === 'confirm' ? boundaries(client).confirm(user, boundaryId) : boundaries(client).remove(user, boundaryId)),
      (client) => datasets(client).capture(user, { boundaryId }),
    );
    if (first === 'confirm') {
      expect('value' in result.second && (result.second.value as ReportDatasetSummary).boundary.decision).toBe('confirmed');
      expect(await datasetCount()).toBe(1);
    } else {
      expect('error' in result.second && errorCodeOf(result.second.error)).toBe('boundary_not_found');
      expect(await datasetCount()).toBe(0);
    }
    expect(await freezes()).toBe(0);
  });
});

describe('a failed capture', () => {
  /** A service whose evidence-link cap is one link. */
  const oneLink = (client: PrismaService = runtime) => serviceWith({ REPORT_EVIDENCE_LINK_LIMIT: '1' }, client);
  async function serviceWith(env: Record<string, string>, client: PrismaService = runtime) {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      return new ReportDatasetsService(client, new AuditService(client));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('after its freeze leaves the version frozen and audited, with no dataset — a retry completes it ((4a))', async () => {
    const boundaryId = await openVersion();
    await yearOfRecords();
    const tooSmall = await serviceWith({ REPORT_MAX_BYTES: '1000' });
    const user = await withAccess(admin());
    expect(errorCodeOf(await failure(tooSmall.capture(user, { boundaryId })))).toBe('query_too_broad');
    expect((await versionRow(boundaryId)).frozenAt).not.toBeNull();
    expect((await audits('inventory_boundary')).filter((r) => r.action === 'freeze')).toHaveLength(1);
    expect(await datasetCount()).toBe(0);
    expect(await audits('report_dataset')).toEqual([]);

    expect((await capture(admin(), { boundaryId })).status).toBe(201);
    expect((await audits('inventory_boundary')).filter((r) => r.action === 'freeze')).toHaveLength(1);
  });

  it('with evidence links already past the cap is refused before it freezes anything (Codex)', async () => {
    const boundaryId = await openVersion();
    const record = await createRecord(owner, t, { locationId: L1, reportingYear: YEAR });
    await attachEvidence(owner, t, [record.id]);
    await attachEvidence(owner, t, [record.id]);
    expect(errorCodeOf(await failure((await oneLink()).capture(await withAccess(admin()), { boundaryId })))).toBe('query_too_broad');
    expect((await versionRow(boundaryId)).frozenAt).toBeNull();
    expect((await audits('inventory_boundary')).filter((row) => row.action === 'freeze')).toEqual([]);
    expect(await datasetCount()).toBe(0);
  });

  it('whose evidence passes the cap between its count and its snapshot is refused by the snapshot — frozen, audited once, no dataset (Codex)', async () => {
    const boundaryId = await openVersion();
    const record = await createRecord(owner, t, { locationId: L1, reportingYear: YEAR });
    // Held at the freeze's audit row: counted, not yet committed.
    const held = holdBefore(runtime, 'AuditLog', 'create');
    const pending = failure((await oneLink(held.client)).capture(await withAccess(admin()), { boundaryId }));
    try {
      await held.reached();
      await attachEvidence(ownerB, t, [record.id]);
      await attachEvidence(ownerB, t, [record.id]);
      held.release();
      expect(errorCodeOf(await pending)).toBe('query_too_broad');
      expect((await versionRow(boundaryId)).frozenAt).not.toBeNull();
      expect((await audits('inventory_boundary')).filter((row) => row.action === 'freeze')).toHaveLength(1);
      expect(await datasetCount()).toBe(0);
      expect(await audits('report_dataset')).toEqual([]);
    } finally {
      held.release();
      await pending;
    }
  });

  it('certain to be too broad is refused before it freezes anything', async () => {
    const boundaryId = await openVersion();
    await yearOfRecords();
    const narrow = await serviceWith({ REPORT_RECORD_LIMIT: '5' });
    expect(errorCodeOf(await failure(narrow.capture(await withAccess(admin()), { boundaryId })))).toBe('query_too_broad');
    expect((await versionRow(boundaryId)).frozenAt).toBeNull();
    expect(await audits('inventory_boundary').then((rows) => rows.filter((r) => r.action === 'freeze'))).toEqual([]);
  });

  it('whose audit insert fails, or aborts after it, retains nothing', async () => {
    const boundaryId = await openVersion();
    await owner.inventoryBoundary.update({ where: { id: boundaryId }, data: { frozenAt: new Date() } });
    const user = await withAccess(t.users.consultant);
    const failing = new ReportDatasetsService(failingAuditClient(runtime), new AuditService(failingAuditClient(runtime)));
    expect((await failure(failing.capture(user, { boundaryId })) as Error).message).toContain(INJECTED_AUDIT_FAILURE);
    const aborting = new ReportDatasetsService(abortAfterAuditClient(runtime), new AuditService(abortAfterAuditClient(runtime)));
    expect((await failure(aborting.capture(user, { boundaryId })) as Error).message).toContain(ABORTED_AFTER_AUDIT);
    expect(await datasetCount()).toBe(0);
    expect(await audits('report_dataset')).toEqual([]);
  });
});

describe("a capture's one snapshot", () => {
  it('holds while another session renames, withdraws, adds and voids mid-capture; the next capture discloses it all', async () => {
    const year = YEAR + 1;
    const release = await fixtureRelease(year);
    try {
      const boundaryId = await openVersion(year);
      const records = await yearOfRecords(year);
      // Held at the snapshot's first model read — the organisation, read
      // after `CaptureSnapshot.open` took the snapshot — so every read the
      // dataset is made of runs after the other session's commits.
      const hold = holdBefore(runtime, 'Organisation', 'findUnique');
      const service = new ReportDatasetsService(hold.client, new AuditService(hold.client));
      const pending = service.capture(await withAccess(admin()), { boundaryId });
      await hold.reached();
      await ownerB.subsidiary.update({ where: { id: S }, data: { tradingName: 'Renamed mid-capture' } });
      await ownerB.$executeRaw`UPDATE factor_releases
        SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = 'int-test', withdrawal_reason = 'Int-test erratum'
        WHERE id = ${release}::uuid`;
      await ownerB.activityRecord.update({ where: { id: records[0].id }, data: { status: 'voided', voidedBy: admin().id, voidedAt: new Date(), voidReason: 'Int-test void' } });
      const late = await createRecord(ownerB, t, { locationId: L1, reportingYear: year, reportingPeriod: 'annual', periodValue: 'Annual', status: ActivityRecordStatus.approved }, { priced: false });
      const file = await attachEvidence(ownerB, t, [records[1].id]);
      const lock = await ownerB.periodLock.create({ data: { subsidiaryId: S, reportingYear: year, reportingPeriod: 'annual', periodValue: 'Annual', lockedBy: admin().id } });
      await ownerB.organisation.update({ where: { id: t.organisationId }, data: { tradingName: 'Org renamed mid-capture' } });
      hold.release();
      const first = JSON.parse((await stored((await pending).datasetId)).content) as ReportDataset;

      expect(first.records.map((r) => r.id)).not.toContain(late.id);
      expect(first.review.voidedRecordIds).toEqual([]);
      expect(first.records.every((r) => r.subsidiaryName !== 'Renamed mid-capture')).toBe(true);
      expect(first.provenance.releases).toEqual([expect.objectContaining({ id: release, status: 'fixture', withdrawnAt: null })]);
      expect(first.evidence).toEqual([]);
      expect(first.periodLocks).toEqual([]);
      expect(first.organisationName).not.toBe('Org renamed mid-capture');

      const second = JSON.parse((await stored(summaryOf(await capture(admin(), { boundaryId })).datasetId)).content) as ReportDataset;
      expect(second.records.map((r) => r.id)).toContain(late.id);
      expect(second.review.voidedRecordIds).toEqual([records[0].id]);
      expect(second.records.find((r) => r.id === records[1].id)?.subsidiaryName).toBe('Renamed mid-capture');
      expect(second.evidence.map((e) => [e.id, e.recordIds])).toEqual([[file.id, [records[1].id]]]);
      expect(second.periodLocks.map((l) => l.id)).toEqual([lock.id]);
      expect(second.organisationName).toBe('Org renamed mid-capture');
      // The boundary is the version's, its names frozen with it (W7).
      expect(second.boundary).toEqual(first.boundary);
      expect(second.provenance.releases).toEqual([expect.objectContaining({ id: release, status: 'withdrawn', withdrawalReason: 'Int-test erratum' })]);
      expect(second.provenance.records.find((r) => r.recordId === records[1].id)?.issues).toContain('withdrawn_release');
      // The annual row overlaps the monthly meter's months: never counted.
      expect(second.coverage.gaps.filter((g) => g.recordIds.includes(late.id)).map((g) => g.code).sort()).toEqual(['overlapping_periods', 'unmapped_record']);
      // The figures are the records' own, unrecalculated.
      expect(second.records.find((r) => r.id === records[1].id)?.calculation).toEqual(first.records.find((r) => r.id === records[1].id)?.calculation);
    } finally {
      await dropRelease(release);
    }
  });
});

describe('who reads a retained dataset', () => {
  it("across organisations, a version and a dataset of another's answer as unknown ones, byte for byte", async () => {
    const boundaryId = await openVersion();
    const { datasetId } = summaryOf(await capture(admin(), { boundaryId }));
    const other = await createTenant();
    try {
      const theirs = other.users.superAdmin;
      const foreignCapture = await capture(theirs, { boundaryId });
      const unknownCapture = await capture(theirs, { boundaryId: randomUUID() });
      expect([foreignCapture.status, foreignCapture.code]).toEqual([404, 'boundary_not_found']);
      expect(foreignCapture.text).toBe(unknownCapture.text);
      const foreignRead = await call(theirs, 'GET', `/report-datasets/${datasetId}`);
      const unknownRead = await call(theirs, 'GET', `/report-datasets/${randomUUID()}`);
      expect([foreignRead.status, foreignRead.code]).toEqual([404, 'report_dataset_not_found']);
      expect(foreignRead.text).toBe(unknownRead.text);
      expect(JSON.parse((await call(theirs, 'GET', `/report-datasets?year=${YEAR}`)).text)).toEqual({ items: [], truncated: false });
    } finally {
      await other.cleanup();
    }
  });

  it('refuses an extract of a subsidiary the version does not declare, freezing nothing', async () => {
    const boundaryId = await openVersion();
    const refused = await capture(admin(), { boundaryId, subsidiaryId: S2 });
    expect([refused.status, refused.code]).toEqual([404, 'subsidiary_not_found']);
    expect((await versionRow(boundaryId)).frozenAt).toBeNull();
  });

  it("filters unreadable datasets in SQL before the list's limit: 51 newer ones never crowd out an older readable one (Codex)", async () => {
    const user = await withAccess(admin());
    const service = new ReportDatasetsService(runtime, new AuditService(runtime));
    const older = await service.capture(user, { boundaryId: await openVersion() });
    const both = await twoSubsidiaryVersion();
    for (let i = 0; i < 51; i += 1) await service.capture(user, { boundaryId: both });
    const full = await listDatasetSummaries(runtime, t.organisationId, YEAR, [S, S2]);
    expect(full.items).toHaveLength(50);
    // 52 readable: the list says it stopped (LP4-03).
    expect(full.truncated).toBe(true);
    expect(await listDatasetSummaries(runtime, t.organisationId, YEAR, [S])).toEqual({ items: [expect.objectContaining({ datasetId: older.datasetId })], truncated: false });
  });

  it("is read only by a caller holding every subsidiary it references — the rule in SQL", async () => {
    // A version declaring S and S2: an extract of S still references S2 (the whole boundary, W3).
    const service = new InventoryBoundariesService(runtime, new AuditService(runtime));
    const user = await withAccess(admin());
    const { id: boundaryId } = await service.create(user, { reportingYear: YEAR });
    await service.putSubsidiary(user, boundaryId, S, declaration());
    await service.putSubsidiary(user, boundaryId, S2, {
      firstMonth: 1, lastMonth: 12, sites: [],
      attribution: (['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants'] as const).map((category) => ({ category, level: 'company', reportingPeriod: 'annual' })),
      applicability: (['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants'] as const).map((category) => ({ locationId: null, category, applicability: 'excluded', reason: 'Holding company' })),
      sources: [],
    });
    const { datasetId } = summaryOf(await capture(admin(), { boundaryId, subsidiaryId: S }));
    expect((await stored(datasetId)).referencedSubsidiaryIds.sort()).toEqual([S, S2].sort());
    expect(await readDatasetContent(runtime, datasetId, t.organisationId, [S, S2])).toBe((await stored(datasetId)).content);
    expect(await readDatasetContent(runtime, datasetId, t.organisationId, [S])).toBeNull();
    expect(await readDatasetContent(runtime, datasetId, randomUUID(), [S, S2])).toBeNull();
    expect((await listDatasetSummaries(runtime, t.organisationId, YEAR, [S, S2])).items.map((d) => d.datasetId)).toEqual([datasetId]);
    expect(await listDatasetSummaries(runtime, t.organisationId, YEAR, [S])).toEqual({ items: [], truncated: false });
    expect((await listDatasetSummaries(runtime, t.organisationId, YEAR, [S2, S, randomUUID()])).items).toHaveLength(1);
  });
});

describe('the retained table (TA016, V5)', () => {
  async function retained(): Promise<{ id: string; boundaryId: string }> {
    const boundaryId = await openVersion();
    await yearOfRecords();
    return { id: summaryOf(await capture(admin(), { boundaryId })).datasetId, boundaryId };
  }

  it('refuses every change and delete, the owner included, and TRUNCATE', async () => {
    const { id } = await retained();
    for (const statement of [
      (tx: Prisma.TransactionClient) => tx.$executeRaw`UPDATE report_datasets SET content = content WHERE id = ${id}::uuid`,
      (tx: Prisma.TransactionClient) => tx.$executeRaw`UPDATE report_datasets SET captured_by = gen_random_uuid() WHERE id = ${id}::uuid`,
      (tx: Prisma.TransactionClient) => tx.$executeRaw`DELETE FROM report_datasets WHERE id = ${id}::uuid`,
      // CASCADE: since LP3-04 PR D an issuance's key references the table, so
      // a plain TRUNCATE is refused by that key first (0A000, below).
      (tx: Prisma.TransactionClient) => tx.$executeRaw`TRUNCATE report_datasets CASCADE`,
    ]) {
      expect(sqlState(await failure(withRollback(owner, statement)))).toBe('TA016');
    }
    expect(sqlState(await failure(withRollback(owner, (tx) => tx.$executeRaw`TRUNCATE report_datasets`)))).toBe('0A000');
  });

  it('holds the runtime role to SELECT and INSERT, and the client roles to nothing', async () => {
    const { id } = await retained();
    for (const statement of [
      runtime.$executeRaw`UPDATE report_datasets SET content = content WHERE id = ${id}::uuid`,
      runtime.$executeRaw`DELETE FROM report_datasets WHERE id = ${id}::uuid`,
    ]) {
      expect(sqlState(await failure(statement))).toBe('42501');
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      // The role is really taken — else a refused SET ROLE would read as the refusal.
      const became = await withRollback(owner, async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
        return (await tx.$queryRaw<{ who: string }[]>`SELECT current_user AS who`)[0].who;
      });
      expect(became).toBe(role);
      const read = await failure(withRollback(owner, async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
        return tx.$queryRaw`SELECT id FROM report_datasets`;
      }));
      expect(sqlState(read), role).toBe('42501');
    }
  });

  it("refuses an insert whose columns and content disagree, an open version's, or a referenced set not its content's", async () => {
    const { id } = await retained();
    // Open, but declaring S — so only the frozen-version rule can refuse a
    // dataset of it (`qa-auditor` round-2 P2-1: one declaring nothing was
    // refused by the declared-set rule first).
    const openId = await (async () => {
      const service = new InventoryBoundariesService(runtime, new AuditService(runtime));
      const user = await withAccess(admin());
      const { id: open } = await service.create(user, { reportingYear: YEAR + 2 });
      await service.putSubsidiary(user, open, S, declaration());
      return open;
    })();
    const other = await createTenant();
    try {
      type Column = 'boundary_id' | 'reporting_year' | 'selection' | 'context' | 'fingerprint_hex' | 'referenced_subsidiary_ids' | 'captured_at';
      /** A copy of the retained row under a new id — its content's datasetId agreeing — with the columns and content changed as given. */
      const copy = (
        over: Partial<Record<Column, Prisma.Sql>> = {},
        content: (doc: Prisma.Sql) => Prisma.Sql = (doc) => doc,
        renumber = true,
      ) => (tx: Prisma.TransactionClient, fresh: string) => {
        const col = (name: Column) => over[name] ?? Prisma.raw(`"${name}"`);
        const doc = renumber ? Prisma.sql`jsonb_set(content::jsonb, '{datasetId}', to_jsonb(${fresh}::text))` : Prisma.sql`content::jsonb`;
        return tx.$executeRaw`
          INSERT INTO report_datasets SELECT ${fresh}::uuid, organisation_id, ${col('boundary_id')}, ${col('reporting_year')}, ${col('selection')},
            ${col('context')}, schema_version, canonicalization, ${col('fingerprint_hex')}, ${col('referenced_subsidiary_ids')}, captured_by,
            ${col('captured_at')}, (${content(doc)})::text
          FROM report_datasets WHERE id = ${id}::uuid`;
      };
      const set = (path: string, value: Prisma.Sql) => (doc: Prisma.Sql) => Prisma.sql`jsonb_set(${doc}, ${path}::text[], ${value})`;
      const S2Records = set('{records}', Prisma.sql`jsonb_build_array(jsonb_build_object('subsidiaryId', ${S2}::text))`);
      const later = YEAR + 2;
      const refused: Array<[string, ReturnType<typeof copy>]> = [
        ['a datasetId the row does not carry', copy({}, (doc) => doc, false)],
        ['a fingerprint the content does not carry', copy({ fingerprint_hex: Prisma.sql`repeat('0', 64)` })],
        ['a capture time a millisecond off', copy({ captured_at: Prisma.sql`captured_at + interval '1 millisecond'` })],
        ["the content's organisation another's", copy({}, set('{organisationId}', Prisma.sql`to_jsonb(${other.organisationId}::text)`))],
        ["the content's version another", copy({}, set('{boundary,id}', Prisma.sql`to_jsonb(${openId}::text)`))],
        ["the content's version's organisation another's", copy({}, set('{boundary,organisationId}', Prisma.sql`to_jsonb(${other.organisationId}::text)`))],
        ["the content's version's year another", copy({}, set('{boundary,reportingYear}', Prisma.sql`to_jsonb(${later})`))],
        ['the context year another, column and content alike', copy(
          { context: Prisma.sql`jsonb_set(context, '{year}', to_jsonb(${later}))` }, set('{context,year}', Prisma.sql`to_jsonb(${later})`))],
        ["a year the frozen version is not, the row's and the content's alike", copy(
          { reporting_year: Prisma.sql`${later}`, context: Prisma.sql`jsonb_set(context, '{year}', to_jsonb(${later}))` },
          (doc) => set('{boundary,reportingYear}', Prisma.sql`to_jsonb(${later})`)(set('{context,year}', Prisma.sql`to_jsonb(${later})`)(doc)))],
        ['a selection column the content does not carry', copy({ selection: Prisma.sql`'extract'` })],
        ['a context column the content does not carry', copy({ context: Prisma.sql`jsonb_build_object('year', ${YEAR}, 'scope', 2)` })],
        ["the content's schema version another", copy({}, set('{schemaVersion}', Prisma.sql`'2'::jsonb`))],
        ["the content's algorithm another", copy({}, set('{fingerprint,algorithm}', Prisma.sql`'"md5"'::jsonb`))],
        ["the content's canonicalization another", copy({}, set('{fingerprint,canonicalization}', Prisma.sql`'"v0"'::jsonb`))],
        ['a referenced column naming one the content does not', copy({ referenced_subsidiary_ids: Prisma.sql`referenced_subsidiary_ids || ${S2}::uuid` })],
        ['a referenced column omitting one the content names — at any depth', copy({}, S2Records)],
        ['a referenced column naming one twice', copy({ referenced_subsidiary_ids: Prisma.sql`referenced_subsidiary_ids || ${S}::uuid` })],
        ["another organisation's subsidiary named in it", copy(
          { referenced_subsidiary_ids: Prisma.sql`referenced_subsidiary_ids || ${other.subsidiaryId}::uuid` },
          set('{periodLocks}', Prisma.sql`(content::jsonb -> 'periodLocks') || jsonb_build_array(jsonb_build_object('subsidiaryId', ${other.subsidiaryId}::text))`))],
        ["resolved subsidiaries that are not its selection's", copy({}, set('{resolvedSubsidiaryIds}', Prisma.sql`'[]'::jsonb`))],
        ['an extract of a subsidiary the version does not declare', copy(
          {
            selection: Prisma.sql`'extract'`,
            context: Prisma.sql`jsonb_build_object('year', ${YEAR}, 'subsidiaryId', ${S2}::text)`,
            referenced_subsidiary_ids: Prisma.sql`ARRAY[${S}::uuid, ${S2}::uuid]`,
          },
          (doc) => set('{resolvedSubsidiaryIds}', Prisma.sql`jsonb_build_array(${S2}::text)`)(
            set('{context}', Prisma.sql`jsonb_build_object('year', ${YEAR}, 'subsidiaryId', ${S2}::text)`)(
              set('{selection}', Prisma.sql`'"extract"'::jsonb`)(doc))))],
        ['an open version', copy(
          { boundary_id: Prisma.sql`${openId}::uuid`, reporting_year: Prisma.sql`${later}`, context: Prisma.sql`jsonb_set(context, '{year}', to_jsonb(${later}))` },
          (doc) => set('{context,year}', Prisma.sql`to_jsonb(${later})`)(set('{boundary,reportingYear}', Prisma.sql`to_jsonb(${later})`)(
            set('{boundary,id}', Prisma.sql`to_jsonb(${openId}::text)`)(doc))))],
      ];
      for (const [what, insert] of refused) {
        const e = await failure(withRollback(owner, (tx) => insert(tx, randomUUID())));
        expect(sqlState(e), what).toBe('TA016');
      }
      // An extract with no filter: the CHECK, every writer.
      const mislabelled = await failure(withRollback(owner, (tx) =>
        copy({ selection: Prisma.sql`'extract'` }, set('{selection}', Prisma.sql`'"extract"'::jsonb`))(tx, randomUUID())));
      expect(sqlState(mislabelled)).toBe('23514');
      // The controls, admitted (and rolled back): the copy made whole, and one
      // naming a subsidiary only deep in its content that its column names too.
      await withRollback(owner, (tx) => copy()(tx, randomUUID()));
      await withRollback(owner, (tx) => copy({ referenced_subsidiary_ids: Prisma.sql`referenced_subsidiary_ids || ${S2}::uuid` }, S2Records)(tx, randomUUID()));
    } finally {
      await other.cleanup();
    }
  });

  it("runs no caller's temporary type inside a SECURITY DEFINER guard (security-rls P1)", async () => {
    // A fresh runtime session: PL/pgSQL compiles a function once per session,
    // resolving its variables' types then — a domain made after that is never
    // looked up. Each write below fires a definer whose variables are typed
    // jsonb or timestamptz; with pg_temp searched first, the caller's domain
    // would run its check as the definer's owner.
    const session = connect(1);
    try {
      const probes: Array<[string, (tx: Prisma.TransactionClient) => Promise<unknown>]> = [
        ['jsonb', (tx) => tx.$executeRaw`
          INSERT INTO report_datasets (id, organisation_id, boundary_id, reporting_year, selection, context, schema_version,
            canonicalization, fingerprint_hex, referenced_subsidiary_ids, captured_by, captured_at, content)
          VALUES (gen_random_uuid(), ${t.organisationId}::uuid, gen_random_uuid(), ${YEAR}, 'inventory', pg_catalog.jsonb_build_object('year', ${YEAR}), 1,
            'tonyai-report-dataset-v1', repeat('a', 64), ARRAY[${S}::uuid], gen_random_uuid(), now(), '{}')`],
        ['timestamptz', (tx) => tx.$executeRaw`
          INSERT INTO inventory_boundaries (id, organisation_id, reporting_year, version, decision, created_by)
          VALUES (gen_random_uuid(), ${t.organisationId}::uuid, ${YEAR + 9}, 1, 'unconfirmed', gen_random_uuid())`],
      ];
      for (const [type, write] of probes) {
        const e = await failure(session.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `CREATE FUNCTION pg_temp.escalated(t text) RETURNS boolean LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'escalated as %', current_user; END $f$`,
          );
          await tx.$executeRawUnsafe(`CREATE DOMAIN pg_temp.${type} AS pg_catalog.${type} CHECK (pg_temp.escalated(VALUE::pg_catalog.text))`);
          await write(tx);
          throw new Error('probe done, rolled back');
        }));
        expect((e as Error).message, type).not.toMatch(/escalated as/);
      }
    } finally {
      await session.$disconnect();
    }
  });

  it("runs no caller's temporary type in a function a definer calls — the loader's own login and its release event's actor helper (Codex P1)", async () => {
    // A fresh session as the factor loader itself (LP4-02): inserting a
    // release fires the event recorder, a definer, which calls an invoker SQL
    // helper — run then as the owner. The check fires only where the two
    // users differ, so the loader's own invoker triggers do not count.
    const loader = connectLoader(1);
    try {
      const e = await failure(loader.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE FUNCTION pg_temp.escalated(t pg_catalog.text) RETURNS boolean LANGUAGE plpgsql AS $f$
          BEGIN IF current_user <> session_user THEN RAISE EXCEPTION 'escalated as % (session %)', current_user, session_user; END IF; RETURN true; END $f$`);
        await tx.$executeRawUnsafe(`CREATE DOMAIN pg_temp.text AS pg_catalog.text CHECK (pg_temp.escalated(VALUE))`);
        await tx.$executeRaw`
          INSERT INTO factor_releases (id, publisher, title, edition, ordinal, status)
          VALUES (gen_random_uuid(), 'TonyAI test fixture', 'Int-test escalation probe', ${`int-${randomUUID()}`}, 999990, 'fixture')`;
        throw new Error('probe done, rolled back');
      }));
      expect((e as Error).message).not.toMatch(/escalated as/);
      expect((e as Error).message).toBe('probe done, rolled back');
    } finally {
      await loader.$disconnect();
    }
  });

  it("binds a dataset's declared and resolved subsidiaries, and its version, to the frozen version itself — owner and runtime alike (Codex P2)", async () => {
    const boundaryId = await twoSubsidiaryVersion();
    const inventory = summaryOf(await capture(admin(), { boundaryId })).datasetId;
    const extract = summaryOf(await capture(admin(), { boundaryId, subsidiaryId: S })).datasetId;
    const S3 = (await owner.subsidiary.create({
      data: { organisationId: t.organisationId, legalName: `Int-test undeclared ${randomUUID().slice(0, 8)}`, geographyCode: 'UK' },
    })).id;
    /** A copy of `id` under a new id, its content's declared and resolved sets and its referenced column replaced — or its version's facts forged. */
    const forged = (id: string, change: { declared?: string[]; resolved?: string[]; referenced?: string[]; decision?: string; version?: number; contextSubsidiary?: string }) =>
      (tx: Prisma.TransactionClient) => {
        const fresh = randomUUID();
        const spelled = change.contextSubsidiary ?? null;
        return tx.$executeRaw`
          INSERT INTO report_datasets SELECT ${fresh}::uuid, organisation_id, boundary_id, reporting_year, selection,
            CASE WHEN ${spelled}::text IS NULL THEN context ELSE jsonb_set(context, '{subsidiaryId}', to_jsonb(${spelled}::text)) END, schema_version,
            canonicalization, fingerprint_hex, COALESCE(${change.referenced ?? null}::uuid[], referenced_subsidiary_ids), captured_by, captured_at,
            jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(content::jsonb, '{datasetId}', to_jsonb(${fresh}::text)),
              '{boundary,subsidiaryIds}', COALESCE(to_jsonb(${change.declared ?? null}::text[]), content::jsonb -> 'boundary' -> 'subsidiaryIds')),
              '{resolvedSubsidiaryIds}', COALESCE(to_jsonb(${change.resolved ?? null}::text[]), content::jsonb -> 'resolvedSubsidiaryIds')),
              '{boundary,decision}', COALESCE(to_jsonb(${change.decision ?? null}::text), content::jsonb -> 'boundary' -> 'decision')),
              '{boundary,version}', COALESCE(to_jsonb(${change.version ?? null}::int), content::jsonb -> 'boundary' -> 'version')),
              '{context}', CASE WHEN ${spelled}::text IS NULL THEN content::jsonb -> 'context'
                ELSE jsonb_set(content::jsonb -> 'context', '{subsidiaryId}', to_jsonb(${spelled}::text)) END)::text
          FROM report_datasets WHERE id = ${id}::uuid`;
      };
    const all = [S, S2, S3];
    const refused: Array<[string, ReturnType<typeof forged>]> = [
      ['another subsidiary declared in its place, resolved and referenced', forged(inventory, { declared: [S3], resolved: [S3], referenced: all })],
      ['one declared subsidiary omitted', forged(inventory, { declared: [S], resolved: [S] })],
      ['a declared subsidiary twice', forged(inventory, { declared: [S, S, S2], resolved: [S, S, S2] })],
      ['a subsidiary twice in the declared list alone', forged(inventory, { declared: [S, S, S2] })],
      ['a subsidiary twice in the resolved list alone', forged(inventory, { resolved: [S, S, S2] })],
      ['an empty declaration', forged(inventory, { declared: [], resolved: [] })],
      ["an extract's declaration narrowed to its own subsidiary", forged(extract, { declared: [S] })],
      ["an extract resolving a subsidiary the version does not declare", forged(extract, { resolved: [S3], referenced: all })],
      ['an inventory resolving one subsidiary of two', forged(inventory, { resolved: [S] })],
      ["the version's decision forged", forged(inventory, { decision: 'confirmed' })],
      ["the version's number forged", forged(inventory, { version: 99 })],
      // The same values, spelled otherwise (`architect`'s round-2 P3).
      ['a declared subsidiary in braces', forged(inventory, { declared: [`{${S}}`, S2], resolved: [`{${S}}`, S2] })],
      ['a declared subsidiary in capitals', forged(inventory, { declared: [S.toUpperCase(), S2], resolved: [S.toUpperCase(), S2] })],
      ["an extract's subsidiary unhyphenated, in its context and resolved alike",
        forged(extract, { contextSubsidiary: S.replace(/-/g, ''), resolved: [S.replace(/-/g, '')] })],
    ];
    /** A whole copy of `id` whose content text is reshaped — read as jsonb, it is the copy itself. */
    const reshaped = (id: string, shape: (text: Prisma.Sql) => Prisma.Sql) => (tx: Prisma.TransactionClient) => {
      const fresh = randomUUID();
      const text = Prisma.sql`jsonb_set(content::jsonb, '{datasetId}', to_jsonb(${fresh}::text))::text`;
      return tx.$executeRaw`
        INSERT INTO report_datasets SELECT ${fresh}::uuid, organisation_id, boundary_id, reporting_year, selection, context, schema_version,
          canonicalization, fingerprint_hex, referenced_subsidiary_ids, captured_by, captured_at, ${shape(text)}
        FROM report_datasets WHERE id = ${id}::uuid`;
    };
    /** A copy whose content gains `member` in one collection — its referenced column untouched. */
    const plus = (collection: string, member: Prisma.Sql) => (tx: Prisma.TransactionClient) => {
      const fresh = randomUUID();
      return tx.$executeRaw`
        INSERT INTO report_datasets SELECT ${fresh}::uuid, organisation_id, boundary_id, reporting_year, selection, context, schema_version,
          canonicalization, fingerprint_hex, referenced_subsidiary_ids, captured_by, captured_at,
          jsonb_set(jsonb_set(content::jsonb, '{datasetId}', to_jsonb(${fresh}::text)), ${`{${collection}}`}::text[],
            (content::jsonb -> ${collection}) || jsonb_build_array(${member}))::text
        FROM report_datasets WHERE id = ${inventory}::uuid`;
    };
    // `security-rls` round 2: jsonb keeps the last of two keys, but the text is served as stored.
    refused.push(
      ['a top-level key named twice — the first a forgery the jsonb never sees',
        reshaped(inventory, (text) => Prisma.sql`'{"organisationName": "Forged", ' || substr(${text}, 2)`)],
      ['a nested key named twice — another subsidiary declared first',
        reshaped(inventory, (text) => Prisma.sql`replace(${text}, '"boundary": {', ${`"boundary": {"subsidiaryIds": ["${S3}"], `})`)],
      ['a subsidiaryId that is a list', plus('periodLocks', Prisma.sql`jsonb_build_object('subsidiaryId', jsonb_build_array(${S3}::text))`)],
      ['a subsidiaryId that is an object', plus('periodLocks', Prisma.sql`jsonb_build_object('subsidiaryId', jsonb_build_object('id', ${S3}::text))`)],
      ['a subsidiaryId that is null', plus('periodLocks', Prisma.sql`jsonb_build_object('subsidiaryId', null)`)],
      // `qa-auditor` round 3: each rule broken in one place alone, so no sibling branch refuses it instead.
      ['a key named twice inside an array element', (tx) => {
        const fresh = randomUUID();
        return tx.$executeRaw`
          INSERT INTO report_datasets SELECT ${fresh}::uuid, organisation_id, boundary_id, reporting_year, selection, context, schema_version,
            canonicalization, fingerprint_hex, referenced_subsidiary_ids, captured_by, captured_at,
            replace(jsonb_set(jsonb_set(content::jsonb, '{datasetId}', to_jsonb(${fresh}::text)), '{periodLocks}',
              (content::jsonb -> 'periodLocks') || jsonb_build_array(jsonb_build_object('zzdupe', 1, 'subsidiaryId', ${S}::text)))::text,
              '"zzdupe": 1', ${`"subsidiaryId": "${S3}"`})
          FROM report_datasets WHERE id = ${inventory}::uuid`;
      }],
      ['a declared subsidiary in braces, the resolved list as stored', forged(inventory, { declared: [`{${S}}`, S2] })],
      ['a resolved subsidiary in capitals, the declared list as stored', forged(inventory, { resolved: [S.toUpperCase(), S2] })],
      ['a subsidiaryId in capitals deep in the content alone', plus('periodLocks', Prisma.sql`jsonb_build_object('subsidiaryId', upper(${S}::text))`)],
    );
    for (const client of [owner, runtime]) {
      // Every probe's outcome, so a failure names each one admitted.
      const outcomes: Record<string, string> = {};
      for (const [what, insert] of refused) {
        outcomes[what] = await withRollback(client, insert).then(() => 'admitted', (e: unknown) => sqlState(e) ?? String(e));
      }
      expect(outcomes, client === owner ? 'owner' : 'runtime').toEqual(Object.fromEntries(refused.map(([what]) => [what, 'TA016'])));
      // The controls, admitted (and rolled back): each copied whole.
      await withRollback(client, forged(inventory, {}));
      await withRollback(client, forged(extract, {}));
    }
  });

  it("goes with its organisation, and only so (W10)", async () => {
    await retained();
    // `cleanup()`'s order, rolled back: the trail, the profiles, the records, then the organisation.
    const left = await withRollback(owner, async (tx) => {
      await tx.auditLog.deleteMany({ where: { OR: [{ organisationId: t.organisationId }, { userId: { in: t.profileIds } }] } });
      await tx.profile.deleteMany({ where: { id: { in: t.profileIds } } });
      await tx.activityRecord.deleteMany({ where: { subsidiary: { organisationId: t.organisationId } } });
      await tx.organisation.delete({ where: { id: t.organisationId } });
      return tx.reportDataset.count({ where: { organisationId: t.organisationId } });
    });
    expect(left).toBe(0);
    expect(await datasetCount()).toBe(1);
  });
});
