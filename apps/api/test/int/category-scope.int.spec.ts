/**
 * INC-2.6 §1, §7.3, ruling R5 (task 8.5): a standard user's grant names the
 * categories it works in. Through the REAL API — the guard builds the grant's
 * categories from the database, on the runtime role — a company holds an
 * Electricity and a Fuel record by another author. A standard user granted
 * the company with Electricity alone creates Electricity, is refused Fuel with
 * nothing stored and no audit row, and in every read module (the list, the
 * read by id, evidence, the emissions totals, the dashboard's tracking matrix,
 * import batches) sees Electricity and its own records only — a Fuel record by
 * id answering exactly as an unknown one. The company's super_admin sees both.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ActivityRecordStatus, UserRole } from '@tonyai/db';
import type { BulkSubmitReportDTO, CursorPage, ImportBatchDetailDTO, ReportingMatrixResponse, ReportingSummaryResponse } from '@tonyai/shared-types';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestUser } from '../../src/auth/auth.types';
import { PrismaService } from '../../src/prisma/prisma.service';
import { addMember, apiTokenIssuer, attachEvidence, connectOwner, createRecord, createTenant, type Tenant } from './db';

const JWT_SECRET = randomBytes(32).toString('hex');
let app: INestApplication;
let base: string;
let owner: PrismaService;

/** The figures: Fuel's is the marker no reply to the narrowed user may hold. */
const ELECTRICITY_TCO2E = 11;
const FUEL_TCO2E = 7777;
const OWN_TCO2E = 5;

let t: Tenant;
/** A standard user granted the company with Electricity alone. */
let narrow: RequestUser;
let electricity: string;
let fuel: string;
/** The narrowed user's own record in a category it is not granted (approved). */
let own: string;
/** …and its own draft in that category. */
let ownDraft: string;
let electricityEvidence: string;
let fuelEvidence: string;
let batch: string;

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
}, 60_000);

afterAll(async () => {
  await owner?.$disconnect();
  await app?.close();
});

beforeEach(async () => {
  t = await createTenant();
  narrow = await addMember(owner, t, UserRole.standard_user, { grants: [t.subsidiaryId], categories: ['Electricity'] });
  // A batch the narrowed user uploaded over its granted company, holding the
  // colleague's Electricity and Fuel records.
  batch = (
    await owner.importBatch.create({
      data: {
        organisationId: t.organisationId, uploadedBy: narrow.id, fileName: 'int-test.csv', fileFormat: 'csv',
        sizeBytes: 1, sha256: '0'.repeat(64), totalRows: 2, subsidiaryIds: [t.subsidiaryId],
      },
    })
  ).id;
  // Another author's records: the fixture's standard user, granted every category.
  electricity = (
    await createRecord(owner, t, {
      category: 'Electricity', status: ActivityRecordStatus.approved, periodValue: 'January', importBatchId: batch,
      calculation: { tCo2e: ELECTRICITY_TCO2E, factorId: 'int-test-placeholder' },
    })
  ).id;
  fuel = (
    await createRecord(owner, t, {
      category: 'Fuel', activityType: 'diesel', activityUnit: 'litres', status: ActivityRecordStatus.approved, periodValue: 'January',
      importBatchId: batch, calculation: { tCo2e: FUEL_TCO2E, factorId: 'int-test-placeholder' },
    })
  ).id;
  own = (
    await createRecord(owner, t, {
      category: 'Natural Gas', activityUnit: 'cubic_metres', status: ActivityRecordStatus.approved, periodValue: 'February',
      createdBy: narrow.id, calculation: { tCo2e: OWN_TCO2E, factorId: 'int-test-placeholder' },
    })
  ).id;
  ownDraft = (
    await createRecord(owner, t, { category: 'Natural Gas', activityUnit: 'cubic_metres', periodValue: 'March', createdBy: narrow.id }, { priced: true })
  ).id;
  electricityEvidence = (await attachEvidence(owner, t, [electricity])).id;
  fuelEvidence = (await attachEvidence(owner, t, [fuel])).id;
});

afterEach(async () => {
  await t.cleanup();
});

async function tokenFor(userId: string): Promise<string> {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(apiTokenIssuer())
    .setSubject(userId)
    .setAudience('authenticated')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

interface Answer {
  status: number;
  text: string;
}

async function call(user: RequestUser, method: string, path: string, body?: unknown): Promise<Answer> {
  const headers: Record<string, string> = { authorization: `Bearer ${await tokenFor(user.id)}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

async function ok<T>(user: RequestUser, path: string): Promise<T> {
  const answer = await call(user, 'GET', path);
  if (answer.status !== 200) throw new Error(`GET ${path} answered ${answer.status}: ${answer.text}`);
  return JSON.parse(answer.text) as T;
}

/** An answer with `id` replaced, so an existing record's and a random id's answers compare. */
const swapped = (answer: Answer, id: string) => `${answer.status} ${answer.text.split(id).join('<id>')}`;

const listed = async (user: RequestUser) =>
  (await ok<CursorPage<{ id: string }>>(user, '/activity-records?limit=100')).items.map((r) => r.id).sort();

const electricityBody = { subsidiaryId: '', reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'August', category: 'Electricity', activityValue: 10, activityUnit: 'kWh' };
const fuelBody = { ...electricityBody, category: 'Fuel', activityType: 'diesel', activityValue: 10, activityUnit: 'litres' };

describe('a standard user granted Electricity alone (INC-2.6 §1, task 8.5)', () => {
  it('creates an Electricity record of the company', async () => {
    const created = await call(narrow, 'POST', '/activity-records', { ...electricityBody, subsidiaryId: t.subsidiaryId });
    expect(created.status, created.text).toBe(201);
    const id = (JSON.parse(created.text) as { id: string }).id;
    expect(await owner.auditLog.count({ where: { entityId: id, action: 'create', userId: narrow.id } })).toBe(1);
  });

  it('is refused a Fuel record — 403 category_not_granted naming it — with nothing stored and no audit row', async () => {
    const records = () => owner.activityRecord.count({ where: { subsidiaryId: t.subsidiaryId } });
    const audit = () => owner.auditLog.count({ where: { OR: [{ organisationId: t.organisationId }, { userId: { in: t.profileIds } }] } });
    const [recordsBefore, auditBefore] = [await records(), await audit()];
    const refused = await call(narrow, 'POST', '/activity-records', { ...fuelBody, subsidiaryId: t.subsidiaryId });
    expect(refused.status, refused.text).toBe(403);
    expect(JSON.parse(refused.text)).toMatchObject({ code: 'category_not_granted', params: { category: 'Fuel' } });
    expect([await records(), await audit()]).toEqual([recordsBefore, auditBefore]);
  });

  it('is refused the submit of its own record in a category no longer granted, alone and in a bulk submit; the record stays a draft', async () => {
    const refused = await call(narrow, 'POST', `/activity-records/${ownDraft}/submit`);
    expect([refused.status, (JSON.parse(refused.text) as { code?: string }).code]).toEqual([403, 'category_not_granted']);
    const bulk = await call(narrow, 'POST', '/activity-records/bulk-submit', { recordIds: [ownDraft] });
    expect(bulk.status, bulk.text).toBeLessThan(300);
    const report = JSON.parse(bulk.text) as BulkSubmitReportDTO;
    expect(report.submitted).toEqual([]);
    expect(report.failed).toEqual([expect.objectContaining({ recordId: ownDraft, code: 'category_not_granted' })]);
    expect((await owner.activityRecord.findUniqueOrThrow({ where: { id: ownDraft } })).status).toBe(ActivityRecordStatus.draft);
    expect(await owner.auditLog.count({ where: { entityId: ownDraft, action: 'submit' } })).toBe(0);
  });

  it('lists Electricity and its own records, never Fuel', async () => {
    expect(await listed(narrow)).toEqual([electricity, own, ownDraft].sort());
  });

  it('reads a Fuel record by id, and its evidence, exactly as an unknown one; Electricity and its own as they are', async () => {
    const missing = randomUUID();
    for (const path of [(id: string) => `/activity-records/${id}`, (id: string) => `/activity-records/${id}/evidence`, (id: string) => `/activity-records/${id}/audit-trail`]) {
      const foreign = await call(narrow, 'GET', path(fuel));
      const unknown = await call(narrow, 'GET', path(missing));
      expect(foreign.status, path(fuel)).toBe(404);
      expect(swapped(foreign, fuel)).toBe(swapped(unknown, missing));
    }
    expect((await call(narrow, 'GET', `/activity-records/${electricity}`)).status).toBe(200);
    expect((await call(narrow, 'GET', `/activity-records/${own}`)).status).toBe(200);
    expect((await call(narrow, 'GET', `/activity-records/${electricity}/evidence`)).text).toContain(electricityEvidence);
    // A file linked to Fuel alone, by another uploader: as an unknown file.
    const fileUnknown = randomUUID();
    const fuelFile = await call(narrow, 'GET', `/evidence/${fuelEvidence}/url`);
    expect(fuelFile.status).toBe(404);
    expect(swapped(fuelFile, fuelEvidence)).toBe(swapped(await call(narrow, 'GET', `/evidence/${fileUnknown}/url`), fileUnknown));
    // Control: Electricity's file is not answered as unknown.
    expect(swapped(await call(narrow, 'GET', `/evidence/${electricityEvidence}/url`), electricityEvidence)).not.toBe(swapped(fuelFile, fuelEvidence));
  });

  it('totals Electricity and its own records: the emissions summary and the dashboard\'s tracking matrix count no Fuel', async () => {
    const summary = await ok<ReportingSummaryResponse>(narrow, '/emissions/context/summary?year=2026');
    expect(summary.data.totals.total).toBe(ELECTRICITY_TCO2E + OWN_TCO2E);
    expect(summary.data.byCategory.map((c) => c.category).sort()).toEqual(['Electricity', 'Natural Gas']);
    const matrix = await ok<ReportingMatrixResponse>(narrow, '/emissions/context/tracking-matrix?year=2026');
    expect(matrix.data.rows.reduce((sum, r) => sum + r.totalTCo2e, 0)).toBe(ELECTRICITY_TCO2E + OWN_TCO2E);
    // No Fuel cell, and none counted missing (owner's review): the row holds the
    // ticked category and the one of its own record only.
    const cells = matrix.data.rows.flatMap((r) => r.cells.map((c) => c.category));
    expect(cells).not.toContain('Fuel');
    expect(new Set(cells)).toEqual(new Set(['Electricity', 'Natural Gas']));
    for (const path of ['/emissions/context/summary?year=2026', '/emissions/context/tracking-matrix?year=2026', '/emissions/summary?year=2026', '/emissions/tracking-matrix?year=2026']) {
      const answer = await call(narrow, 'GET', path);
      expect(answer.status, `${path}: ${answer.text.slice(0, 200)}`).toBe(200);
      expect(answer.text, path).not.toContain(String(FUEL_TCO2E));
      expect(answer.text, path).not.toContain(fuel);
    }
  });

  it('reads report metadata and its company summary without the Fuel record (security review P1)', async () => {
    for (const path of [`/reports/meta?year=2026&subsidiaryId=${t.subsidiaryId}`, '/reports/context/meta?year=2026', `/subsidiaries/${t.subsidiaryId}/summary`]) {
      const answer = await call(narrow, 'GET', path);
      expect(answer.status, `${path}: ${answer.text.slice(0, 200)}`).toBe(200);
      expect(answer.text, path).not.toContain(String(FUEL_TCO2E));
      expect(answer.text, path).not.toContain('"Fuel"');
    }
    // The super_admin of the company still counts the Fuel record there.
    const sa = await call(t.users.superAdmin, 'GET', `/reports/meta?year=2026&subsidiaryId=${t.subsidiaryId}`);
    expect(sa.text).toContain(String(FUEL_TCO2E));
  });

  it('reads its import batch with the Electricity record alone', async () => {
    const detail = await ok<ImportBatchDetailDTO>(narrow, `/import-batches/${batch}`);
    expect(detail.records.map((r) => r.id)).toEqual([electricity]);
    // Control: an organisation-wide reader sees both of the batch's records.
    const whole = await ok<ImportBatchDetailDTO>(t.users.masterkey, `/import-batches/${batch}`);
    expect(whole.records.map((r) => r.id).sort()).toEqual([electricity, fuel].sort());
  });
});

describe("the company's super_admin sees both categories (INC-2.6 §1)", () => {
  it('lists, reads and totals Electricity and Fuel', async () => {
    expect(await listed(t.users.superAdmin)).toEqual([electricity, fuel, own, ownDraft].sort());
    expect((await call(t.users.superAdmin, 'GET', `/activity-records/${fuel}`)).status).toBe(200);
    expect((await call(t.users.superAdmin, 'GET', `/activity-records/${fuel}/evidence`)).text).toContain(fuelEvidence);
    const summary = await ok<ReportingSummaryResponse>(t.users.superAdmin, '/emissions/context/summary?year=2026');
    expect(summary.data.totals.total).toBe(ELECTRICITY_TCO2E + FUEL_TCO2E + OWN_TCO2E);
    expect(summary.data.byCategory.map((c) => c.category).sort()).toEqual(['Electricity', 'Fuel', 'Natural Gas']);
  });
});
