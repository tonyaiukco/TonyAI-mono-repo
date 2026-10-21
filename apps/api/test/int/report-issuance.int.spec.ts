/**
 * LP3-04 PR D on the real database and the local Storage (README "The
 * issuance"; Decisions 2026-10-21): the issuance routes through the deployed
 * app as the runtime role, the retained table's guard (TA017) as every
 * writer meets it, and the retained PDF's recovery (LP1-02) failed at each
 * boundary — asserted on the rows and the objects themselves.
 *
 * A final needs every included obligation met by approved, locked records
 * priced on an authoritative release; until LP4-02 opens the publisher
 * registry no release can be authoritative, so the final this spec issues is
 * a confirmed boundary whose every category is excluded with a reason — no
 * obligation, nothing to count (README's acceptance table) — and a metered
 * year on the fixture release is the partial beside it.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { ActivityRecordStatus, Prisma } from '@tonyai/db';
import {
  directCalorificBasisFor, scope2MethodFor,
  type PutInventoryBoundarySubsidiaryRequest, type ReportIssuance,
} from '@tonyai/shared-types';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import type { RequestUser } from '../../src/auth/auth.types';
import { InventoryBoundariesService } from '../../src/inventory-boundary/inventory-boundaries.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ReportIssuancesService } from '../../src/report-issuances/report-issuances.service';
import { PdfRenderer } from '../../src/common/pdf-renderer';
import { REPORT_ARTIFACTS_BUCKET } from '../../src/storage/buckets';
import { StorageIntentsService, UPLOAD_GRACE_SECONDS, UploadExpiredError } from '../../src/storage/storage-intents.service';
import { StorageReconcileService } from '../../src/storage/storage-reconcile.service';
import type { StorageService } from '../../src/storage/storage.service';
import { apiTokenIssuer, connect, connectOwner, createRecord, createTenant, holdBefore, withRollback, type Tenant } from './db';
import { failingAuditClient } from './services';
import { localStorage, objectExists, removeTenantObjects, sha256, tenantObjects } from './storage';

const JWT_SECRET = randomBytes(32).toString('hex');
/** No other spec prices, captures or issues this year. */
const YEAR = 2078;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const INJECTED = 'injected storage failure (LP3-04 PR D test)';

let app: INestApplication;
let base: string;
let owner: PrismaService;
let runtime: PrismaService;
let storage: StorageService;
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
  const quietLogger = Object.assign(new JsonLogger(), { event: () => undefined });
  configureApp(app, quietLogger, { requestLogging: false, runtimeLimits: app.get(RuntimeLimits) });
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/api/v1`.replace('[::1]', '127.0.0.1');
  const [{ user }] = await app.get(PrismaService).$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`;
  if (user !== 'tonyai_runtime') throw new Error(`the application under test connects as ${user}, not tonyai_runtime`);
  owner = connectOwner(2);
  runtime = connect(5);
  releaseId = await fixtureRelease(YEAR);
}, 60_000);

afterAll(async () => {
  if (releaseId) await dropRelease(releaseId);
  await Promise.all([owner?.$disconnect(), runtime?.$disconnect()]);
  await app?.close();
});

beforeEach(async () => {
  storage = localStorage();
  t = await createTenant();
  S = t.subsidiaryId;
  L1 = (await owner.location.create({ data: { subsidiaryId: S, name: 'Int-test L1', geographyCode: 'UK' } })).id;
  S2 = (await owner.subsidiary.create({
    data: { organisationId: t.organisationId, legalName: `Int-test holding ${randomUUID().slice(0, 8)}`, geographyCode: 'UK' },
  })).id;
});

// The organisation's deletion takes its versions, datasets and issuances
// (W10); their objects are removed here, as a test's own.
afterEach(async () => {
  vi.restoreAllMocks();
  await removeTenantObjects(runtime, localStorage(), t);
  await t?.cleanup();
});

// --------------------------------------------------------------------------
// Fixtures

/** A sealed fixture release with one UK electricity factor for `year`. */
async function fixtureRelease(year: number): Promise<string> {
  return owner.$transaction(async (tx) => {
    const [{ next }] = await tx.$queryRaw<{ next: number }[]>`
      SELECT COALESCE(max(ordinal), 0) + 1 AS next FROM factor_releases WHERE publisher = 'TonyAI test fixture'`;
    const created = await tx.factorRelease.create({
      data: { publisher: 'TonyAI test fixture', title: 'Int test issuance', edition: `int-${randomUUID()}`, ordinal: Number(next), status: 'fixture' },
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

const CATEGORIES = ['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants'] as const;

/** S's electricity metered monthly at L1; everything else excluded at the company. No gap. */
function meteredDeclaration(): PutInventoryBoundarySubsidiaryRequest {
  return {
    firstMonth: 1, lastMonth: 12,
    sites: [{ locationId: L1, firstMonth: 1, lastMonth: 12 }],
    attribution: CATEGORIES.map((category) => (category === 'Electricity'
      ? { category, level: 'sites' as const, reportingPeriod: 'monthly' as const }
      : { category, level: 'company' as const, reportingPeriod: 'annual' as const })),
    applicability: [
      { locationId: L1, category: 'Electricity', applicability: 'included' },
      ...CATEGORIES.filter((c) => c !== 'Electricity').map((category) => ({ locationId: null, category, applicability: 'excluded' as const, reason: 'Not on site' })),
    ],
    sources: [
      { locationId: L1, name: 'L1 main meter', mapping: { kind: 'mapped', category: 'Electricity', activityType: null }, applicability: 'included', evidenceReportingPeriod: null },
    ],
  };
}

/** A holding's whole declaration: every category excluded at the company, with its reason. No gap. */
function holdingDeclaration(): PutInventoryBoundarySubsidiaryRequest {
  return {
    firstMonth: 1, lastMonth: 12, sites: [],
    attribution: CATEGORIES.map((category) => ({ category, level: 'company', reportingPeriod: 'annual' })),
    applicability: CATEGORIES.map((category) => ({ locationId: null, category, applicability: 'excluded', reason: 'Holding company' })),
    sources: [],
  };
}

const admin = () => t.users.superAdmin;
/** A user as the guard would build it: every subsidiary of the organisation, now. */
async function withAccess(user: RequestUser): Promise<RequestUser> {
  const subs = await owner.subsidiary.findMany({ where: { organisationId: user.organisationId! }, select: { id: true } });
  return { ...user, accessibleSubsidiaryIds: subs.map((s) => s.id) };
}

/** A version of YEAR declaring `declarations`, confirmed unless asked not to. */
async function version(declarations: Array<[string, PutInventoryBoundarySubsidiaryRequest]>, confirm = true): Promise<string> {
  const service = new InventoryBoundariesService(runtime, new AuditService(runtime));
  const user = await withAccess(admin());
  const { id } = await service.create(user, { reportingYear: YEAR });
  for (const [subsidiaryId, declaration] of declarations) await service.putSubsidiary(user, id, subsidiaryId, declaration);
  if (confirm) await service.confirm(user, id);
  return id;
}

/** A dataset captured over HTTP. */
async function captured(boundaryId: string, filters: Record<string, unknown> = {}): Promise<string> {
  const answer = await call(admin(), 'POST', '/report-datasets', { boundaryId, ...filters });
  expect(answer.status, answer.text).toBe(201);
  return (JSON.parse(answer.text) as { datasetId: string }).datasetId;
}

/** The final this database can hold: a confirmed holding, every category excluded with its reason. */
const finalDataset = async () => captured(await version([[S2, holdingDeclaration()]]));

/** A confirmed, approved, locked year on the fixture release: partial, non_authoritative_calculation only. */
async function partialDataset(): Promise<{ datasetId: string; recordIds: string[] }> {
  const boundaryId = await version([[S, meteredDeclaration()]]);
  const records: string[] = [];
  for (const periodValue of MONTHS) {
    records.push((await createRecord(owner, t, {
      locationId: L1, reportingYear: YEAR, periodValue, status: ActivityRecordStatus.approved, reviewedBy: admin().id, reviewedAt: new Date(),
    }, { priced: true })).id);
    await owner.periodLock.create({ data: { subsidiaryId: S, reportingYear: YEAR, reportingPeriod: 'monthly', periodValue, lockedBy: admin().id } });
  }
  return { datasetId: await captured(boundaryId), recordIds: records.sort() };
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

interface Answer { status: number; text: string; code: string | undefined }

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

async function download(user: RequestUser, id: string): Promise<{ status: number; bytes: Buffer; headers: Headers }> {
  const res = await fetch(`${base}/report-issuances/${id}/pdf`, { headers: { authorization: `Bearer ${await tokenFor(user.id)}` } });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

const issue = (user: RequestUser, body: Record<string, unknown>) => call(user, 'POST', '/report-issuances', body);
const issuanceOf = (a: Answer) => JSON.parse(a.text) as ReportIssuance;

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

/** The PostgreSQL code a statement failed with. */
function sqlState(e: unknown): string | undefined {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2010') return (e.meta as { code?: string }).code;
  const match = /code: "([0-9A-Z]{5})"/.exec(String((e as Error)?.message ?? ''));
  return match?.[1];
}

function quiet(): void {
  for (const level of ['error', 'warn', 'log'] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
}

// --------------------------------------------------------------------------
// Database and Storage reads

const issuanceRows = () => owner.reportIssuance.findMany({ where: { organisationId: t.organisationId } });
const artifacts = async () => (await tenantObjects(runtime, t)).filter((o) => o.bucket === REPORT_ARTIFACTS_BUCKET);
const artifactIntents = () => owner.storageIntent.findMany({ where: { bucket: REPORT_ARTIFACTS_BUCKET, objectPath: { startsWith: `${t.organisationId}/` } } });
const issueAudits = () => owner.auditLog.findMany({ where: { organisationId: t.organisationId, entity: 'report_issuance' } });

function issuer(client: PrismaService = runtime, store: StorageService = storage, intents = new StorageIntentsService(client, store)) {
  return new ReportIssuancesService(client, new AuditService(client), app.get(PdfRenderer), store, intents);
}

// --------------------------------------------------------------------------

describe('an issuance over HTTP', () => {
  it('issues a final: the exact PDF retained and hashed as stored, its row and audit row, and the bytes served back verified', async () => {
    const datasetId = await finalDataset();
    const answer = await issue(admin(), { datasetId, template: 'executive_summary', includeMethodologyNotes: true });
    expect(answer.status, answer.text).toBe(201);
    const issued = issuanceOf(answer);
    expect(issued).toMatchObject({
      organisationId: t.organisationId, datasetId, status: 'final', gaps: [], issuedBy: admin().id, language: 'en',
      template: 'executive_summary', options: { includeMethodologyNotes: true, includeEvidenceSummary: false },
      pdf: { mimeType: 'application/pdf' },
    });
    expect(issued.rendererVersion).toMatch(/^tonyai-issuance-pdf-v1 \(.+\)$/);

    const dataset = await owner.reportDataset.findUniqueOrThrow({ where: { id: datasetId } });
    expect(issued.datasetFingerprint).toEqual({ algorithm: 'sha256', canonicalization: dataset.canonicalization, hex: dataset.fingerprintHex });

    const [row] = await issuanceRows();
    expect(row).toMatchObject({
      id: issued.issuanceId, datasetId, status: 'final', reportingYear: YEAR, artifactId: issued.pdf.artifactId,
      storagePath: `${t.organisationId}/${issued.pdf.artifactId}.pdf`, sha256: issued.pdf.fingerprint.hex, sizeBytes: issued.pdf.sizeBytes,
      referencedSubsidiaryIds: dataset.referencedSubsidiaryIds,
    });
    expect(row.issuedAt.toISOString()).toBe(issued.issuedAt);
    const stored = await storage.download(REPORT_ARTIFACTS_BUCKET, row.storagePath);
    expect(sha256(stored)).toBe(row.sha256);
    expect(stored.length).toBe(row.sizeBytes);
    expect(stored.subarray(0, 5).toString()).toBe('%PDF-');
    // Adopted: no intent names the object.
    expect(await artifactIntents()).toEqual([]);

    const audits = await issueAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'issue', entityId: issued.issuanceId, userId: admin().id,
      diff: { datasetId, status: 'final', gaps: {}, language: 'en', pdf: { sha256: row.sha256, sizeBytes: row.sizeBytes } },
    });

    // Read back by every reader, as issued.
    expect(JSON.parse((await call(t.users.executiveViewer, 'GET', `/report-issuances/${issued.issuanceId}`)).text)).toEqual(issued);
    expect(JSON.parse((await call(t.users.consultant, 'GET', `/report-issuances?year=${YEAR}`)).text)).toEqual([issued]);
    const served = await download(t.users.executiveViewer, issued.issuanceId);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('application/pdf');
    expect(served.headers.get('content-disposition')).toBe(`attachment; filename="tonyai-report-${YEAR}-executive_summary-en-final.pdf"`);
    expect(served.bytes.equals(stored)).toBe(true);

    // data_entry reads and issues nothing (W3, W4).
    for (const [method, path, body] of [
      ['POST', '/report-issuances', { datasetId, template: 'ghg_protocol_detail' }],
      ['GET', `/report-issuances?year=${YEAR}`, undefined],
      ['GET', `/report-issuances/${issued.issuanceId}`, undefined],
      ['GET', `/report-issuances/${issued.issuanceId}/pdf`, undefined],
    ] as const) {
      expect((await call(t.users.dataEntry, method, path, body)).status).toBe(403);
    }
  }, 60_000);

  it('refuses a consultant a final — nothing rendered, stored or written', async () => {
    const datasetId = await finalDataset();
    const answer = await issue(t.users.consultant, { datasetId, template: 'executive_summary' });
    expect(answer.status).toBe(403);
    expect(answer.code).toBe('report_final_forbidden');
    expect(await issuanceRows()).toEqual([]);
    expect(await artifacts()).toEqual([]);
    expect(await artifactIntents()).toEqual([]);
    expect(await issueAudits()).toEqual([]);
  }, 60_000);

  it('lets a consultant issue a partial; a repeat is report_already_issued; another language is another issuance of the dataset', async () => {
    const { datasetId, recordIds } = await partialDataset();
    const first = await issue(t.users.consultant, { datasetId, template: 'ghg_protocol_detail' });
    expect(first.status, first.text).toBe(201);
    const issued = issuanceOf(first);
    // Approved, locked and covered — the fixture release alone keeps it partial.
    expect(issued.status).toBe('partial');
    expect(issued.gaps).toEqual([{ code: 'non_authoritative_calculation', sourceIds: [], obligationIds: [], recordIds }]);

    const repeat = await issue(t.users.consultant, { datasetId, template: 'ghg_protocol_detail' });
    expect(repeat.status).toBe(409);
    expect(repeat.code).toBe('report_already_issued');
    expect(await issuanceRows()).toHaveLength(1);
    expect(await artifacts()).toHaveLength(1);

    const turkish = await issue(t.users.consultant, { datasetId, template: 'ghg_protocol_detail', language: 'tr' });
    expect(turkish.status, turkish.text).toBe(201);
    expect(issuanceOf(turkish)).toMatchObject({ language: 'tr', datasetFingerprint: issued.datasetFingerprint });
    expect(issuanceOf(turkish).issuanceId).not.toBe(issued.issuanceId);
    expect(await artifacts()).toHaveLength(2);
  }, 90_000);

  it("answers another organisation's dataset and issuance exactly as ones that do not exist", async () => {
    const datasetId = await finalDataset();
    const issued = issuanceOf(await issue(admin(), { datasetId, template: 'executive_summary' }));
    const other = await createTenant();
    try {
      const foreign = await issue(other.users.superAdmin, { datasetId, template: 'executive_summary' });
      const missing = await issue(other.users.superAdmin, { datasetId: randomUUID(), template: 'executive_summary' });
      expect(foreign.status).toBe(404);
      expect(foreign.code).toBe('report_dataset_not_found');
      expect(foreign.text).toBe(missing.text);
      for (const suffix of ['', '/pdf']) {
        const theirs = await call(other.users.superAdmin, 'GET', `/report-issuances/${issued.issuanceId}${suffix}`);
        const none = await call(other.users.superAdmin, 'GET', `/report-issuances/${randomUUID()}${suffix}`);
        expect(theirs.status).toBe(404);
        expect(theirs.code).toBe('report_issuance_not_found');
        expect(theirs.text).toBe(none.text);
      }
      expect(JSON.parse((await call(other.users.superAdmin, 'GET', `/report-issuances?year=${YEAR}`)).text)).toEqual([]);
    } finally {
      await other.cleanup();
    }
  }, 60_000);
});

describe('the guard (TA017) — every writer, the owner included', () => {
  /** An INSERT of the given row with `changes`, as raw SQL (no API, no Prisma model). */
  function insertOf(row: Awaited<ReturnType<typeof issuanceRows>>[number], changes: Record<string, string> = {}): string {
    const id = randomUUID();
    const artifact = randomUUID();
    const columns: Record<string, string> = {
      id: `'${id}'`, organisation_id: `'${row.organisationId}'`, dataset_id: `'${row.datasetId}'`, reporting_year: String(row.reportingYear),
      canonicalization: `'${row.canonicalization}'`, dataset_fingerprint_hex: `'${row.datasetFingerprintHex}'`, status: `'${row.status}'`,
      gaps: `'${JSON.stringify(row.gaps)}'::jsonb`, language: `'tr'`, template: `'${row.template}'`,
      include_methodology_notes: 'false', include_evidence_summary: 'false', renderer_version: `'int'`,
      artifact_id: `'${artifact}'`, storage_path: `'${row.organisationId}/${artifact}.pdf'`, size_bytes: '1', sha256: `'${'c'.repeat(64)}'`,
      referenced_subsidiary_ids: `ARRAY[${row.referencedSubsidiaryIds.map((s) => `'${s}'`).join(',')}]::uuid[]`, issued_by: `'${admin().id}'`,
      ...changes,
    };
    return `INSERT INTO report_issuances (${Object.keys(columns).join(', ')}) VALUES (${Object.values(columns).join(', ')})`;
  }
  const refusedWith = async (sql: string) => sqlState(await failure(withRollback(owner, (tx) => tx.$executeRawUnsafe(sql))));

  it('admits the row the API would write, stamping issued_at from the database clock whatever the insert says', async () => {
    await issue(admin(), { datasetId: await finalDataset(), template: 'executive_summary' });
    const [row] = await issuanceRows();
    const stamped = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe(insertOf(row, { issued_at: `'2000-01-01T00:00:00Z'` }));
      const [{ old }] = await tx.$queryRawUnsafe<{ old: number }[]>(
        `SELECT count(*)::int AS old FROM report_issuances WHERE organisation_id = '${row.organisationId}' AND issued_at < '2001-01-01'`);
      return old;
    });
    expect(stamped).toBe(0);
  }, 60_000);

  it('refuses every update, every delete while the organisation stands, and TRUNCATE', async () => {
    await issue(admin(), { datasetId: await finalDataset(), template: 'executive_summary' });
    const [row] = await issuanceRows();
    expect(await refusedWith(`UPDATE report_issuances SET status = 'final' WHERE id = '${row.id}'`)).toBe('TA017');
    expect(await refusedWith(`UPDATE report_issuances SET sha256 = '${'d'.repeat(64)}' WHERE id = '${row.id}'`)).toBe('TA017');
    expect(await refusedWith(`DELETE FROM report_issuances WHERE id = '${row.id}'`)).toBe('TA017');
    expect(await refusedWith('TRUNCATE report_issuances')).toBe('TA017');
    expect(await issuanceRows()).toHaveLength(1);
  }, 60_000);

  it("refuses a row that is not its dataset's: another fingerprint, year, referenced set or gap code", async () => {
    await issue(admin(), { datasetId: await finalDataset(), template: 'executive_summary' });
    const [row] = await issuanceRows();
    expect(await refusedWith(insertOf(row, { dataset_fingerprint_hex: `'${'a'.repeat(64)}'` }))).toBe('TA017');
    expect(await refusedWith(insertOf(row, { reporting_year: String(YEAR + 1) }))).toBe('TA017');
    expect(await refusedWith(insertOf(row, { referenced_subsidiary_ids: `ARRAY['${S}']::uuid[]` }))).toBe('TA017');
    expect(await refusedWith(insertOf(row, {
      status: `'partial'`, gaps: `'[{"code":"looks_fine","sourceIds":[],"obligationIds":[],"recordIds":[]}]'::jsonb`,
    }))).toBe('TA017');
    expect(await refusedWith(insertOf(row, { dataset_id: `'${randomUUID()}'` }))).toBe('TA017');
  }, 60_000);

  it('holds the shapes: a final has no gap, a partial at least one, the key is the row\'s own', async () => {
    await issue(admin(), { datasetId: await finalDataset(), template: 'executive_summary' });
    const [row] = await issuanceRows();
    const gap = `'[{"code":"coverage_gap","sourceIds":[],"obligationIds":[],"recordIds":[]}]'::jsonb`;
    expect(await refusedWith(insertOf(row, { gaps: gap }))).toBe('23514');
    expect(await refusedWith(insertOf(row, { status: `'partial'` }))).toBe('23514');
    expect(await refusedWith(insertOf(row, { storage_path: `'elsewhere/x.pdf'` }))).toBe('23514');
    expect(await refusedWith(insertOf(row, { sha256: `'${'C'.repeat(64)}'` }))).toBe('23514');
  }, 60_000);

  it('admits a final only of a confirmed inventory: never of an unconfirmed version or an extract', async () => {
    // A frozen, unconfirmed version (its capture froze it) and an extract of a confirmed one.
    const open = await version([[S2, holdingDeclaration()]], false);
    const unconfirmed = await owner.reportDataset.findUniqueOrThrow({ where: { id: await captured(open) } });
    const confirmed = await version([[S2, holdingDeclaration()]]);
    const extract = await owner.reportDataset.findUniqueOrThrow({ where: { id: await captured(confirmed, { subsidiaryId: S2 }) } });
    await issue(admin(), { datasetId: await captured(confirmed), template: 'executive_summary' });
    const [row] = await issuanceRows();
    for (const d of [unconfirmed, extract]) {
      const of = { dataset_id: `'${d.id}'`, dataset_fingerprint_hex: `'${d.fingerprintHex}'` };
      expect(await refusedWith(insertOf(row, of))).toBe('TA017');
      // As a partial, the same row is admitted.
      await withRollback(owner, (tx) => tx.$executeRawUnsafe(insertOf(row, {
        ...of, status: `'partial'`, gaps: `'[{"code":"coverage_gap","sourceIds":[],"obligationIds":[],"recordIds":[]}]'::jsonb`,
      })));
    }
    // And through the API: both are partial.
    for (const d of [unconfirmed, extract]) {
      const answer = await issue(admin(), { datasetId: d.id, template: 'executive_summary' });
      expect(answer.status, answer.text).toBe(201);
      expect(issuanceOf(answer).status).toBe('partial');
    }
  }, 120_000);

  it("goes with its organisation: the organisation's deletion takes the row, and its object is an orphan the reconciliation finds", async () => {
    const other = await createTenant();
    const otherS2 = (await owner.subsidiary.create({ data: { organisationId: other.organisationId, legalName: `Int-test holding ${randomUUID().slice(0, 8)}`, geographyCode: 'UK' } })).id;
    try {
      const service = new InventoryBoundariesService(runtime, new AuditService(runtime));
      const user = await withAccess(other.users.superAdmin);
      const { id } = await service.create(user, { reportingYear: YEAR });
      await service.putSubsidiary(user, id, otherS2, holdingDeclaration());
      await service.confirm(user, id);
      const capture = await call(other.users.superAdmin, 'POST', '/report-datasets', { boundaryId: id });
      const issued = issuanceOf(await issue(other.users.superAdmin, { datasetId: (JSON.parse(capture.text) as { datasetId: string }).datasetId, template: 'executive_summary' }));
      const path = `${other.organisationId}/${issued.pdf.artifactId}.pdf`;
      await other.cleanup();
      expect(await owner.reportIssuance.count({ where: { id: issued.issuanceId } })).toBe(0);
      expect(await objectExists(runtime, REPORT_ARTIFACTS_BUCKET, path)).toBe(true);
      const reconcile = new StorageReconcileService(runtime, storage, new StorageIntentsService(runtime, storage));
      const prefix = `${other.organisationId}/`;
      expect((await reconcile.orphans(REPORT_ARTIFACTS_BUCKET, { limit: 100_000, prefix })).map((o) => o.path)).toEqual([path]);
      await reconcile.reclaimOrphans(REPORT_ARTIFACTS_BUCKET, 0, 100_000, prefix);
      expect(await objectExists(runtime, REPORT_ARTIFACTS_BUCKET, path)).toBe(false);
    } finally {
      await removeTenantObjects(runtime, localStorage(), other);
      await other.cleanup().catch(() => undefined);
    }
  }, 90_000);
});

describe('the grants', () => {
  it('lets the runtime role insert and read, never update or delete', async () => {
    await issue(admin(), { datasetId: await finalDataset(), template: 'executive_summary' });
    const [row] = await issuanceRows();
    expect(await runtime.reportIssuance.count({ where: { id: row.id } })).toBe(1);
    for (const sql of [`UPDATE report_issuances SET status = 'final' WHERE id = '${row.id}'`, `DELETE FROM report_issuances WHERE id = '${row.id}'`]) {
      expect(sqlState(await failure(runtime.$executeRawUnsafe(sql)))).toBe('42501');
    }
  }, 60_000);

  it.each(['anon', 'authenticated', 'service_role'])('gives %s nothing — not even a read', async (role) => {
    const state = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      const [{ who }] = await tx.$queryRawUnsafe<{ who: string }[]>('SELECT current_user::text AS who');
      expect(who).toBe(role);
      return sqlState(await failure(tx.$queryRawUnsafe('SELECT count(*) FROM report_issuances')));
    });
    expect(state).toBe('42501');
  });
});

describe('the retained PDF, failed at each boundary (LP1-02)', () => {
  let user: RequestUser;
  let datasetId: string;
  const body = { template: 'executive_summary' as const };

  beforeEach(async () => {
    datasetId = await finalDataset();
    user = await withAccess(admin());
  });

  it('Storage refuses the bytes: no row, no object, no intent', async () => {
    quiet();
    vi.spyOn(storage, 'upload').mockRejectedValueOnce(new Error(INJECTED));
    expect(((await failure(issuer().issue(user, { datasetId, ...body }))) as Error).message).toBe(INJECTED);
    expect(await issuanceRows()).toEqual([]);
    expect(await artifacts()).toEqual([]);
    expect(await artifactIntents()).toEqual([]);
  }, 60_000);

  it('the stored bytes are not the rendered ones: no row, and the object is removed', async () => {
    quiet();
    vi.spyOn(storage, 'download').mockResolvedValueOnce(Buffer.from('%PDF-1.4 not these'));
    expect(((await failure(issuer().issue(user, { datasetId, ...body }))) as Error).message).toMatch(/stored PDF is not the rendered one/);
    expect(await issuanceRows()).toEqual([]);
    expect(await artifacts()).toEqual([]);
    expect(await artifactIntents()).toEqual([]);
  }, 60_000);

  it('the row transaction fails (its audit insert): the object is removed and the intent closed', async () => {
    quiet();
    await failure(issuer(failingAuditClient(runtime)).issue(user, { datasetId, ...body }));
    expect(await issuanceRows()).toEqual([]);
    expect(await artifacts()).toEqual([]);
    expect(await artifactIntents()).toEqual([]);
  }, 60_000);

  it('the transaction fails AND the removal fails: the object waits as a delete intent, and a sweep removes it', async () => {
    quiet();
    vi.spyOn(storage, 'remove').mockRejectedValueOnce(new Error(INJECTED));
    await failure(issuer(failingAuditClient(runtime)).issue(user, { datasetId, ...body }));
    const [left] = await artifacts();
    expect(left).toBeDefined();
    const [intent] = await artifactIntents();
    expect(intent).toMatchObject({ kind: 'delete', objectPath: left.path });
    await owner.$executeRaw`
      UPDATE storage_intents SET next_attempt_at = now() - interval '1 second', claimed_until = NULL WHERE id = ${intent.id}::uuid`;
    await new StorageIntentsService(runtime, storage).sweep();
    expect(await artifacts()).toEqual([]);
    expect(await artifactIntents()).toEqual([]);
  }, 60_000);

  it('the commit succeeds but its acknowledgement is lost: the row keeps its bytes', async () => {
    quiet();
    const LOST = 'connection reset after COMMIT (LP3-04 PR D test)';
    let transactions = 0;
    // The read snapshot is the first transaction; the row's the second — it
    // really commits, and the caller sees an error anyway.
    const lostAck = new Proxy(runtime, {
      get(target, prop) {
        if (prop === '$transaction') {
          return async (...args: unknown[]) => {
            const result = await (target.$transaction as (...x: unknown[]) => Promise<unknown>)(...args);
            transactions += 1;
            if (transactions === 2) throw new Error(LOST);
            return result;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as PrismaService;
    expect(((await failure(issuer(lostAck, storage, new StorageIntentsService(runtime, storage)).issue(user, { datasetId, ...body }))) as Error).message).toBe(LOST);
    const [row] = await issuanceRows();
    expect(row).toBeDefined();
    expect(sha256(await storage.download(REPORT_ARTIFACTS_BUCKET, row.storagePath))).toBe(row.sha256);
    expect(await artifactIntents()).toEqual([]);
    // Kept because no removal was ever asked for — not because the owned-bytes
    // guard caught one (that logs "still owns" and pages an operator): the
    // ownership transaction's failure takes the conditional abandonment only
    // (`qa-auditor`'s re-review: the bytes alone cannot tell the two apart).
    const logged = vi.mocked(Logger.prototype.error).mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toMatch(/still owns/);
  }, 60_000);

  it('the sweeper abandons the upload before the row adopts it: 409 upload_expired, nothing is left', async () => {
    quiet();
    const held = holdBefore(runtime, 'StorageIntent', 'deleteMany');
    const pending = failure(issuer(held.client, storage, new StorageIntentsService(held.client, storage)).issue(user, { datasetId, ...body }));
    await held.reached(30_000);
    const [intent] = await artifactIntents();
    expect(intent.kind).toBe('upload');
    await owner.$executeRaw`
      UPDATE storage_intents SET created_at = now() - ${UPLOAD_GRACE_SECONDS + 60}::int * interval '1 second' WHERE id = ${intent.id}::uuid`;
    await new StorageIntentsService(runtime, storage).sweep();
    expect(await objectExists(runtime, REPORT_ARTIFACTS_BUCKET, intent.objectPath)).toBe(false);
    held.release();
    const refused = await pending;
    expect(refused).toBeInstanceOf(UploadExpiredError);
    expect((refused as UploadExpiredError).getStatus()).toBe(409);
    expect(await issuanceRows()).toEqual([]);
    expect(await artifactIntents()).toEqual([]);
  }, 60_000);
});

/**
 * Codex's B9 review of #198 (P2): a LATE upload — the sweeper took the intent,
 * aged past its grace, while the bytes were still on their way, so its removal
 * ran before they landed — followed by a failure BEFORE the ownership
 * transaction. No row can own those bytes, so they must go: removed at once,
 * nothing left for another sweep. Real PostgreSQL and Storage; only the
 * spied Storage call is delayed or failed. The controls beside it: the same
 * late upload refused at adoption (`UploadExpiredError`), and a committed
 * issuance whose acknowledgement was lost, which keeps its bytes (above).
 */
describe('a late upload, then a failure before the ownership transaction (Codex B9 P2)', () => {
  let user: RequestUser;
  let datasetId: string;

  beforeEach(async () => {
    datasetId = await finalDataset();
    user = await withAccess(admin());
  });

  /** Holds the upload until the sweeper has taken its intent, then sends the real bytes — late; `thenFail` reports a failure after they landed. */
  function lateUpload(thenFail?: Error) {
    const real = storage.upload.bind(storage);
    return vi.spyOn(storage, 'upload').mockImplementationOnce(async (bucket, path, body, contentType) => {
      const intent = await owner.storageIntent.findFirstOrThrow({ where: { bucket, objectPath: path } });
      expect(intent.kind).toBe('upload');
      await owner.$executeRaw`
        UPDATE storage_intents SET created_at = now() - ${UPLOAD_GRACE_SECONDS + 60}::int * interval '1 second' WHERE id = ${intent.id}::uuid`;
      const swept = await new StorageIntentsService(runtime, localStorage()).sweep();
      expect(swept.abandoned).toBeGreaterThanOrEqual(1);
      expect(await owner.storageIntent.count({ where: { id: intent.id } })).toBe(0);
      await real(bucket, path, body, contentType);
      expect(await objectExists(runtime, REPORT_ARTIFACTS_BUCKET, path)).toBe(true);
      if (thenFail) throw thenFail;
    });
  }

  /** Nothing of the issuance is left — no row, no audit row, no intent, no object — and another sweep finds nothing either. */
  async function nothingLeft(upload: ReturnType<typeof lateUpload>) {
    const path = upload.mock.calls[0]![1];
    expect(await issuanceRows()).toEqual([]);
    expect(await issueAudits()).toEqual([]);
    expect(await artifactIntents()).toEqual([]);
    expect(await objectExists(runtime, REPORT_ARTIFACTS_BUCKET, path)).toBe(false);
    await new StorageIntentsService(runtime, localStorage()).sweep();
    expect(await artifacts()).toEqual([]);
    expect(await artifactIntents()).toEqual([]);
  }

  it.each([
    ['the read-back fails (a Storage outage)', () => vi.spyOn(storage, 'download').mockRejectedValueOnce(new Error(INJECTED)), INJECTED],
    ['the stored bytes are not the rendered ones', () => vi.spyOn(storage, 'download').mockResolvedValueOnce(Buffer.from('%PDF-1.4 not these')), /stored PDF is not the rendered one/],
  ] as const)('%s: the late bytes are removed — no orphan', async (_what, fail, message) => {
    quiet();
    const upload = lateUpload();
    fail();
    const refused = await failure(issuer().issue(user, { datasetId, template: 'executive_summary' }));
    expect((refused as Error).message).toMatch(message);
    await nothingLeft(upload);
  }, 60_000);

  it('the upload reports a failure after its bytes landed: removed too', async () => {
    quiet();
    const upload = lateUpload(new Error(INJECTED));
    expect(((await failure(issuer().issue(user, { datasetId, template: 'executive_summary' }))) as Error).message).toBe(INJECTED);
    await nothingLeft(upload);
  }, 60_000);

  it('control: the same late upload, read back intact, is refused at adoption — 409 upload_expired, removed', async () => {
    quiet();
    const upload = lateUpload();
    const refused = await failure(issuer().issue(user, { datasetId, template: 'executive_summary' }));
    expect(refused).toBeInstanceOf(UploadExpiredError);
    await nothingLeft(upload);
  }, 60_000);

  it('the two abandonments differ only where they must: after the transaction a gone intent keeps the bytes; before it, they go', async () => {
    quiet();
    const intents = new StorageIntentsService(runtime, localStorage());
    const place = async () => {
      const path = `${t.organisationId}/${randomUUID()}.pdf`;
      const ref = { bucket: REPORT_ARTIFACTS_BUCKET as typeof REPORT_ARTIFACTS_BUCKET, path };
      const id = await intents.beginUpload(ref, { reason: 'report_issuance.upload', organisationId: t.organisationId });
      // The intent gone and the bytes there — as after an adoption, or after a sweep and a late upload.
      await owner.storageIntent.deleteMany({ where: { id } });
      await storage.upload(REPORT_ARTIFACTS_BUCKET, path, Buffer.from('%PDF-1.4 x'), 'application/pdf');
      return { id, ref, path };
    };
    // A failure from the ownership transaction on: it may have committed — the bytes stay.
    const ambiguous = await place();
    await intents.abandonUpload(ambiguous.id, ambiguous.ref, new Error('ack lost'), { organisationId: t.organisationId });
    expect(await objectExists(runtime, REPORT_ARTIFACTS_BUCKET, ambiguous.path)).toBe(true);
    // A failure before it: nothing can own them — they go.
    const unadopted = await place();
    await intents.abandonUnadoptedUpload(unadopted.id, unadopted.ref, { organisationId: t.organisationId });
    expect(await objectExists(runtime, REPORT_ARTIFACTS_BUCKET, unadopted.path)).toBe(false);
    expect(await artifactIntents()).toEqual([]);
  }, 60_000);
});

describe('the download — the retained bytes, verified', () => {
  it('answers bytes gone from Storage as report_artifact_missing, and changed bytes as an internal error; reconcile finds both', async () => {
    quiet();
    const issued = issuanceOf(await issue(admin(), { datasetId: await finalDataset(), template: 'executive_summary' }));
    const [row] = await issuanceRows();
    const reconcile = new StorageReconcileService(runtime, storage, new StorageIntentsService(runtime, storage));
    const ALL = { limit: 100_000 };
    const mine = (found: Array<{ rowId: string }>) => found.filter((f) => f.rowId === row.id);
    expect(mine(await reconcile.verifyHashes(REPORT_ARTIFACTS_BUCKET, ALL).then((r) => r.problems))).toEqual([]);

    await storage.remove(REPORT_ARTIFACTS_BUCKET, [row.storagePath]);
    const gone = await call(admin(), 'GET', `/report-issuances/${issued.issuanceId}/pdf`);
    expect(gone.status).toBe(404);
    expect(gone.code).toBe('report_artifact_missing');
    expect(mine(await reconcile.missingObjects(REPORT_ARTIFACTS_BUCKET, ALL)))
      .toEqual([expect.objectContaining({ rowId: row.id, problem: 'no-object' })]);

    await storage.upload(REPORT_ARTIFACTS_BUCKET, row.storagePath, Buffer.from('%PDF-1.4 replaced'), 'application/pdf');
    const changed = await call(admin(), 'GET', `/report-issuances/${issued.issuanceId}/pdf`);
    expect(changed.status).toBe(500);
    expect(changed.text).not.toContain('replaced');
    expect(mine(await reconcile.verifyHashes(REPORT_ARTIFACTS_BUCKET, ALL).then((r) => r.problems)))
      .toEqual([expect.objectContaining({ rowId: row.id, problem: 'hash-mismatch' })]);
  }, 60_000);
});
