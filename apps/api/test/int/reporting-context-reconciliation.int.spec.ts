import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ActivityRecordStatus } from '@tonyai/db';
import {
  CATEGORY_SCOPE_MAP,
  COUNTED_STATUSES,
  type Category,
  type ReportingContext,
  type ReportingIntensityResponse,
  type ReportingMatrixResponse,
  type ReportingMetaResponse,
  type ReportingSummaryResponse,
} from '@tonyai/shared-types';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeLimits } from '../../src/common/runtime-limits';
import { PrismaService } from '../../src/prisma/prisma.service';
import { apiTokenIssuer, connectOwner, createRecord, createTenant, type Tenant } from './db';

/**
 * LP3-02 (F08) "done when": a two-year / two-subsidiary fixture gives the SAME
 * answer on every surface that reads one reporting context — the dashboard's
 * summary and tracking matrix, the absolute and intensity views, and the
 * report's metadata, its CSV ledger and its generation audit row — through the
 * real API (global guard, validation pipe, runtime role, real JWT auth) on the
 * real database. And the 2027 rollover: selectable, empty, with no factor
 * coverage claimed and a 2027 calculation refused (D07).
 *
 * Each surface is compared with a figure computed HERE from the fixture, not
 * only with the others: two surfaces sharing one wrong aggregation would agree.
 */

const JWT_SECRET = randomBytes(32).toString('hex');
/** What every total counts — submitted and under review included (shared-types). */
const COMMITTED = new Set<string>(COUNTED_STATUSES);

let app: INestApplication;
let base: string;
let owner: PrismaService;
let limits: RuntimeLimits;
let previousExportRate: number;
let t: Tenant;
let S1: string;
let S2: string;

interface Row {
  sub: 'S1' | 'S2';
  year: number;
  category: Category;
  periodValue: string;
  status: ActivityRecordStatus;
  tCo2e: number;
}

// Integers, distinct per row, so a sum that picks up the wrong row shows.
const FIXTURE: Row[] = [
  { sub: 'S1', year: 2025, category: 'Electricity', periodValue: 'January', status: ActivityRecordStatus.approved, tCo2e: 120 },
  { sub: 'S1', year: 2025, category: 'Natural Gas', periodValue: 'February', status: ActivityRecordStatus.locked, tCo2e: 45 },
  { sub: 'S2', year: 2025, category: 'Electricity', periodValue: 'January', status: ActivityRecordStatus.approved, tCo2e: 7 },
  { sub: 'S2', year: 2025, category: 'Natural Gas', periodValue: 'March', status: ActivityRecordStatus.draft, tCo2e: 999 },
  { sub: 'S1', year: 2025, category: 'Electricity', periodValue: 'March', status: ActivityRecordStatus.voided, tCo2e: 500 },
  { sub: 'S1', year: 2026, category: 'Electricity', periodValue: 'January', status: ActivityRecordStatus.approved, tCo2e: 30 },
  { sub: 'S2', year: 2026, category: 'Natural Gas', periodValue: 'January', status: ActivityRecordStatus.approved, tCo2e: 11 },
  { sub: 'S2', year: 2026, category: 'Electricity', periodValue: 'February', status: ActivityRecordStatus.approved, tCo2e: 5 },
  { sub: 'S1', year: 2026, category: 'Natural Gas', periodValue: 'January', status: ActivityRecordStatus.submitted, tCo2e: 888 },
  { sub: 'S2', year: 2026, category: 'Electricity', periodValue: 'March', status: ActivityRecordStatus.under_review, tCo2e: 13 },
  { sub: 'S1', year: 2025, category: 'Natural Gas', periodValue: 'April', status: ActivityRecordStatus.rejected, tCo2e: 777 },
];
/** Revenue (EUR) per year and subsidiary; S2 has none for 2026 — missing, not zero (D14). */
const REVENUE: Record<number, Partial<Record<'S1' | 'S2', number>>> = { 2025: { S1: 1000, S2: 100 }, 2026: { S1: 2000 } };

const YEARS = [2025, 2026, 2027] as const;
const SELECTIONS = ['all', 'S1', 'S2'] as const;
const FILTERS: Pick<ReportingContext, 'scope' | 'category'>[] = [{}, { scope: 2 }, { category: 'Natural Gas' }];

const idOf = (sub: 'S1' | 'S2') => (sub === 'S1' ? S1 : S2);
const contextFor = (year: number, selection: (typeof SELECTIONS)[number], filter: Pick<ReportingContext, 'scope' | 'category'>): ReportingContext => ({
  year,
  ...(selection === 'all' ? {} : { subsidiaryId: idOf(selection) }),
  ...filter,
});
const inContext = (row: Row, context: ReportingContext) =>
  row.year === context.year &&
  (context.subsidiaryId === undefined || idOf(row.sub) === context.subsidiaryId) &&
  (context.scope === undefined || CATEGORY_SCOPE_MAP[row.category] === context.scope) &&
  (context.category === undefined || row.category === context.category);
const sum = (rows: Row[]) => rows.reduce((total, row) => total + row.tCo2e, 0);
const query = (context: ReportingContext, extra: Record<string, string> = {}) =>
  `?${new URLSearchParams({ ...Object.fromEntries(Object.entries(context).map(([k, v]) => [k, String(v)])), ...extra })}`;

async function tokenFor(userId: string): Promise<string> {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(apiTokenIssuer())
    .setSubject(userId)
    .setAudience('authenticated')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

async function get(userId: string, path: string, method = 'GET'): Promise<Response> {
  return fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${await tokenFor(userId)}` } });
}
async function json<T>(userId: string, path: string): Promise<T> {
  const res = await get(userId, path);
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${path} → ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** RFC 4180, as `csvField` writes it: quoted fields, doubled quotes, `\n` rows. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  const body = text.startsWith(String.fromCharCode(0xfeff)) ? text.slice(1) : text;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; } else field += ch;
  }
  const [header, ...data] = rows;
  return data.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])));
}

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
  limits = app.get(RuntimeLimits);
  configureApp(app, quiet, { requestLogging: false, runtimeLimits: limits });
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/api/v1`.replace('[::1]', '127.0.0.1');
  const [{ user }] = await app.get(PrismaService).$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`;
  if (user !== 'tonyai_runtime') throw new Error(`the application under test connects as ${user}, not tonyai_runtime`);
  // This file exports 27 selections; the quota under test is tenant-isolation's.
  const config = limits.config as { RATE_EXPORT_PER_MINUTE: number };
  previousExportRate = config.RATE_EXPORT_PER_MINUTE;
  config.RATE_EXPORT_PER_MINUTE = 10_000;

  owner = connectOwner(2);
  t = await createTenant();
  S1 = t.subsidiaryId;
  ({ id: S2 } = await owner.subsidiary.create({
    data: { organisationId: t.organisationId, legalName: `Int-test second subsidiary ${S1.slice(0, 8)}`, geographyCode: 'UK' },
  }));
  for (const row of FIXTURE) {
    await createRecord(owner, t, {
      subsidiaryId: idOf(row.sub),
      reportingYear: row.year,
      category: row.category,
      periodValue: row.periodValue,
      status: row.status,
      calculation: { tCo2e: row.tCo2e, factorId: 'int-test-placeholder' },
      ...(row.status === ActivityRecordStatus.voided
        ? { voidReason: 'Int-test reconciliation withdrawal', voidedBy: t.users.superAdmin.id, voidedAt: new Date('2025-12-01T00:00:00Z') }
        : {}),
    });
  }
  for (const [year, bySub] of Object.entries(REVENUE)) {
    for (const [sub, value] of Object.entries(bySub)) {
      await owner.subsidiaryDenominator.create({
        data: { subsidiaryId: idOf(sub as 'S1' | 'S2'), year: Number(year), metric: 'revenue', value, unit: 'EUR', createdBy: t.users.superAdmin.id },
      });
    }
  }
}, 60_000);

afterAll(async () => {
  if (limits) (limits.config as { RATE_EXPORT_PER_MINUTE: number }).RATE_EXPORT_PER_MINUTE = previousExportRate;
  if (t) await owner.subsidiaryDenominator.deleteMany({ where: { subsidiary: { organisationId: t.organisationId } } });
  await t?.cleanup();
  await owner?.$disconnect();
  await app?.close();
});

describe('one reporting context, every surface: two years × two subsidiaries (LP3-02 done-when)', () => {
  const cases = YEARS.flatMap((year) => SELECTIONS.flatMap((selection) => FILTERS.map((filter) => [year, selection, filter] as const)));

  it.each(cases)('%i · %s · %j', async (year, selection, filter) => {
    const context = contextFor(year, selection, filter);
    const label = JSON.stringify(context);
    const rows = FIXTURE.filter((row) => inContext(row, context));
    const committed = rows.filter((row) => COMMITTED.has(row.status));
    const voided = rows.filter((row) => row.status === ActivityRecordStatus.voided);
    const total = sum(committed);
    const viewer = t.users.consultant.id;

    // Dashboard + absolute view: the summary.
    const summary = await json<ReportingSummaryResponse>(viewer, `/emissions/context/summary${query(context)}`);
    expect(summary.context, label).toEqual(context);
    expect(summary.data.totals.total, label).toBe(total);
    expect(summary.data.totals.scope1, label).toBe(sum(committed.filter((r) => CATEGORY_SCOPE_MAP[r.category] === 1)));
    expect(summary.data.totals.scope2, label).toBe(sum(committed.filter((r) => CATEGORY_SCOPE_MAP[r.category] === 2)));
    expect(summary.data.recordCount, label).toBe(committed.length);
    expect(summary.data.bySubsidiary.reduce((s, b) => s + b.tCo2e, 0), label).toBe(total);

    // Dashboard: the tracking matrix of the same selection — its rows' totals
    // add up to the summary's, and it is that year's grid.
    const matrix = await json<ReportingMatrixResponse>(viewer, `/emissions/context/tracking-matrix${query(context)}`);
    expect(matrix.data.reportingYear, label).toBe(year);
    expect(matrix.data.rows.reduce((s, r) => s + r.totalTCo2e, 0), label).toBe(total);
    for (const sub of ['S1', 'S2'] as const) {
      const row = matrix.data.rows.find((r) => r.subsidiaryId === idOf(sub));
      if (context.subsidiaryId !== undefined && context.subsidiaryId !== idOf(sub)) expect(row, label).toBeUndefined();
      else expect(row?.totalTCo2e, `${label} ${sub}`).toBe(sum(committed.filter((r) => r.sub === sub)));
    }

    // Intensity: revenue divides only its contributors' committed emissions
    // (D14); a subsidiary without a denominator is disclosed as missing.
    const intensity = await json<ReportingIntensityResponse>(viewer, `/intensity/context${query(context)}`);
    const revenue = REVENUE[year] ?? {};
    const contributors = (['S1', 'S2'] as const).filter((sub) =>
      revenue[sub] !== undefined && (context.subsidiaryId === undefined || context.subsidiaryId === idOf(sub)));
    expect(intensity.data.selectedSubsidiaryIds.sort(), label)
      .toEqual((context.subsidiaryId === undefined ? [S1, S2] : [context.subsidiaryId]).sort());
    if (contributors.length === 0) {
      expect(intensity.data.metrics, label).toEqual([]);
    } else {
      expect(intensity.data.metrics, label).toHaveLength(1);
      const [metric] = intensity.data.metrics;
      const numerator = sum(committed.filter((r) => contributors.includes(r.sub)));
      const denominator = contributors.reduce((s, sub) => s + (revenue[sub] ?? 0), 0);
      expect(metric, label).toMatchObject({ metric: 'revenue', unit: 'EUR', emissionsTotal: numerator, denominatorTotal: denominator, uncalculatedRecordCount: 0 });
      expect(metric.contributingSubsidiaryIds.sort(), label).toEqual(contributors.map(idOf).sort());
      expect(metric.intensity, label).toBeCloseTo(numerator / denominator, 12);
    }

    // The report: its metadata, its CSV ledger and its generation audit row.
    const meta = await json<ReportingMetaResponse>(viewer, `/reports/context/meta${query(context)}`);
    expect(meta.data, label).toMatchObject({
      committedCount: committed.length,
      pendingCount: rows.filter((r) => r.status === ActivityRecordStatus.submitted || r.status === ActivityRecordStatus.under_review).length,
      incompleteCount: rows.filter((r) => r.status === ActivityRecordStatus.draft || r.status === ActivityRecordStatus.rejected).length,
      voidedCount: voided.length,
    });

    const before = new Set((await owner.auditLog.findMany({ where: { organisationId: t.organisationId, entity: 'report' }, select: { id: true } })).map((r) => r.id));
    const csv = await get(viewer, `/reports/context/csv${query(context, { template: 'executive_summary' })}`);
    expect(csv.status, label).toBe(200);
    const ledger = parseCsv(await csv.text());
    const committedRows = ledger.filter((r) => COMMITTED.has(r.status));
    expect(committedRows.length, label).toBe(committed.length);
    expect(committedRows.reduce((s, r) => s + Number(r.tco2e), 0), label).toBe(total);
    const voidedRows = ledger.filter((r) => r.status === ActivityRecordStatus.voided);
    expect(voidedRows.length, label).toBe(voided.length);
    expect(voidedRows.reduce((s, r) => s + Number(r.voided_tco2e), 0), label).toBe(sum(voided));
    expect(ledger.length, label).toBe(committed.length + voided.length);
    const audit = (await owner.auditLog.findMany({ where: { organisationId: t.organisationId, entity: 'report' } })).filter((r) => !before.has(r.id));
    expect(audit.map((r) => r.diff), label).toEqual([
      expect.objectContaining({ year, recordCount: committed.length, voidedCount: voided.length, ...(context.subsidiaryId ? { subsidiaryId: context.subsidiaryId } : {}), ...filter }),
    ]);
  });
});

describe('the 2027 rollover (D06, D07)', () => {
  it('2027 is a valid, empty selection that claims no factor coverage', async () => {
    const context = { year: 2027 };
    const summary = await json<ReportingSummaryResponse>(t.users.consultant.id, `/emissions/context/summary${query(context)}`);
    expect(summary.data).toMatchObject({ recordCount: 0, totals: { scope1: 0, scope2: 0, scope3: 0, total: 0 } });
    const intensity = await json<ReportingIntensityResponse>(t.users.consultant.id, `/intensity/context${query(context)}`);
    expect(intensity.data.metrics).toEqual([]);
  });

  it('a 2027 calculation is refused with no_factor — no "latest overall" fallback', async () => {
    const res = await fetch(`${base}/calculations/preview`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(t.users.dataEntry.id)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'Electricity', geographyCode: 'UK', reportingYear: 2027, value: 100, unit: 'kWh' }),
    });
    const body = (await res.json()) as { code?: string };
    expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(body.code).toBe('no_factor');
    // The control: the same calculation for a year the library covers is priced.
    const priced = await fetch(`${base}/calculations/preview`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(t.users.dataEntry.id)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'Electricity', geographyCode: 'UK', reportingYear: 2026, value: 100, unit: 'kWh' }),
    });
    expect(priced.status).toBe(200);
  });
});

describe('a selection is not authorisation: data_entry granted S1 only', () => {
  it('reads S2 as empty and "all" as S1 alone — never broadened', async () => {
    const entry = t.users.dataEntry.id;
    for (const year of [2025, 2026]) {
      const s2 = await json<ReportingSummaryResponse>(entry, `/emissions/context/summary${query({ year, subsidiaryId: S2 })}`);
      expect(s2.data.recordCount, `${year} S2`).toBe(0);
      expect(s2.data.totals.total, `${year} S2`).toBe(0);
      const all = await json<ReportingSummaryResponse>(entry, `/emissions/context/summary${query({ year })}`);
      expect(all.data.totals.total, `${year} all`).toBe(sum(FIXTURE.filter((r) => r.sub === 'S1' && r.year === year && COMMITTED.has(r.status))));
      const matrix = await json<ReportingMatrixResponse>(entry, `/emissions/context/tracking-matrix${query({ year, subsidiaryId: S2 })}`);
      expect(matrix.data.rows, `${year} S2 matrix`).toEqual([]);
    }
  });
});

describe('an export selector is bounded before it reaches an audit row or a label (19)', () => {
  it.each([
    ['/reports/context/csv', 'sub-1'],
    // A NUL used to pass the legacy bound and reach the audit row's jsonb only
    // after the whole artifact was built — a 500 (`security-rls` P3-1).
    ['/reports/csv', String.fromCharCode(0)],
    ['/reports/context/csv', String.fromCharCode(0)],
    ['/reports/excel', '<script>'],
    ['/reports/pdf', String.fromCharCode(0x202e)],
    ['/reports/context/csv', 'x'.repeat(4096)],
    ['/reports/context/pdf', `${'2'.repeat(8)}-2222-2222-2222-2222222222011`],
    ['/reports/csv', 'x'.repeat(37)],
    ['/reports/excel', 'x'.repeat(4096)],
    ['/reports/meta', 'x'.repeat(37)],
  ])('%s refuses a %#th malformed subsidiaryId with validation_failed and writes nothing', async (path, subsidiaryId) => {
    const before = await owner.auditLog.count({ where: { organisationId: t.organisationId } });
    const params = new URLSearchParams({ year: '2026', ...(path.endsWith('meta') ? {} : { template: 'executive_summary' }), subsidiaryId });
    const res = await get(t.users.consultant.id, `${path}?${params}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('validation_failed');
    expect(await owner.auditLog.count({ where: { organisationId: t.organisationId } })).toBe(before);
  });
});

describe('HEAD on every export, context and legacy (15)', () => {
  it.each([
    '/reports/context/pdf', '/reports/context/excel', '/reports/context/csv',
    '/reports/pdf', '/reports/excel', '/reports/csv',
  ])('HEAD %s answers 405 with Allow: GET and writes nothing', async (path) => {
    const before = await owner.auditLog.count({ where: { organisationId: t.organisationId } });
    const res = await get(t.users.consultant.id, `${path}?year=2026&template=executive_summary&subsidiaryId=${S1}`, 'HEAD');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect(await owner.auditLog.count({ where: { organisationId: t.organisationId } })).toBe(before);
  });
});
