/**
 * LP4-03 on the real database (README "Live reports"; Decisions 2026-10-24,
 * K2–K4): a live report is read in ONE REPEATABLE READ snapshot, so an
 * approval, a withdrawal, a new record and a rename committed while it is
 * being built cannot make its badge, counts, totals and ledger disagree — the
 * card's "simultaneous inventory changes cannot make a report contradict its
 * ledger". Its three formats reconcile; Scope 3 is disclosed, never summed; and
 * the year's boundary decides coverage, so a one-record year is never complete.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { ActivityRecordStatus } from '@tonyai/db';
import type { PutInventoryBoundarySubsidiaryRequest, ReportingMetaResponse } from '@tonyai/shared-types';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import type { RequestUser } from '../../src/auth/auth.types';
import { CaptureSnapshot } from '../../src/common/capture-snapshot';
import { PdfRenderer } from '../../src/common/pdf-renderer';
import { InventoryBoundariesService } from '../../src/inventory-boundary/inventory-boundaries.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { buildReportHtml } from '../../src/reports/report-html';
import { ReportsService } from '../../src/reports/reports.service';
import { apiTokenIssuer, connect, connectOwner, createRecord, createTenant, holdBefore, type Tenant } from './db';

const JWT_SECRET = randomBytes(32).toString('hex');
/** No other spec reports this year. */
const YEAR = 2074;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

let app: INestApplication;
let base: string;
let owner: PrismaService;
let runtime: PrismaService;
let t: Tenant;
let S: string;
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
  runtime = connect(2);
}, 60_000);

afterAll(async () => {
  await Promise.all([owner?.$disconnect(), runtime?.$disconnect()]);
  await app?.close();
});

beforeEach(async () => {
  t = await createTenant();
  S = t.subsidiaryId;
  L1 = (await owner.location.create({ data: { subsidiaryId: S, name: 'Int-test L1', geographyCode: 'UK' } })).id;
});

afterEach(async () => {
  await t?.cleanup();
});

const admin = () => t.users.superAdmin;
async function withAccess(user: RequestUser): Promise<RequestUser> {
  const subs = await owner.subsidiary.findMany({ where: { organisationId: t.organisationId }, select: { id: true } });
  return { ...user, accessibleSubsidiaryIds: subs.map((s) => s.id) };
}

const priced = (tCo2e: number) => ({ tCo2e, factorId: 'int-test-placeholder' });
const record = (periodValue: string, status: ActivityRecordStatus, tCo2e: number, over: Record<string, unknown> = {}) =>
  createRecord(owner, t, {
    locationId: L1, reportingYear: YEAR, periodValue, status, calculation: priced(tCo2e),
    ...(status === ActivityRecordStatus.voided ? { voidReason: 'Int-test withdrawal', voidedBy: admin().id, voidedAt: new Date() } : {}),
    ...over,
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
async function get(user: RequestUser, path: string): Promise<{ status: number; bytes: Buffer; text: string }> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${await tokenFor(user.id)}` } });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes, text: bytes.toString('utf8') };
}

/** S's whole declaration: L1's meter monthly, every other category excluded at the company. */
function declaration(): PutInventoryBoundarySubsidiaryRequest {
  const others = ['Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants'] as const;
  return {
    firstMonth: 1, lastMonth: 12,
    sites: [{ locationId: L1, firstMonth: 1, lastMonth: 12 }],
    attribution: [
      { category: 'Electricity', level: 'sites', reportingPeriod: 'monthly' },
      ...others.map((category) => ({ category, level: 'company' as const, reportingPeriod: 'annual' as const })),
    ],
    applicability: [
      { locationId: L1, category: 'Electricity', applicability: 'included' },
      ...others.map((category) => ({ locationId: null, category, applicability: 'excluded' as const, reason: 'Not operated' })),
    ],
    sources: [
      { locationId: L1, name: 'L1 main meter', mapping: { kind: 'mapped', category: 'Electricity', activityType: null }, applicability: 'included', evidenceReportingPeriod: null },
    ],
  };
}
async function openVersion(): Promise<string> {
  const service = new InventoryBoundariesService(runtime, new AuditService(runtime));
  const user = await withAccess(admin());
  const { id } = await service.create(user, { reportingYear: YEAR });
  await service.putSubsidiary(user, id, S, declaration());
  return id;
}

describe('one snapshot: inventory changes while a report is built (K2)', () => {
  it('holds the badge, counts, totals and ledger to one moment; the next report shows every change', async () => {
    const a = await record('January', ActivityRecordStatus.approved, 10);
    const b = await record('February', ActivityRecordStatus.approved, 20);
    const c = await record('March', ActivityRecordStatus.draft, 40);
    const user = await withAccess(admin());
    // Held after the counts (`groupBy`) and before the ledger: the names read
    // between them. Without one snapshot, the ledger read after the commits
    // below would hold C and D and lose B while the badge counted the old set.
    const hold = holdBefore(runtime, 'Subsidiary', 'findMany');
    const service = new ReportsService(hold.client, new AuditService(hold.client), new PdfRenderer());
    const pending = service.assemble(user, { template: 'ghg_protocol_detail', year: YEAR } as never);
    await hold.reached();
    await owner.activityRecord.update({ where: { id: c.id }, data: { status: ActivityRecordStatus.submitted } });
    await owner.activityRecord.update({
      where: { id: b.id }, data: { status: ActivityRecordStatus.voided, voidReason: 'Withdrawn mid-report', voidedBy: admin().id, voidedAt: new Date() },
    });
    const d = await record('April', ActivityRecordStatus.approved, 80);
    await owner.subsidiary.update({ where: { id: S }, data: { tradingName: 'Renamed mid-report' } });
    hold.release();
    const during = await pending;

    expect(during.records.map((r) => r.periodValue).sort()).toEqual(['February', 'January']);
    expect(during.withdrawn).toEqual([]);
    expect(during.summary.recordCount).toBe(2);
    expect(during.summary.totals.total).toBe(30);
    expect(during.summary.totals.total).toBe(during.records.reduce((s, r) => s + (r.tCo2e ?? 0), 0));
    // The badge and the ratio are the same moment's: one draft of three.
    expect(during.status).toBe('contains_incomplete_data');
    expect(during.incompleteRatio).toBeCloseTo(1 / 3, 12);
    expect(during.records.every((r) => r.subsidiaryName !== 'Renamed mid-report')).toBe(true);

    const after = await new ReportsService(runtime, new AuditService(runtime), new PdfRenderer()).assemble(user, { template: 'ghg_protocol_detail', year: YEAR } as never);
    expect(after.records.map((r) => r.periodValue).sort()).toEqual(['April', 'January', 'March']);
    expect(after.withdrawn.map((r) => r.periodValue)).toEqual(['February']);
    expect([a.id, b.id, c.id, d.id]).toHaveLength(4);
    expect(after.summary.totals.total).toBe(130);
    expect(after.status).toBe('draft');
    expect(after.records.every((r) => r.subsidiaryName === 'Renamed mid-report')).toBe(true);
  }, 30_000);

  it('holds the preview\'s counts and figures to one moment too', async () => {
    await record('January', ActivityRecordStatus.approved, 10);
    const user = await withAccess(admin());
    // Held at the first record read after the counts — the summary's rows.
    const hold = holdBefore(runtime, 'ActivityRecord', 'findMany');
    const service = new ReportsService(hold.client, new AuditService(hold.client), new PdfRenderer());
    const pending = service.meta(user, YEAR);
    await hold.reached();
    await record('February', ActivityRecordStatus.approved, 20);
    hold.release();
    const meta = await pending;
    expect(meta.committedCount).toBe(1);
    expect(meta.summary.recordCount).toBe(1);
    expect(meta.summary.totals.total).toBe(10);
  }, 30_000);
});

describe('a live report\'s snapshot cannot write (security-rls P3-2)', () => {
  it('is REPEATABLE READ and READ ONLY in the database, and refuses a write with 25006', async () => {
    const answer = await runtime.$transaction(async (tx) => {
      const snapshot = await CaptureSnapshot.openReadOnly(tx);
      const db = CaptureSnapshot.txOf(snapshot);
      const [row] = await db.$queryRaw<Array<{ readOnly: string; isolation: string }>>`
        SELECT pg_catalog.current_setting('transaction_read_only') AS "readOnly",
               pg_catalog.current_setting('transaction_isolation') AS isolation`;
      let refused: string | undefined;
      try {
        await db.$executeRaw`UPDATE subsidiaries SET trading_name = trading_name WHERE id = ${S}::uuid`;
      } catch (e) {
        refused = String((e as { meta?: { code?: string } }).meta?.code ?? (e as Error).message);
      }
      return { row, refused };
    }, { isolationLevel: 'RepeatableRead' });
    expect(answer.row).toEqual({ readOnly: 'on', isolation: 'repeatable read' });
    expect(answer.refused).toMatch(/25006|read-only transaction/);
  });
});

describe('one selection, three formats (K4)', () => {
  it('the PDF, the workbook and the CSV print the same Scope 1 + 2 total — and none counts Scope 3', async () => {
    await record('January', ActivityRecordStatus.approved, 12.5);
    await record('February', ActivityRecordStatus.locked, 7.25);
    await record('March', ActivityRecordStatus.voided, 100);
    await createRecord(owner, t, {
      reportingYear: YEAR, category: 'Water', scope: 3, periodValue: 'January', status: ActivityRecordStatus.approved, calculation: priced(999),
    });
    const viewer = t.users.consultant;
    const meta = JSON.parse((await get(viewer, `/reports/context/meta?year=${YEAR}`)).text) as ReportingMetaResponse;
    expect(meta.data.summary.totals).toEqual({ scope1: 0, scope2: 19.75, scope3: 0, total: 19.75 });
    expect(meta.data.scope3).toEqual({ coverage: 'not_covered', recordCount: 1, calculatedTCo2e: 999, uncalculatedRecordCount: 0 });
    expect(meta.data.committedCount).toBe(2);

    const csv = await get(viewer, `/reports/context/csv?year=${YEAR}&template=executive_summary`);
    expect(csv.status).toBe(200);
    const [header, ...lines] = csv.text.replace(String.fromCharCode(0xfeff), '').trimEnd().split('\n').map((l) => l.split(','));
    const at = (name: string) => header.indexOf(name);
    const counted = lines.filter((l) => l[at('status')] !== 'voided');
    expect(counted.reduce((s, l) => s + Number(l[at('tco2e')]), 0)).toBe(19.75);
    expect(lines.some((l) => l[at('category')] === 'Water')).toBe(false);

    const xlsx = await get(viewer, `/reports/context/excel?year=${YEAR}&template=executive_summary`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.bytes as unknown as ArrayBuffer);
    const summary: unknown[][] = [];
    wb.getWorksheet('Summary')!.eachRow((row) => summary.push((row.values as unknown[]).slice(1)));
    expect(summary).toContainEqual(['Scope 1 + 2 total (tCO₂e)', 19.75]);
    expect(summary.find((r) => r[0] === 'Scope 3')!.slice(0, 2)).toEqual(['Scope 3', 'Not covered']);

    const data = await new ReportsService(runtime, new AuditService(runtime), new PdfRenderer()).assemble(await withAccess(viewer), { template: 'executive_summary', year: YEAR } as never);
    expect(buildReportHtml(data)).toContain('<div class="l">Scope 1 + 2 total</div><div class="v">19.8 tCO₂e</div>');
  }, 30_000);
});

describe('coverage is the boundary\'s, never a count of what exists (K3)', () => {
  it('says no boundary is declared, and never calls the year complete', async () => {
    await record('January', ActivityRecordStatus.approved, 1);
    const meta = JSON.parse((await get(t.users.consultant, `/reports/context/meta?year=${YEAR}`)).text) as ReportingMetaResponse;
    // Reviewed is not covered: the one record is approved, the year unknown.
    expect(meta.data.status).toBe('approved');
    expect(meta.data.coverage).toEqual({ state: 'no_boundary' });
  });

  it('a one-record partial year is not complete; a full year is not either until the version is confirmed', async () => {
    const boundaryId = await openVersion();
    await record('January', ActivityRecordStatus.approved, 1);
    const one = JSON.parse((await get(t.users.consultant, `/reports/context/meta?year=${YEAR}`)).text) as ReportingMetaResponse;
    expect(one.data.status).toBe('approved');
    expect(one.data.coverage).toMatchObject({
      state: 'assessed', selection: 'inventory', boundary: { id: boundaryId, version: 1, decision: 'unconfirmed', frozen: false },
      obligationCount: 12, satisfiedObligationCount: 1, reading: 'gaps',
    });
    expect(one.data.coverage.state === 'assessed' && one.data.coverage.gapCounts.missing_record).toBe(11);

    for (const periodValue of MONTHS.slice(1)) await record(periodValue, ActivityRecordStatus.approved, 1);
    const full = JSON.parse((await get(t.users.consultant, `/reports/context/meta?year=${YEAR}`)).text) as ReportingMetaResponse;
    expect(full.data.coverage).toMatchObject({ state: 'assessed', satisfiedObligationCount: 12, reading: 'gaps', gapCounts: { boundary_unconfirmed: 1 } });

    // The PDF says it in words.
    const data = await new ReportsService(runtime, new AuditService(runtime), new PdfRenderer()).assemble(await withAccess(admin()), { template: 'executive_summary', year: YEAR } as never);
    const html = buildReportHtml(data);
    expect(html).toContain('Boundary version 1 (open, not confirmed): 12 of 12 included obligations satisfied');
    expect(html).toContain('Coverage gaps: Boundary not confirmed (1).');

    // Confirmed: complete — the one positive reading, and still not a certification.
    await new InventoryBoundariesService(runtime, new AuditService(runtime)).confirm(await withAccess(admin()), boundaryId);
    const confirmed = JSON.parse((await get(t.users.consultant, `/reports/context/meta?year=${YEAR}`)).text) as ReportingMetaResponse;
    expect(confirmed.data.coverage).toMatchObject({ state: 'assessed', reading: 'complete', gapCounts: {}, boundary: { decision: 'confirmed', frozen: true } });

    // A subsidiary the boundary leaves out counts in the live total, so it is a gap here (architect P1-1).
    const S2 = (await owner.subsidiary.create({
      data: { organisationId: t.organisationId, legalName: `Int-test outside ${randomUUID().slice(0, 8)}`, geographyCode: 'UK' },
    })).id;
    await createRecord(owner, t, { subsidiaryId: S2, reportingYear: YEAR, periodValue: 'January', status: ActivityRecordStatus.approved, calculation: priced(5) });
    const outside = JSON.parse((await get(t.users.consultant, `/reports/context/meta?year=${YEAR}`)).text) as ReportingMetaResponse;
    expect(outside.data.summary.totals.total).toBe(17);
    expect(outside.data.coverage).toMatchObject({ state: 'assessed', reading: 'gaps', gapCounts: { unmapped_record: 1 } });
    // Its extract: outside the boundary.
    const extract = JSON.parse((await get(t.users.consultant, `/reports/context/meta?year=${YEAR}&subsidiaryId=${S2}`)).text) as ReportingMetaResponse;
    expect(extract.data.coverage).toMatchObject({ state: 'assessed', selection: 'extract', reading: 'outside_boundary' });
    // Scope 3 reads no boundary at all.
    const scope3 = JSON.parse((await get(t.users.consultant, `/reports/context/meta?year=${YEAR}&scope=3`)).text) as ReportingMetaResponse;
    expect(scope3.data.coverage).toEqual({ state: 'not_covered' });
    const water = JSON.parse((await get(t.users.consultant, `/reports/context/meta?year=${YEAR}&category=Water`)).text) as ReportingMetaResponse;
    expect(water.data.coverage).toEqual({ state: 'not_covered' });
  }, 30_000);

  it('discloses nothing of a boundary that declares a subsidiary the caller is not granted', async () => {
    await openVersion();
    const S2 = (await owner.subsidiary.create({
      data: { organisationId: t.organisationId, legalName: `Int-test second ${randomUUID().slice(0, 8)}`, geographyCode: 'UK' },
    })).id;
    const boundaries = new InventoryBoundariesService(runtime, new AuditService(runtime));
    const [version] = await owner.inventoryBoundary.findMany({ where: { organisationId: t.organisationId, reportingYear: YEAR } });
    await boundaries.putSubsidiary(await withAccess(admin()), version.id, S2, {
      firstMonth: 1, lastMonth: 12, sites: [],
      attribution: (['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants'] as const).map((category) => ({ category, level: 'company' as const, reportingPeriod: 'annual' as const })),
      applicability: (['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants'] as const).map((category) => ({ locationId: null, category, applicability: 'excluded' as const, reason: 'Holding' })),
      sources: [],
    });
    // data_entry is granted S alone.
    const meta = JSON.parse((await get(t.users.dataEntry, `/reports/context/meta?year=${YEAR}`)).text) as ReportingMetaResponse;
    expect(meta.data.coverage).toEqual({ state: 'not_readable' });
    expect(JSON.stringify(meta)).not.toContain(version.id);
  }, 30_000);
});
