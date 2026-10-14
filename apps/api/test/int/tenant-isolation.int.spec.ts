import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ActivityRecordStatus } from '@tonyai/db';
import {
  BULK_UPLOAD_COLUMNS,
  isApiErrorCode,
  type ReportingIntensityData,
  type ReportingMatrixResponse,
  type ReportingMetaResponse,
  type ReportingSummaryResponse,
} from '@tonyai/shared-types';
import ExcelJS from 'exceljs';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeLimits } from '../../src/common/runtime-limits';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  attachEvidence,
  connectOwner,
  createRecord,
  createTenant,
  createTenantData,
  deferred,
  type Tenant,
  type TenantData,
} from './db';

/**
 * LP1-03 (F06): the externally reachable tenant paths, through the REAL API —
 * the Nest application with its global guard and validation pipe, on the
 * least-privileged runtime role — for two organisations and all four roles.
 *
 * The database half of tenant isolation (RLS) does NOT filter the API's
 * queries: the API reads as `tonyai_runtime`, which bypasses RLS by design.
 * So these routes are safe only if each service applies its tenant predicate,
 * and this file is what notices when one does not. For every route that takes
 * an id — in the path, the query or the body — each of A's roles sends B's id
 * and a random id, and must get the SAME answer for both (a refusal, never the
 * data and never a different answer that would reveal B's id exists), while B's
 * rows stay byte-for-byte unchanged. Each route also has a positive control —
 * A's own id succeeds, or at least answers differently — so a mistyped route
 * (Nest answers 404 to those too) cannot pass for a refusal. Every list and
 * aggregate, unfiltered, carries no trace of B for any of A's roles, and —
 * because a leak into a SUM carries no marker — every answer A gets must stay
 * the same while B's data changes underneath it. LP3-02's reporting-context
 * routes (#167, #168) take B's subsidiary as their selection, and must answer
 * it as they answer an unknown one — the echoed context aside, an empty answer,
 * the same compared headers and file name, and the same generation audit
 * contents (its generated id and time aside) but for the selection it records. Not covered here: the global `/factors` and
 * `/calculations/preview`, and Chromium — the PDF routes run with Puppeteer
 * replaced (below), so a real render's timeout, kill and recovery, an oversized
 * stream and a PDF's own metadata are not this file's proof (e2e renders for real).
 */

/**
 * A "PDF" is the HTML Puppeteer was handed, so what the document says is
 * searched and compared like any other answer. `hold` keeps a render in
 * flight (the report lease's test); `entered` hears that one reached the
 * printer. Everything around the printer — the data, the audit row, the lease,
 * the single-renderer guard — is the application's own; that guard is not
 * proven here on its own, the lease refusing a second render before it.
 */
const pdf = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }));
vi.mock('puppeteer', () => {
  const page = () => {
    let html = '';
    return {
      setContent: async (content: string) => {
        html = content;
      },
      createPDFStream: async () => {
        pdf.entered?.();
        await pdf.hold;
        const bytes = new TextEncoder().encode(`%PDF-int-test\n${html}`);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      },
      close: async () => undefined,
    };
  };
  return {
    TimeoutError: class TimeoutError extends Error {},
    default: {
      launch: async () => ({ connected: true, newPage: async () => page(), close: async () => undefined, process: () => null }),
    },
  };
});

const JWT_SECRET = randomBytes(32).toString('hex');
let app: INestApplication;
let base: string;
let owner: PrismaService;
let A: Tenant;
let B: Tenant;
let dataA: TenantData;
let dataB: TenantData;
/** Markers of B: no response to A may contain one. */
let markersB: string[];
/** B's 2026 revenue — the one denominator a group intensity reads (D14). */
let revenueBId: string;
/** A's subsidiary's name: a report that lists A's records names it. */
let subsidiaryNameA: string;
let limits: RuntimeLimits;

// Integers, so rounding cannot hide them; each is also searched for in the
// grouped forms a CSV or a Turkish locale would print.
const B_TCO2E = 987654;
const B_VOIDED_TCO2E = 864213;
const B_REVENUE = 24681357;
/**
 * Withdrawal times, fixed and ordered — B's first, then A's, then B's later
 * ones — so a time leaking across tenants shows whatever the clock says
 * (Codex P3: a withdrawal at `new Date()` outran B's later one after 2026-12-30).
 */
const VOIDED_AT = {
  firstB: new Date('2026-11-01T08:00:00Z'),
  A: new Date('2026-11-30T09:00:00Z'),
  laterB: new Date('2026-12-30T12:00:00Z'),
} as const;
const printed = (n: number) => [String(n), n.toLocaleString('en-GB'), n.toLocaleString('tr-TR')];
const ROLES = ['superAdmin', 'consultant', 'dataEntry', 'executiveViewer'] as const;
type Role = (typeof ROLES)[number];

beforeAll(async () => {
  // Before the application module loads: the app's Prisma client must log in
  // as the runtime role, tokens are signed with a secret only this file knows,
  // and no sweeper timer starts.
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
  // The deployed app's prefix, pipe and exception filter (LP3-01): the bodies
  // compared below are the ones a client receives, codes included. Its
  // request and refusal log lines are silenced — hundreds of expected 4xx.
  // One set of runtime limits for the HTTP layer and the guard, as `main.ts`
  // wires it: the export tests below hold its lease and spend its quota.
  const quiet = Object.assign(new JsonLogger(), { event: () => undefined });
  limits = app.get(RuntimeLimits);
  configureApp(app, quiet, { requestLogging: false, runtimeLimits: limits });
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/api/v1`.replace('[::1]', '127.0.0.1');
  const [{ user }] = await app.get(PrismaService).$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`;
  if (user !== 'tonyai_runtime') throw new Error(`the application under test connects as ${user}, not tonyai_runtime`);

  owner = connectOwner(2);
  B = await createTenant();
  // B's record keeps the placeholder figure, which K11 refuses as stale (409).
  // The matrix holds A's answer for B's id to an unknown id's (404) for
  // submit, approve and bulk submit; were the tenant check to slip, another
  // gate (author 403, status 400) or K11's 409 would answer instead and the
  // responses would differ.
  dataB = await createTenantData(owner, B);
  // B's site gets a name of its own (A's is "Int-test site" too), and B's
  // approved figure sits there: a number no response to A may contain.
  await owner.location.update({ where: { id: dataB.locationId }, data: { name: 'Int-test site only B has' } });
  const approvedB = await createRecord(owner, B, {
    status: ActivityRecordStatus.approved,
    periodValue: 'March',
    locationId: dataB.locationId,
    calculation: { tCo2e: B_TCO2E, factorId: 'int-test-placeholder' },
  });
  // What else of B a report section reads (#168): a withdrawn record for the
  // withdrawn ledger, an evidence file for the appendix, and the revenue a
  // group intensity divides by — each a marker, each controlled for A below.
  const voidedB = await createRecord(owner, B, {
    status: ActivityRecordStatus.voided,
    periodValue: 'November',
    calculation: { tCo2e: B_VOIDED_TCO2E, factorId: 'int-test-placeholder' },
    voidReason: 'Int-test withdrawal only B gave',
    voidedBy: B.users.superAdmin.id,
    voidedAt: VOIDED_AT.firstB,
  });
  const evidenceB = await owner.evidence.create({
    data: {
      subsidiaryId: B.subsidiaryId,
      storagePath: `${B.subsidiaryId}/${randomUUID()}-int-test-only-b.pdf`,
      fileName: 'int-test-only-b.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4,
      uploadedBy: B.users.dataEntry.id,
    },
  });
  await owner.activityRecordEvidence.create({
    data: { activityRecordId: approvedB.id, evidenceId: evidenceB.id, subsidiaryId: B.subsidiaryId, linkedBy: B.users.dataEntry.id },
  });
  ({ id: revenueBId } = await owner.subsidiaryDenominator.create({
    data: { subsidiaryId: B.subsidiaryId, year: 2026, metric: 'revenue', value: B_REVENUE, unit: 'EUR', createdBy: B.users.dataEntry.id },
  }));
  await owner.auditLog.create({
    data: {
      userId: B.users.superAdmin.id,
      organisationId: B.organisationId,
      role: 'super_admin',
      action: 'create',
      entity: 'activity_record',
      entityId: approvedB.id,
    },
  });
  const subB = await owner.subsidiary.findUniqueOrThrow({ where: { id: B.subsidiaryId } });
  const orgB = await owner.organisation.findUniqueOrThrow({ where: { id: B.organisationId } });
  const profilesB = await owner.profile.findMany({ where: { id: { in: B.profileIds } } });
  markersB = [
    B.organisationId,
    B.subsidiaryId,
    subB.legalName,
    orgB.legalName,
    ...profilesB.map((p) => p.fullName),
    approvedB.id,
    voidedB.id,
    ...[B_TCO2E, B_VOIDED_TCO2E, B_REVENUE].flatMap(printed),
    'Int-test site only B has',
    'Int-test withdrawal only B gave',
    'int-test-only-b.pdf',
    evidenceB.id,
    revenueBId,
    ...Object.values(dataB),
    ...B.profileIds,
    ...Object.values(B.users).map((u) => u.email),
  ];
}, 60_000);

afterAll(async () => {
  await B?.cleanup();
  await owner?.$disconnect();
  await app?.close();
});

beforeEach(async () => {
  A = await createTenant();
  // Priced: A's own record is the positive control's, and the API recomputes
  // it at submit (K11).
  dataA = await createTenantData(owner, A, { priced: true });
  ({ legalName: subsidiaryNameA } = await owner.subsidiary.findUniqueOrThrow({ where: { id: A.subsidiaryId } }));
});

afterEach(async () => {
  await A.cleanup();
});

async function tokenFor(userId: string): Promise<string> {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience('authenticated')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

interface Res {
  status: number;
  /** The body; a PDF's or a workbook's with its generation minute masked where it was extracted. */
  text: string;
  /** An export's `Content-Disposition` — its file name carries the selection. */
  disposition: string | null;
  /** The compared headers (all but `VOLATILE_HEADERS`), sorted — compared like the body. */
  headers: string;
  /**
   * The `ETag`: a hash of the bytes sent, so it differs wherever the bodies do
   * — between B's answer and an unknown one (each echoes its own id), and for
   * a generated PDF or workbook (its minute, its zip). Compared where the body
   * is stable, a JSON or CSV answer to the same request (`answers` below);
   * elsewhere it adds nothing the body does not show (Codex P3).
   */
  etag: string | null;
  /** A generated PDF or workbook — bytes that differ between two identical requests. */
  generated: boolean;
}

/**
 * Headers left out of `Res.headers`: the transport's (`date`, `keep-alive`,
 * `connection`, `x-request-id`) and the ETag (above). A workbook's
 * `content-length` is left out too — its zip moves with the time it was built
 * (`qa-auditor` P3-2).
 */
const VOLATILE_HEADERS = new Set(['date', 'etag', 'x-request-id', 'keep-alive', 'connection']);

async function call(role: Role, method: string, path: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${await tokenFor(A.users[role].id)}` };
  let payload: FormData | string | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const disposition = res.headers.get('content-disposition');
  const etag = res.headers.get('etag');
  const type = res.headers.get('content-type') ?? '';
  const workbook = type.includes('spreadsheetml');
  const generated = workbook || type.includes('application/pdf');
  const kept = JSON.stringify(
    [...res.headers]
      .filter(([name]) => !VOLATILE_HEADERS.has(name) && !(workbook && name === 'content-length'))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const answer = { status: res.status, disposition, headers: kept, etag, generated };
  if (method !== 'HEAD' && workbook) {
    // A workbook is a zip stamped with the time it was built: compare and
    // search what its cells say instead (`qa-auditor`).
    return { ...answer, text: await workbookText(Buffer.from(await res.arrayBuffer())) };
  }
  const text = await res.text();
  return { ...answer, text: type.includes('application/pdf') ? withoutPdfGenerationTime(text) : text };
}

/** A report's generation minute as its writers print it (`ReportsService.assemble`'s `generatedAt`). */
const GENERATION_MINUTE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

/**
 * The PDF's generation line — `Generated <minute><br/>Generated by <email>`,
 * the template's own markup: what a user wrote reaches the PDF escaped, so
 * data cannot spell its `<br/>`. Masked once, nowhere else; CSV and JSON are
 * never masked, and every other time is business data (Codex P3).
 */
const withoutPdfGenerationTime = (html: string) =>
  html.replace(/Generated \d{4}-\d{2}-\d{2} \d{2}:\d{2}<br\/>Generated by /, 'Generated <time><br/>Generated by ');

async function workbookText(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  // Besides the cells, what else a workbook can say — its properties (not
  // its build times), defined names, each sheet's header and footer, cell
  // notes (`security-rls` P3-2): the writer's output, not every part of its zip.
  const { creator, lastModifiedBy, title, subject, keywords, category, description, company, manager } = workbook;
  const lines = [JSON.stringify({ creator, lastModifiedBy, title, subject, keywords, category, description, company, manager }), JSON.stringify(workbook.definedNames.model)];
  let generation = false;
  workbook.eachSheet((sheet) => {
    lines.push(`# ${sheet.name}`, JSON.stringify(sheet.headerFooter));
    sheet.eachRow((row) => {
      const values = row.values as unknown[];
      // The Summary sheet's generation row, ["Generated", <minute>, <email>],
      // masked there and once — a business cell elsewhere stays as written (Codex P3).
      if (!generation && sheet.name === 'Summary' && values[1] === 'Generated' && typeof values[2] === 'string' && GENERATION_MINUTE.test(values[2])) {
        generation = true;
        lines.push(JSON.stringify([...values.slice(0, 2), '<time>', ...values.slice(3)]));
      } else lines.push(JSON.stringify(values));
      row.eachCell((cell) => {
        if (cell.note) lines.push(JSON.stringify(cell.note));
      });
    });
  });
  return lines.join('\n');
}

/** Every row of B, as the owner sees it — compared before and after each attack. */
async function snapshotB(): Promise<string> {
  const where = { subsidiaryId: B.subsidiaryId };
  const rows = await Promise.all([
    owner.subsidiary.findMany({ where: { organisationId: B.organisationId } }),
    owner.activityRecord.findMany({ where, orderBy: { id: 'asc' } }),
    owner.evidence.findMany({ where, orderBy: { id: 'asc' } }),
    owner.activityRecordEvidence.findMany({ where, orderBy: { evidenceId: 'asc' } }),
    owner.location.findMany({ where }),
    owner.target.findMany({ where }),
    owner.subsidiaryDenominator.findMany({ where }),
    owner.periodLock.findMany({ where }),
    owner.importBatch.findMany({ where: { organisationId: B.organisationId } }),
    owner.userSubsidiaryAccess.findMany({ where: { organisationId: B.organisationId } }),
    owner.profile.findMany({ where: { organisationId: B.organisationId }, orderBy: { id: 'asc' } }),
    owner.auditLog.count({ where: { organisationId: B.organisationId } }),
    owner.storageIntent.count({ where: { OR: [{ subsidiaryId: B.subsidiaryId }, { organisationId: B.organisationId }] } }),
  ]);
  return JSON.stringify(rows);
}

/** A response with every id of `ids` replaced, so B's answer and a random id's answer compare as text. */
type Ids = TenantData & { subsidiaryId: string; organisationId: string };

const normalise = (res: Res, ids: Ids) => {
  const swap = (text: string) => Object.values(ids).reduce((t, id) => t.split(id).join('<id>'), text);
  // An export's file name carries the first 8 characters of the selected subsidiary's id.
  const headers = Object.values(ids).reduce((t, id) => t.split(id.slice(0, 8)).join('<id>'), swap(res.headers));
  return `${res.status} ${headers} ${swap(res.text)}`;
};

interface Route {
  name: string;
  method: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE';
  path: (ids: Ids) => string;
  body?: (ids: Ids) => unknown;
  /** The role and the state A needs for the positive control; returns the ids it should use. */
  own: { role: Role; prepare?: () => Promise<Partial<Ids>>; ok?: (res: Res, foreign: Res) => boolean };
}

const pdfForm = (recordIds?: string[]) => {
  const form = new FormData();
  // Empty on purpose: the positive control must not upload bytes anywhere.
  form.append('file', new Blob([new Uint8Array(0)], { type: 'application/pdf' }), 'int-test.pdf');
  if (recordIds) form.append('recordIds', JSON.stringify(recordIds));
  return form;
};

const recordIn = (status: ActivityRecordStatus, extra: Record<string, unknown> = {}) => async () => {
  const record = await createRecord(owner, A, { status, periodValue: 'June', ...extra }, { priced: true });
  await attachEvidence(owner, A, [record.id]);
  return { recordId: record.id };
};

/** A's withdrawn 2026 Electricity record: the withdrawn ledger's and `voidedCount`'s side of a widened selection (`qa-auditor` P2-2). */
const voidedIn = () =>
  createRecord(owner, A, {
    status: ActivityRecordStatus.voided,
    periodValue: 'November',
    voidReason: 'Int-test withdrawal A gave',
    voidedBy: A.users.superAdmin.id,
    voidedAt: VOIDED_AT.A,
  }, { priced: true });

const created = (res: Res) => res.status === 200 || res.status === 201;
const differs = (res: Res, foreign: Res) => res.status !== foreign.status || res.text !== foreign.text;

/**
 * LP3-02's reporting-context reads (#167, #168): `{ context, data }`, a
 * required year, the subsidiary as the selection. `live` is the positive
 * control's reading of A's own data (an approved record of `recordIn`, A's
 * 2026 headcount); `empty` is what an inaccessible selection must answer.
 */
interface ContextRead {
  path: string;
  live: (data: unknown) => boolean;
  empty: (data: unknown) => boolean;
}
const contextRead = <T,>(path: string, live: (data: T) => boolean, empty: (data: T) => boolean): ContextRead => ({
  path,
  live: (data) => live(data as T),
  empty: (data) => empty(data as T),
});
const zero = (counts: object) => Object.values(counts).every((n) => n === 0);
// `empty`: every inventory figure and count zero and every collection that
// carries data empty — not merely the count the route leads with (Codex P2).
// The routes' own metadata (a summary's `statusesIncluded`, a matrix's
// `reportingYear`, meta's `organisationName`, `recordLimit` and `status`) is
// left as it is, and no key set is frozen.
const CONTEXT_READS: ContextRead[] = [
  contextRead<ReportingSummaryResponse['data']>(
    '/emissions/context/summary',
    (d) => d.recordCount > 0,
    (d) => zero(d.totals) && d.byCategory.length === 0 && d.bySubsidiary.length === 0
      && Object.values(d.trend).every((points) => points.length === 0)
      && zero({ recordCount: d.recordCount, calculatedRecordCount: d.calculatedRecordCount, uncalculatedRecordCount: d.uncalculatedRecordCount }),
  ),
  contextRead<ReportingMatrixResponse['data']>(
    '/emissions/context/tracking-matrix',
    (d) => d.rows.length === 1 && d.rows[0].subsidiaryId === A.subsidiaryId && d.rows[0].totalTCo2e > 0,
    (d) => d.rows.length === 0 && zero(d.totals),
  ),
  contextRead<ReportingIntensityData>(
    '/intensity/context',
    (d) => d.selectedSubsidiaryIds.length === 1 && d.selectedSubsidiaryIds[0] === A.subsidiaryId
      && d.metrics.some((m) => m.contributingSubsidiaryIds.includes(A.subsidiaryId)),
    (d) => d.selectedSubsidiaryIds.length === 0 && d.metrics.length === 0,
  ),
  contextRead<ReportingMetaResponse['data']>(
    '/reports/context/meta',
    (d) => d.committedCount > 0,
    (d) => zero({
      totalCount: d.totalCount,
      committedCount: d.committedCount,
      incompleteCount: d.incompleteCount,
      pendingCount: d.pendingCount,
      voidedCount: d.voidedCount,
      incompleteRatio: d.incompleteRatio,
    }),
  ),
];
/** The context exports, each with the options that put the most of the report on the page. */
const CONTEXT_EXPORTS = [
  ['/reports/context/pdf', '&template=ghg_protocol_detail&includeEvidenceSummary=true'],
  ['/reports/context/excel', '&template=ghg_protocol_detail'],
  ['/reports/context/csv', '&template=executive_summary'],
] as const;
/** Unfiltered, and narrowed by the scope, the category or both of B's figure and of `recordIn`'s record (`qa-auditor` P3-1). */
const CONTEXT_FILTERS = ['', '&scope=2', '&category=Electricity', '&scope=2&category=Electricity'] as const;
/** The context fields a filter sets, as the API echoes and audits them. */
const filterContext = (filter: string): { scope?: number; category?: string } => ({
  ...(filter.includes('scope=2') ? { scope: 2 } : {}),
  ...(filter.includes('category=Electricity') ? { category: 'Electricity' } : {}),
});
const dataOf = (res: Res): unknown => (JSON.parse(res.text) as { data?: unknown }).data;

const ID_ROUTES: Route[] = [
  // subsidiaries
  { name: 'GET /subsidiaries/:id', method: 'GET', path: (i) => `/subsidiaries/${i.subsidiaryId}`, own: { role: 'dataEntry' } },
  { name: 'GET /subsidiaries/:id/summary', method: 'GET', path: (i) => `/subsidiaries/${i.subsidiaryId}/summary`, own: { role: 'consultant' } },
  { name: 'PATCH /subsidiaries/:id', method: 'PATCH', path: (i) => `/subsidiaries/${i.subsidiaryId}`, body: () => ({ tradingName: 'renamed' }), own: { role: 'superAdmin' } },
  { name: 'DELETE /subsidiaries/:id', method: 'DELETE', path: (i) => `/subsidiaries/${i.subsidiaryId}`, own: { role: 'superAdmin', ok: differs } },
  // locations
  { name: 'GET /locations/:id', method: 'GET', path: (i) => `/locations/${i.locationId}`, own: { role: 'executiveViewer' } },
  { name: 'PATCH /locations/:id', method: 'PATCH', path: (i) => `/locations/${i.locationId}`, body: () => ({ name: 'renamed' }), own: { role: 'superAdmin' } },
  { name: 'DELETE /locations/:id', method: 'DELETE', path: (i) => `/locations/${i.locationId}`, own: { role: 'superAdmin' } },
  { name: 'POST /locations', method: 'POST', path: () => '/locations', body: (i) => ({ subsidiaryId: i.subsidiaryId, name: 'New site', geographyCode: 'UK' }), own: { role: 'superAdmin', ok: created } },
  // activity records
  { name: 'GET /activity-records/:id', method: 'GET', path: (i) => `/activity-records/${i.recordId}`, own: { role: 'consultant' } },
  { name: 'PATCH /activity-records/:id', method: 'PATCH', path: (i) => `/activity-records/${i.recordId}`, body: () => ({ activityValue: 7 }), own: { role: 'dataEntry' } },
  { name: 'DELETE /activity-records/:id', method: 'DELETE', path: (i) => `/activity-records/${i.recordId}`, own: { role: 'dataEntry' } },
  // Into the period B has LOCKED (createTenantData): a create that looked at the
  // period before the tenant would answer 409 for B's id and 404 for a random one.
  { name: 'POST /activity-records', method: 'POST', path: () => '/activity-records', body: (i) => ({ subsidiaryId: i.subsidiaryId, reportingYear: 2019, reportingPeriod: 'monthly', periodValue: 'January', category: 'Electricity', activityValue: 10, activityUnit: 'kWh' }), own: { role: 'dataEntry', ok: differs } },
  // B's LOCATION inside a record of A's own subsidiary (`qa-auditor`).
  { name: 'POST /activity-records (B location)', method: 'POST', path: () => '/activity-records', body: (i) => ({ subsidiaryId: A.subsidiaryId, locationId: i.locationId, reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'August', category: 'Electricity', activityValue: 10, activityUnit: 'kWh' }), own: { role: 'dataEntry', ok: differs } },
  { name: 'PATCH /activity-records/:id (B location)', method: 'PATCH', path: () => `/activity-records/${dataA.recordId}`, body: (i) => ({ locationId: i.locationId }), own: { role: 'dataEntry' } },
  { name: 'POST /activity-records/:id/submit', method: 'POST', path: (i) => `/activity-records/${i.recordId}/submit`, own: { role: 'dataEntry', ok: created } },
  { name: 'POST /activity-records/:id/review', method: 'POST', path: (i) => `/activity-records/${i.recordId}/review`, own: { role: 'consultant', prepare: recordIn(ActivityRecordStatus.submitted), ok: created } },
  { name: 'POST /activity-records/:id/approve', method: 'POST', path: (i) => `/activity-records/${i.recordId}/approve`, own: { role: 'superAdmin', prepare: recordIn(ActivityRecordStatus.submitted), ok: created } },
  { name: 'POST /activity-records/:id/reject', method: 'POST', path: (i) => `/activity-records/${i.recordId}/reject`, body: () => ({ varianceReason: 'please recheck the meter reading' }), own: { role: 'consultant', prepare: recordIn(ActivityRecordStatus.submitted), ok: created } },
  { name: 'POST /activity-records/:id/void', method: 'POST', path: (i) => `/activity-records/${i.recordId}/void`, body: () => ({ voidReason: 'entered against the wrong site' }), own: { role: 'superAdmin', prepare: recordIn(ActivityRecordStatus.approved), ok: created } },
  { name: 'POST /activity-records/bulk-submit', method: 'POST', path: () => '/activity-records/bulk-submit', body: (i) => ({ recordIds: [i.recordId] }), own: { role: 'dataEntry', ok: differs } },
  // evidence
  { name: 'GET /activity-records/:recordId/evidence', method: 'GET', path: (i) => `/activity-records/${i.recordId}/evidence`, own: { role: 'executiveViewer' } },
  { name: 'POST /activity-records/:recordId/evidence', method: 'POST', path: (i) => `/activity-records/${i.recordId}/evidence`, body: () => pdfForm(), own: { role: 'dataEntry', ok: differs } },
  { name: 'POST /evidence', method: 'POST', path: () => '/evidence', body: (i) => pdfForm([i.recordId]), own: { role: 'dataEntry', ok: differs } },
  { name: 'DELETE /activity-records/:recordId/evidence/:evidenceId', method: 'DELETE', path: (i) => `/activity-records/${i.recordId}/evidence/${i.evidenceId}`, own: { role: 'dataEntry', ok: differs } },
  { name: 'GET /evidence/:id/url', method: 'GET', path: (i) => `/evidence/${i.evidenceId}/url`, own: { role: 'consultant', ok: differs } },
  { name: 'DELETE /evidence/:id', method: 'DELETE', path: (i) => `/evidence/${i.evidenceId}`, own: { role: 'dataEntry', ok: differs } },
  // period locks
  { name: 'DELETE /period-locks/:id', method: 'DELETE', path: (i) => `/period-locks/${i.periodLockId}`, own: { role: 'superAdmin' } },
  { name: 'POST /period-locks', method: 'POST', path: () => '/period-locks', body: (i) => ({ subsidiaryId: i.subsidiaryId, reportingYear: 2018, reportingPeriod: 'monthly', periodValue: 'January' }), own: { role: 'superAdmin', ok: created } },
  // targets
  { name: 'PATCH /targets/:id', method: 'PATCH', path: (i) => `/targets/${i.targetId}`, body: () => ({ name: 'renamed' }), own: { role: 'superAdmin' } },
  { name: 'DELETE /targets/:id', method: 'DELETE', path: (i) => `/targets/${i.targetId}`, own: { role: 'superAdmin' } },
  { name: 'POST /targets', method: 'POST', path: () => '/targets', body: (i) => ({ subsidiaryId: i.subsidiaryId, name: 'New target', basis: 'internal_annual', scope: 'all', baselineYear: 2024, baselineTCo2e: 10, targetYear: 2030, targetTCo2e: 5 }), own: { role: 'superAdmin', ok: created } },
  // denominators
  { name: 'PATCH /denominators/:id', method: 'PATCH', path: (i) => `/denominators/${i.denominatorId}`, body: () => ({ value: 11 }), own: { role: 'superAdmin' } },
  { name: 'DELETE /denominators/:id', method: 'DELETE', path: (i) => `/denominators/${i.denominatorId}`, own: { role: 'superAdmin' } },
  { name: 'POST /denominators', method: 'POST', path: () => '/denominators', body: (i) => ({ subsidiaryId: i.subsidiaryId, year: 2025, metric: 'headcount', value: 3, unit: 'FTE' }), own: { role: 'superAdmin', ok: created } },
  // import batches
  { name: 'GET /import-batches/:id', method: 'GET', path: (i) => `/import-batches/${i.importBatchId}`, own: { role: 'dataEntry' } },
  { name: 'GET /import-batches/:id/source-url', method: 'GET', path: (i) => `/import-batches/${i.importBatchId}/source-url`, own: { role: 'dataEntry', ok: differs } },
  { name: 'POST /import-batches/:id/submit', method: 'POST', path: (i) => `/import-batches/${i.importBatchId}/submit`, own: { role: 'dataEntry', ok: differs } },
  // filters by subsidiary
  ...(
    [
      ['/activity-records', ''],
      ['/locations', ''],
      ['/targets', ''],
      ['/targets/progress', ''],
      ['/denominators', ''],
      ['/period-locks', ''],
      ['/intensity', '&year=2026'],
      ['/emissions/summary', '&year=2026'],
      ['/emissions/tracking-matrix', '&year=2026'],
      ['/emissions/completeness', '&year=2026'],
      ['/reports/meta', '&year=2026'],
      ['/reports/csv', '&year=2026&template=executive_summary'],
      ['/reports/excel', '&year=2026&template=executive_summary'],
      ['/reports/pdf', '&year=2026&template=ghg_protocol_detail&includeEvidenceSummary=true'],
    ] as const
  ).map(
    ([path, rest]): Route => ({
      name: `GET ${path}?subsidiaryId=`,
      method: 'GET',
      path: (i) => `${path}?subsidiaryId=${i.subsidiaryId}${rest}`,
      own: { role: 'consultant', ok: (res) => res.status === 200 },
    }),
  ),
  // the reporting context (LP3-02): B's subsidiary as the selection
  ...CONTEXT_FILTERS.flatMap((filter): Route[] => [
    ...CONTEXT_READS.map(({ path, live }): Route => ({
      name: `GET ${path}?subsidiaryId=${filter}`,
      method: 'GET',
      path: (i) => `${path}?year=2026&subsidiaryId=${i.subsidiaryId}${filter}`,
      own: { role: 'consultant', prepare: recordIn(ActivityRecordStatus.approved), ok: (res) => res.status === 200 && live(dataOf(res)) },
    })),
    // HEAD too: Express answers it with the GET handler, which generates the
    // file and audits it — today's behaviour, characterised ("LP3-02
    // context-route follow-ups" (15)): when (15) lands, HEAD's rows part from
    // GET's generation assertions and keep its equivalence, RBAC and admission.
    ...CONTEXT_EXPORTS.flatMap(([path, rest]) =>
      (['GET', 'HEAD'] as const).map((method): Route => ({
        name: `${method} ${path}?subsidiaryId=${filter}`,
        method,
        path: (i) => `${path}?year=2026&subsidiaryId=${i.subsidiaryId}${filter}${rest}`,
        // A's own selection is named — in the label, and in the ledger where the
        // template has one (the route is live; the export block below counts the
        // records) — which no export for B's selection may print: it names an
        // unresolved selection by its id.
        own: {
          role: 'consultant',
          prepare: recordIn(ActivityRecordStatus.approved),
          ok: (res) => res.status === 200 && (method === 'HEAD' || res.text.includes(subsidiaryNameA)),
        },
      })),
    ),
  ]),
];

describe("B's ids, through the API, as each of A's roles: the same refusal as an id that does not exist", () => {
  it.each(ID_ROUTES.map((r) => [r.name, r] as const))('%s', async (_name, route) => {
    const foreignIds: Ids = { ...dataB, subsidiaryId: B.subsidiaryId, organisationId: B.organisationId };
    const missingIds: Ids = Object.fromEntries(Object.keys(foreignIds).map((k) => [k, randomUUID()])) as unknown as Ids;
    const before = await snapshotB();

    for (const role of ROLES) {
      const foreign = await call(role, route.method, route.path(foreignIds), route.body?.(foreignIds));
      const missing = await call(role, route.method, route.path(missingIds), route.body?.(missingIds));
      const context = `${role} ${route.name}: B's id → ${foreign.status} ${foreign.text.slice(0, 200)}`;
      expect(foreign.status, context).toBeLessThan(500);
      expect(normalise(foreign, foreignIds), context).toBe(normalise(missing, missingIds));
      // Every refusal carries a registered code (LP3-01), and a 404's names a
      // kind of thing — the same for B's id as for none, by the line above.
      // (A HEAD refusal has no body to carry one.)
      if (foreign.status >= 400 && route.method !== 'HEAD') {
        const { code } = JSON.parse(foreign.text) as { code?: unknown };
        expect(isApiErrorCode(code), `${context} — code ${String(code)}`).toBe(true);
        if (foreign.status === 404) expect(code, context).toMatch(/(^|_)not_found$/);
      }
      // An id the caller sent may come back (a per-record refusal names it);
      // anything else of B's may not.
      const sent = new Set(Object.values(foreignIds));
      for (const marker of markersB.filter((m) => !sent.has(m))) {
        expect(`${foreign.headers} ${foreign.text}`, `${context} — leaks ${marker}`).not.toContain(marker);
      }
    }
    expect(await snapshotB(), `${route.name} changed B's data`).toBe(before);

    // Positive control: A's own id, as a role allowed to use the route.
    const ownIds: Ids = { ...dataA, subsidiaryId: A.subsidiaryId, organisationId: A.organisationId, ...(await route.own.prepare?.()) };
    const own = await call(route.own.role, route.method, route.path(ownIds), route.body?.(ownIds));
    const foreign = await call(route.own.role, route.method, route.path(foreignIds), route.body?.(foreignIds));
    const ok = route.own.ok ?? ((res: Res) => res.status === 200);
    expect(ok(own, foreign), `${route.name} positive control: ${own.status} ${own.text.slice(0, 300)}`).toBe(true);
    // A's own answer carries nothing of B either (`security-rls` P3-3).
    for (const marker of markersB) expect(`${own.headers} ${own.text}`, `${route.name} positive control leaks ${marker}`).not.toContain(marker);
  });
});

const LIST_ROUTES = [
  '/me',
  '/subsidiaries',
  '/activity-records',
  '/locations',
  '/targets',
  '/targets/progress',
  '/denominators',
  '/period-locks',
  '/import-batches',
  '/audit',
  '/kpi',
  '/intensity?year=2026',
  '/emissions/summary?year=2026',
  '/emissions/tracking-matrix?year=2026',
  '/reports/meta?year=2026',
  '/reports/csv?year=2026&template=executive_summary',
  '/reports/excel?year=2026&template=executive_summary',
  '/reports/pdf?year=2026&template=ghg_protocol_detail&includeEvidenceSummary=true',
  ...CONTEXT_FILTERS.flatMap((filter) => [
    ...CONTEXT_READS.map(({ path }) => `${path}?year=2026${filter}`),
    ...CONTEXT_EXPORTS.map(([path, rest]) => `${path}?year=2026${filter}${rest}`),
  ]),
  '/bulk-upload/template',
];

describe("every list and aggregate, unfiltered, as each of A's roles: no trace of B", () => {
  it.each(LIST_ROUTES)('GET %s', async (path) => {
    let answered = 0;
    for (const role of ROLES) {
      const res = await call(role, 'GET', path);
      expect(res.status, `${role} GET ${path}: ${res.text.slice(0, 200)}`).toBeLessThan(500);
      if (res.status === 200) answered += 1;
      for (const marker of markersB) expect(`${res.headers} ${res.text}`, `${role} GET ${path} leaks ${marker}`).not.toContain(marker);
    }
    // At least one of A's roles reads it, so the check above saw real output.
    expect(answered, `GET ${path}: no role of A got an answer`).toBeGreaterThan(0);
  });

  it("a list shows A's own rows to A (control: the lists above were not empty for everyone)", async () => {
    const res = await call('consultant', 'GET', '/activity-records');
    expect(res.text).toContain(dataA.recordId);
  });

  it("counts carry no trace of B either: A's dashboard counts exactly A's subsidiary and site", async () => {
    for (const role of ROLES) {
      const res = await call(role, 'GET', '/kpi');
      expect(res.status, `${role} GET /kpi`).toBe(200);
      expect(JSON.parse(res.text), `${role} GET /kpi`).toMatchObject({ totalSubsidiaries: 1, totalLocations: 1 });
    }
  });

  it("the report sections B's markers sit in are printed for A's own data (control: those checks above can fail)", async () => {
    // At A's site, backed by A's "int-test.pdf".
    await recordIn(ActivityRecordStatus.approved, { locationId: dataA.locationId })();
    await voidedIn();
    await owner.subsidiaryDenominator.create({
      data: { subsidiaryId: A.subsidiaryId, year: 2026, metric: 'revenue', value: 500000, unit: 'EUR', createdBy: A.users.dataEntry.id },
    });
    // Business text shaped like the generation metadata, which no mask may
    // touch (Codex P3): a withdrawal's reason written as the PDF's generation
    // line, and a ledger row reading "Generated", <minute> — a subsidiary of
    // that name with a site named as a minute.
    const lookalike = 'Generated 2026-12-30 12:00<br/>Generated by a reason';
    await createRecord(owner, A, {
      status: ActivityRecordStatus.voided,
      periodValue: 'October',
      voidReason: lookalike,
      voidedBy: A.users.superAdmin.id,
      voidedAt: VOIDED_AT.A,
    }, { priced: true });
    const named = await owner.subsidiary.create({ data: { organisationId: A.organisationId, legalName: 'Generated', geographyCode: 'UK' } });
    const minuteSite = await owner.location.create({ data: { subsidiaryId: named.id, name: '2026-12-30 12:00', geographyCode: 'UK' } });
    await createRecord(owner, A, { subsidiaryId: named.id, locationId: minuteSite.id, status: ActivityRecordStatus.approved, periodValue: 'March' }, { priced: true });
    for (const [path, rest] of CONTEXT_EXPORTS) {
      const res = await call('consultant', 'GET', `${path}?year=2026${rest}`);
      expect(res.status, `${path}: ${res.text.slice(0, 200)}`).toBe(200);
      expect(res.text, `${path}: the withdrawn ledger`).toContain('Int-test withdrawal A gave');
      expect(res.text, `${path}: the ledger`).toContain(subsidiaryNameA);
      expect(res.text, `${path}: the reporting entity`).toContain('Int-test site');
      // The PDF alone names evidence files (the workbook and the CSV count them).
      if (path.endsWith('pdf')) expect(res.text, `${path}: the evidence appendix`).toContain('int-test.pdf');
      // The generation minute is found and masked — a changed format fails here,
      // not as a rare flake at a minute's turn — and nothing else is: a
      // withdrawal's time, and text shaped like the generation metadata, stay.
      if (path.endsWith('pdf')) {
        expect(res.text, `${path}: the generation line`).toContain('Generated <time><br/>Generated by ');
        expect(res.text, `${path}: a reason shaped like it`).toContain('Generated 2026-12-30 12:00&lt;br');
      } else if (path.endsWith('excel')) {
        expect(res.text, `${path}: the Summary's generation row`).toContain('[null,"Generated","<time>",');
        expect(res.text, `${path}: a reason shaped like it`).toContain(JSON.stringify(lookalike));
        expect(res.text, `${path}: a ledger row shaped like it`).toContain('[null,"Generated","2026-12-30 12:00",');
      } else {
        expect(res.text, `${path}: a reason shaped like it`).toContain(lookalike);
        expect(res.text, `${path}: a ledger row shaped like it`).toContain('Generated,2026-12-30 12:00,');
      }
      expect(res.text, `${path}: a withdrawal's time is business data`).toContain('2026-11-30 09:00');
      for (const marker of markersB) expect(res.text, `${path} leaks ${marker}`).not.toContain(marker);
    }
    // A group intensity reads revenue alone (D14): A's, and only A's.
    const intensity = JSON.parse((await call('consultant', 'GET', '/intensity/context?year=2026')).text) as { data: ReportingIntensityData };
    expect(intensity.data.metrics).toEqual([
      expect.objectContaining({ metric: 'revenue', denominatorTotal: 500000, contributingSubsidiaryIds: [A.subsidiaryId] }),
    ]);
  });

  it("a B record pointing at A's import batch (malformed) is not listed in A's batch", async () => {
    const stray = await createRecord(owner, B, { periodValue: 'May', importBatchId: dataA.importBatchId });
    try {
      for (const role of ROLES) {
        const res = await call(role, 'GET', `/import-batches/${dataA.importBatchId}`);
        expect(res.status, `${role}: ${res.text.slice(0, 200)}`).toBeLessThan(500);
        expect(res.text, role).not.toContain(stray.id);
      }
      // Control: A's batch is readable, and lists its own record when one points at it.
      const own = await createRecord(owner, A, { periodValue: 'May', importBatchId: dataA.importBatchId });
      expect((await call('consultant', 'GET', `/import-batches/${dataA.importBatchId}`)).text).toContain(own.id);
    } finally {
      await owner.activityRecord.delete({ where: { id: stray.id } });
    }
  });
});

describe('POST /bulk-upload/activity-records (dry run): rows naming B are refused exactly as rows naming nothing', () => {
  it('a row with B\'s subsidiary, and a row with B\'s location under A\'s subsidiary', async () => {
    const csv = (subsidiaryId: string, locationId: string) =>
      [
        BULK_UPLOAD_COLUMNS.join(','),
        `${subsidiaryId},,2026,monthly,September,Electricity,,10,kWh,`,
        `${A.subsidiaryId},${locationId},2026,monthly,October,Electricity,,10,kWh,`,
      ].join('\n');
    const form = (body: string) => {
      const f = new FormData();
      f.append('file', new Blob([body], { type: 'text/csv' }), 'int-test.csv');
      f.append('dryRun', 'true');
      return f;
    };
    const foreignIds = { ...dataB, subsidiaryId: B.subsidiaryId, organisationId: B.organisationId };
    const missingIds = { ...foreignIds, subsidiaryId: randomUUID(), locationId: randomUUID() };
    const before = await snapshotB();
    // The route is throttled per user (five calls a minute): superAdmin makes two, dataEntry three.
    let foreign: Res | undefined;
    for (const role of ['superAdmin', 'dataEntry'] as const) {
      foreign = await call(role, 'POST', '/bulk-upload/activity-records', form(csv(B.subsidiaryId, dataB.locationId)));
      const missing = await call(role, 'POST', '/bulk-upload/activity-records', form(csv(missingIds.subsidiaryId, missingIds.locationId)));
      expect(foreign.status, `${role}: ${foreign.text.slice(0, 300)}`).toBeLessThan(500);
      expect(normalise(foreign, foreignIds), role).toBe(normalise(missing, missingIds));
      for (const marker of markersB.filter((m) => m !== B.subsidiaryId && m !== dataB.locationId)) {
        expect(foreign.text, `${role} leaks ${marker}`).not.toContain(marker);
      }
    }
    expect(await snapshotB()).toBe(before);
    const own = await call('dataEntry', 'POST', '/bulk-upload/activity-records', form(csv(A.subsidiaryId, dataA.locationId)));
    expect(own.status, own.text.slice(0, 300)).toBeLessThan(500);
    expect(normalise(own, { ...dataA, subsidiaryId: A.subsidiaryId, organisationId: A.organisationId })).not.toBe(
      normalise(foreign!, foreignIds),
    );
  });
});

describe('inside one organisation: a data_entry user reaches only what it is granted', () => {
  it('a batch over a subsidiary of its organisation it is not granted is neither listed nor readable', async () => {
    const ungranted = await owner.subsidiary.create({
      data: { organisationId: A.organisationId, legalName: 'Int-test ungranted subsidiary', geographyCode: 'UK' },
    });
    const batch = await owner.importBatch.create({
      data: {
        organisationId: A.organisationId,
        uploadedBy: A.users.dataEntry.id,
        fileName: 'int-test-two.csv',
        fileFormat: 'csv',
        sizeBytes: 1,
        sha256: '0'.repeat(64),
        totalRows: 1,
        subsidiaryIds: [A.subsidiaryId, ungranted.id],
      },
    });
    const list = await call('dataEntry', 'GET', '/import-batches');
    expect(list.text).toContain(dataA.importBatchId); // control: its own batch over its granted subsidiary
    expect(list.text).not.toContain(batch.id);
    expect((await call('dataEntry', 'GET', `/import-batches/${batch.id}`)).status).toBe(404);
    expect((await call('consultant', 'GET', '/import-batches')).text).toContain(batch.id); // organisation-wide readers do see it
  });

  it('the reporting context answers a subsidiary it is not granted as one that does not exist, and never counts it', async () => {
    // Committed data where data_entry is granted: a widened selection would count it.
    await recordIn(ActivityRecordStatus.approved)();
    // Its whole accessible set, read before the ungranted subsidiary and its
    // record exist — and after: a count carries no marker (`security-rls` P2-1).
    const unfiltered = [...CONTEXT_READS.map(({ path }) => `${path}?year=2026`), '/reports/meta?year=2026'];
    const answers = async () => {
      const out: string[] = [];
      for (const path of unfiltered) {
        const res = await call('dataEntry', 'GET', path);
        expect(res.status, path).toBe(200);
        out.push(`${path} ${res.text}`);
      }
      return out;
    };
    const before = await answers();
    const ungranted = await owner.subsidiary.create({
      data: { organisationId: A.organisationId, legalName: 'Int-test subsidiary only consultants see', geographyCode: 'UK' },
    });
    const UNGRANTED_TCO2E = 135792;
    await createRecord(owner, A, {
      subsidiaryId: ungranted.id,
      status: ActivityRecordStatus.approved,
      periodValue: 'March',
      calculation: { tCo2e: UNGRANTED_TCO2E, factorId: 'int-test-placeholder' },
    });
    expect(await answers()).toStrictEqual(before);
    const hidden = [ungranted.legalName, ...printed(UNGRANTED_TCO2E)];
    const missingId = randomUUID();
    for (const { path, empty } of CONTEXT_READS) {
      const selecting = (id: string) => call('dataEntry', 'GET', `${path}?year=2026&subsidiaryId=${id}`);
      const foreign = await selecting(ungranted.id);
      const missing = await selecting(missingId);
      expect(foreign.status, `${path}: ${foreign.text.slice(0, 200)}`).toBe(200);
      expect(dataOf(foreign), path).toStrictEqual(dataOf(missing));
      expect(empty(dataOf(foreign)), path).toBe(true);
      for (const marker of [...hidden, ungranted.id]) {
        expect(foreign.text.replaceAll(`"subsidiaryId":"${ungranted.id}"`, ''), `${path} shows ${marker}`).not.toContain(marker);
      }
    }
    // data_entry exports nothing, whatever it selects.
    for (const [path, rest] of CONTEXT_EXPORTS) {
      const foreign = await call('dataEntry', 'GET', `${path}?year=2026&subsidiaryId=${ungranted.id}${rest}`);
      const missing = await call('dataEntry', 'GET', `${path}?year=2026&subsidiaryId=${missingId}${rest}`);
      expect([foreign.status, foreign.text], path).toStrictEqual([403, missing.text]);
    }
    // Control: an organisation-wide reader counts it.
    const consultant = await call('consultant', 'GET', `/emissions/context/summary?year=2026&subsidiaryId=${ungranted.id}`);
    expect(consultant.text).toContain(String(UNGRANTED_TCO2E));
  });
});

describe("A's every answer stays the same while B's data changes (a leak into a sum carries no marker)", () => {
  it('lists, aggregates, reports and exports, for all four roles', async () => {
    // Tracked by location, so completeness reads its records query (subsidiary-
    // level tracking answers before reading any record — `qa-auditor` round 2).
    await owner.subsidiary.update({ where: { id: A.subsidiaryId }, data: { trackingGranularity: 'location' } });
    // Something of A's own for the aggregates to compute: approved figures in
    // 2025 and 2026, so a target's "current year" is A's 2026 — and moves if a
    // later year of anyone else's leaks in.
    for (const [reportingYear, tCo2e] of [[2025, 5], [2026, 7]] as const) {
      await createRecord(owner, A, {
        status: ActivityRecordStatus.approved,
        reportingYear,
        periodValue: 'June',
        calculation: { tCo2e, factorId: 'int-test-placeholder' },
      });
    }
    // And a withdrawal, whose time the exports print as business data (Codex P3).
    await voidedIn();
    const paths = [
      '/me',
      '/kpi',
      '/subsidiaries',
      `/subsidiaries/${A.subsidiaryId}/summary`,
      '/activity-records',
      '/locations',
      '/targets',
      '/targets/progress',
      '/denominators',
      '/period-locks',
      '/import-batches',
      // Not `/audit`: the exports below audit themselves, so A's own trail grows
      // between the two passes. Its containment is the marker check above.
      ...[2025, 2026].flatMap((year) => [
        `/intensity?year=${year}`,
        `/emissions/summary?year=${year}`,
        `/emissions/tracking-matrix?year=${year}`,
        `/emissions/completeness?subsidiaryId=${A.subsidiaryId}&year=${year}`,
        `/reports/meta?year=${year}`,
        `/reports/csv?year=${year}&template=ghg_protocol_detail`,
        `/reports/excel?year=${year}&template=executive_summary`,
        `/reports/pdf?year=${year}&template=ghg_protocol_detail&includeEvidenceSummary=true`,
        // the reporting context: unfiltered, A's own selection, and a scope
        ...['', `&subsidiaryId=${A.subsidiaryId}`, '&scope=2'].flatMap((filter) => [
          ...CONTEXT_READS.map(({ path }) => `${path}?year=${year}${filter}`),
          ...CONTEXT_EXPORTS.map(([path, rest]) => `${path}?year=${year}${filter}${rest}`),
        ]),
      ]),
    ];
    const answers = async () => {
      const out: Record<string, string> = {};
      for (const role of ROLES) {
        for (const path of paths) {
          const res = await call(role, 'GET', path);
          // The same request twice: a JSON or CSV body's ETag is stable, and compared.
          out[`${role} GET ${path}`] = `${res.status} ${res.headers} ${res.generated ? '' : res.etag} ${res.text}`;
        }
      }
      return out;
    };

    const before = await answers();
    const progress = JSON.parse((await call('consultant', 'GET', '/targets/progress')).text) as { targetId: string; currentYear: number }[];
    expect(progress.find((p) => p.targetId === dataA.targetId)?.currentYear).toBe(2026);
    const completeness = JSON.parse(
      (await call('consultant', 'GET', `/emissions/completeness?subsidiaryId=${A.subsidiaryId}&year=2026`)).text,
    ) as { categories: unknown[] };
    expect(completeness.categories.length).toBeGreaterThan(0);
    // B changes in every way an aggregate could pick up: committed figures in
    // A's years and in a later one, a draft, denominators, a site, a target, a
    // lock, an audit row.
    const approved = (reportingYear: number, periodValue: string, tCo2e: number) =>
      createRecord(owner, B, {
        status: ActivityRecordStatus.approved,
        reportingYear,
        periodValue,
        calculation: { tCo2e, factorId: 'int-test-placeholder' },
      });
    const records = [
      await approved(2025, 'July', 1111),
      await approved(2026, 'April', 2222),
      await approved(2027, 'January', 3333),
      await createRecord(owner, B, { reportingYear: 2026, periodValue: 'May' }),
      // Withdrawals in both of A's years: a withdrawn count carries no marker (`qa-auditor` P2-1).
      ...(await Promise.all(
        [2025, 2026].map((reportingYear) =>
          createRecord(owner, B, {
            status: ActivityRecordStatus.voided,
            reportingYear,
            periodValue: 'August',
            calculation: { tCo2e: 4444, factorId: 'int-test-placeholder' },
            voidReason: 'Int-test later withdrawal B gave',
            voidedBy: B.users.superAdmin.id,
            // Later than A's (VOIDED_AT): a time leaking across tenants shows,
            // now that only the generation minute is masked.
            voidedAt: VOIDED_AT.laterB,
          }),
        ),
      )),
    ];
    const by = B.users.dataEntry.id;
    const denominators = [
      await owner.subsidiaryDenominator.create({ data: { subsidiaryId: B.subsidiaryId, year: 2025, metric: 'revenue', value: 2e6, unit: 'EUR', createdBy: by } }),
      await owner.subsidiaryDenominator.create({ data: { subsidiaryId: B.subsidiaryId, year: 2025, metric: 'headcount', value: 77, unit: 'FTE', createdBy: by } }),
    ];
    const location = await owner.location.create({ data: { subsidiaryId: B.subsidiaryId, name: 'Int-test B site two', geographyCode: 'UK' } });
    const target = await owner.target.create({
      data: { subsidiaryId: B.subsidiaryId, name: 'Int-test B target two', basis: 'internal_annual', scope: 'all', baselineYear: 2025, baselineTCo2e: 99, targetYear: 2027, targetTCo2e: 9, createdBy: by },
    });
    const lock = await owner.periodLock.create({
      data: { subsidiaryId: B.subsidiaryId, reportingYear: 2025, reportingPeriod: 'monthly', periodValue: 'July', lockedBy: by },
    });
    const audit = await owner.auditLog.create({
      data: { userId: B.users.superAdmin.id, organisationId: B.organisationId, role: 'super_admin', action: 'update', entity: 'subsidiary', entityId: B.subsidiaryId },
    });
    // B's 2026 revenue exists (beforeAll): it changes, last, so a failed create
    // above cannot leave it changed for the rest of the file.
    await owner.subsidiaryDenominator.update({ where: { id: revenueBId }, data: { value: 1e6 } });
    try {
      const after = await answers();
      for (const key of Object.keys(before)) expect(after[key], key).toBe(before[key]);
    } finally {
      await owner.auditLog.delete({ where: { id: audit.id } });
      await owner.periodLock.delete({ where: { id: lock.id } });
      await owner.target.delete({ where: { id: target.id } });
      await owner.location.delete({ where: { id: location.id } });
      await owner.subsidiaryDenominator.deleteMany({ where: { id: { in: denominators.map((d) => d.id) } } });
      await owner.subsidiaryDenominator.update({ where: { id: revenueBId }, data: { value: B_REVENUE } });
      await owner.activityRecord.deleteMany({ where: { id: { in: records.map((r) => r.id) } } });
    }
  }, 180_000);
});

describe("the reporting context's answers to B's selection, as each of A's roles: an empty answer, the context echoed, nothing of B", () => {
  it.each(CONTEXT_FILTERS.flatMap((filter) => CONTEXT_READS.map((read) => [`GET ${read.path}?subsidiaryId=${filter}`, read, filter] as const)))(
    '%s',
    async (_name, { path, empty }, filter) => {
      // A has committed and withdrawn data in the selected year, scope and category:
      // an inaccessible selection widened to A's accessible set would not be empty.
      await recordIn(ActivityRecordStatus.approved)();
      await voidedIn();
      const missingId = randomUUID();
      const echo = (subsidiaryId: string) => ({ year: 2026, subsidiaryId, ...filterContext(filter) });
      for (const role of ROLES) {
        const answer = async (id: string) => {
          const res = await call(role, 'GET', `${path}?year=2026&subsidiaryId=${id}${filter}`);
          expect(res.status, `${role} ${path}: ${res.text.slice(0, 200)}`).toBe(200);
          return JSON.parse(res.text) as { context: unknown; data: unknown };
        };
        const foreign = await answer(B.subsidiaryId);
        const missing = await answer(missingId);
        // #167: the selection comes back verbatim, never widened or dropped…
        expect(foreign.context, role).toStrictEqual(echo(B.subsidiaryId));
        expect(missing.context, role).toStrictEqual(echo(missingId));
        // …and the data is the unknown id's, as is — no id swapped, so B's id
        // in it (a `selectedSubsidiaryIds: [B]`) would show.
        expect(foreign.data, role).toStrictEqual(missing.data);
        expect(empty(foreign.data), `${role} ${path}: ${JSON.stringify(foreign.data).slice(0, 200)}`).toBe(true);
      }
    },
  );
});

describe("context exports with B's selection, as each of A's roles: the same file and the same generation audit as an unknown one (#168)", () => {
  const reportRows = () => owner.auditLog.findMany({ where: { organisationId: A.organisationId, entity: 'report' } });
  /** The audit rows `request` adds to A's organisation. */
  const audited = async (request: () => Promise<Res>) => {
    const seen = new Set((await reportRows()).map((r) => r.id));
    const res = await request();
    return { res, rows: (await reportRows()).filter((r) => !seen.has(r.id)) };
  };

  it.each(
    CONTEXT_FILTERS.flatMap((filter) =>
      CONTEXT_EXPORTS.flatMap(([path, rest]) => (['GET', 'HEAD'] as const).map((method) => [method, path, filter, rest] as const)),
    ),
  )(
    '%s %s?subsidiaryId=%s',
    async (method, path, filter, rest) => {
      // A's committed and withdrawn records in the selection's year, scope and
      // category: a selection widened to A's accessible set would count them.
      await recordIn(ActivityRecordStatus.approved)();
      await voidedIn();
      const missingId = randomUUID();
      const url = (id: string) => `${path}?year=2026&subsidiaryId=${id}${filter}${rest}`;
      const filters = filterContext(filter);
      const before = await snapshotB();
      for (const role of ROLES) {
        const foreign = await audited(() => call(role, method, url(B.subsidiaryId)));
        const missing = await audited(() => call(role, method, url(missingId)));
        const context = `${role} ${method} ${path}`;
        if (role === 'dataEntry') {
          // data_entry exports nothing — for any selection, and leaves no trail.
          expect([foreign.res.status, missing.res.status], context).toStrictEqual([403, 403]);
          expect([foreign.rows, missing.rows], context).toStrictEqual([[], []]);
          continue;
        }
        expect([foreign.res.status, missing.res.status], `${context}: ${foreign.res.text.slice(0, 200)}`).toStrictEqual([200, 200]);
        // The file name carries the selection, by its first 8 characters.
        expect(foreign.res.disposition, context).toBe(missing.res.disposition?.replace(missingId.slice(0, 8), B.subsidiaryId.slice(0, 8)));
        expect(foreign.res.disposition, context).toContain(`-${B.subsidiaryId.slice(0, 8)}${filters.scope ? '-scope2' : ''}${filters.category ? '-electricity' : ''}.`);
        // One generation row each, in A's organisation, by the caller — every
        // column the same (its id and time aside), the diff but for the
        // selection it records (Codex: role and entityId included).
        expect([foreign.rows.length, missing.rows.length], context).toStrictEqual([1, 1]);
        const [row] = foreign.rows;
        expect(row, context).toMatchObject({ organisationId: A.organisationId, userId: A.users[role].id, action: 'generate', entity: 'report', entityId: null });
        const columns = (r: typeof row) => Object.fromEntries(Object.entries(r).filter(([key]) => !['id', 'createdAt', 'diff'].includes(key)));
        expect(columns(row), context).toStrictEqual(columns(missing.rows[0]));
        expect(missing.rows[0].diff, context).toMatchObject({ subsidiaryId: missingId, ...filters, recordCount: 0, voidedCount: 0 });
        expect(Object.keys(missing.rows[0].diff as object).filter((k) => k === 'scope' || k === 'category').sort(), context).toStrictEqual(Object.keys(filters).sort());
        expect(row.diff, context).toStrictEqual({ ...(missing.rows[0].diff as object), subsidiaryId: B.subsidiaryId });
        // A PDF and a workbook name the filters: the selection is named by
        // the id it was given, never as every subsidiary (and never by B's name).
        // The English wording is today's documented label, not the isolation
        // contract — LP4-03's report language parametrises it.
        if (method === 'GET' && !path.endsWith('csv')) {
          expect(foreign.res.text, context).toContain(`Selected subsidiary (${B.subsidiaryId})`);
          expect(foreign.res.text, context).not.toContain('All accessible subsidiaries');
        }
        // Nor does it fall back to A's own ledgers: A's records are listed under
        // its subsidiary's name, which an empty selection never prints, and its
        // withdrawal under its reason.
        if (method === 'GET') {
          expect(foreign.res.text, context).not.toContain(subsidiaryNameA);
          expect(foreign.res.text, context).not.toContain('Int-test withdrawal A gave');
        }
      }
      expect(await snapshotB(), `${method} ${path} changed B's data`).toBe(before);

      // Control: A's own selection names A's subsidiary (in its label, and in
      // its ledger where the template has one), audits its record as counted
      // and its withdrawal as withdrawn, and lists the withdrawal's reason.
      const own = await audited(() => call('consultant', method, url(A.subsidiaryId)));
      expect(own.res.status, own.res.text.slice(0, 200)).toBe(200);
      expect(own.rows.map((r) => r.diff), `${method} ${path}`).toEqual([
        expect.objectContaining({ subsidiaryId: A.subsidiaryId, recordCount: 1, voidedCount: 1 }),
      ]);
      if (method === 'GET') {
        expect(own.res.text).toContain(subsidiaryNameA);
        expect(own.res.text).toContain('Int-test withdrawal A gave');
        expect(own.res.text).not.toContain('Selected subsidiary (');
      }
      // A's own selection carries nothing of B either (`security-rls` P3-3).
      for (const marker of markersB) expect(`${own.res.headers} ${own.res.text}`, `${method} ${path} leaks ${marker}`).not.toContain(marker);
    },
  );
});

describe("locationId is no reporting-context field: B's site is refused exactly as A's own and an unknown one", () => {
  it.each([
    ...CONTEXT_READS.map(({ path }) => [path, ''] as const),
    ...CONTEXT_EXPORTS,
  ])('GET %s?locationId=', async (path, rest) => {
    const sites = [dataB.locationId, dataA.locationId, randomUUID()];
    for (const role of ROLES) {
      const answers: string[] = [];
      for (const site of sites) {
        const res = await call(role, 'GET', `${path}?year=2026&locationId=${site}${rest}`);
        expect(res.status, `${role} ${path}: ${res.text.slice(0, 200)}`).toBe(400);
        expect((JSON.parse(res.text) as { code?: unknown }).code, role).toBe('validation_failed');
        for (const marker of markersB.filter((m) => m !== site)) expect(res.text, `${role} ${path} leaks ${marker}`).not.toContain(marker);
        answers.push(res.text.split(site).join('<id>'));
      }
      expect(new Set(answers).size, `${role} ${path}: ${answers.join(' | ')}`).toBe(1);
    }
  });
});

describe('context exports are EXPORT work (#160, #168): one report at a time, and the export quota', () => {
  const csv = '/reports/context/csv?year=2026&template=executive_summary';

  it('while a PDF renders, every other export is refused — context and legacy alike — and reads are not', async () => {
    const hold = deferred();
    const entered = deferred();
    pdf.hold = hold.promise;
    pdf.entered = () => entered.resolve();
    // Outside the try: on any failure below, `finally` releases the render and
    // waits for its request to settle — its audit row and its lease — before
    // the test ends and afterEach removes A (Codex P3).
    const rendering = call('consultant', 'GET', '/reports/context/pdf?year=2026&template=executive_summary');
    try {
      // A render refused before the printer says why, instead of timing out (`qa-auditor` P3-3).
      let reached = false;
      const refusedEarly = rendering.then((res) => {
        if (!reached) throw new Error(`the render answered ${res.status} before reaching the printer: ${res.text.slice(0, 200)}`);
      });
      refusedEarly.catch(() => undefined); // the race reports it; once the printer is reached it is moot
      await Promise.race([entered.promise.then(() => (reached = true)), refusedEarly]);
      for (const path of [
        csv,
        '/reports/context/excel?year=2026&template=executive_summary',
        '/reports/context/pdf?year=2026&template=executive_summary',
        '/reports/csv?year=2026&template=executive_summary',
        '/reports/excel?year=2026&template=executive_summary',
        '/reports/pdf?year=2026&template=executive_summary',
      ]) {
        for (const method of ['GET', 'HEAD'] as const) {
          const res = await call('superAdmin', method, path);
          expect(res.status, `${method} ${path}: ${res.text.slice(0, 200)}`).toBe(429);
          if (method === 'GET') expect((JSON.parse(res.text) as { code?: unknown }).code, path).toBe('rate_limited');
        }
      }
      // A spelling the router still answers is EXPORT work too (the trailing
      // slash, the case: 429); the others reach no route (404). The invariant
      // is that no accepted spelling skips EXPORT; the exact 404s characterise
      // today's router and move with it.
      for (const [variant, status] of [
        ['/reports/context/csv/', 429],
        ['/REPORTS/CONTEXT/CSV', 429],
        ['/reports//context/csv', 404],
        ['/reports/context/c%73v', 404],
      ] as const) {
        const res = await call('superAdmin', 'GET', `${variant}?year=2026&template=executive_summary`);
        expect(res.status, `${variant}: ${res.text.slice(0, 120)}`).toBe(status);
      }
      for (const path of ['/reports/context/meta?year=2026', ...CONTEXT_READS.map((r) => `${r.path}?year=2026`)]) {
        expect((await call('superAdmin', 'GET', path)).status, path).toBe(200);
      }
      hold.resolve();
      expect((await rendering).status).toBe(200);
    } finally {
      hold.resolve();
      // Settled, never thrown from here: the assertion that failed stays the error reported.
      await rendering.catch(() => undefined);
      pdf.hold = undefined;
      pdf.entered = undefined;
    }
    // The lease came back with the render.
    expect((await call('superAdmin', 'GET', csv)).status).toBe(200);
  });

  it('context and legacy exports spend one per-user quota; reads and other users do not', async () => {
    const config = limits.config as { RATE_EXPORT_PER_MINUTE: number };
    const previous = config.RATE_EXPORT_PER_MINUTE;
    config.RATE_EXPORT_PER_MINUTE = 5;
    try {
      const spend: [string, 'GET' | 'HEAD'][] = [
        ['/reports/csv?year=2026&template=executive_summary', 'GET'],
        [csv, 'GET'],
        ['/reports/excel?year=2026&template=executive_summary', 'GET'],
        ['/reports/context/excel?year=2026&template=executive_summary', 'GET'],
        [csv, 'HEAD'],
      ];
      for (const [path, method] of spend) expect((await call('consultant', method, path)).status, `${method} ${path}`).toBe(200);
      const sixth = await call('consultant', 'GET', '/reports/context/pdf?year=2026&template=executive_summary');
      expect(sixth.status, sixth.text.slice(0, 200)).toBe(429);
      expect((JSON.parse(sixth.text) as { code?: unknown }).code).toBe('rate_limited');
      expect((await call('consultant', 'GET', '/reports/context/meta?year=2026')).status).toBe(200);
      expect((await call('superAdmin', 'GET', csv)).status).toBe(200);
    } finally {
      config.RATE_EXPORT_PER_MINUTE = previous;
    }
  });
});

describe('PATCH /me/preferences (LP3-01): the caller\'s own language, and nothing else', () => {
  it('sets it for every role, audits the change, and GET /me reads it back', async () => {
    for (const role of ROLES) {
      const set = await call(role, 'PATCH', '/me/preferences', { language: 'tr' });
      expect(set.status, `${role}: ${set.text}`).toBe(200);
      expect(JSON.parse(set.text)).toMatchObject({ id: A.users[role].id, language: 'tr' });
      expect(JSON.parse((await call(role, 'GET', '/me')).text).language, role).toBe('tr');
    }
    const rows = await owner.auditLog.findMany({
      where: { entity: 'profile', entityId: { in: ROLES.map((r) => A.users[r].id) }, action: 'update' },
    });
    expect(rows).toHaveLength(ROLES.length);
    for (const row of rows) {
      expect(row.organisationId).toBe(A.organisationId);
      expect(row.diff).toEqual({ before: { language: 'en' }, after: { language: 'tr' } });
    }
  });

  it('writes no audit row for a language already set', async () => {
    await call('dataEntry', 'PATCH', '/me/preferences', { language: 'en' });
    expect(await owner.auditLog.count({ where: { entity: 'profile', entityId: A.users.dataEntry.id } })).toBe(0);
  });

  it.each([
    ['an unsupported language', { language: 'de' }],
    ['a locale tag', { language: 'tr-TR' }],
    ['no language', {}],
    ['another profile column', { language: 'tr', role: 'super_admin' }],
    ['another user', { language: 'tr', id: randomUUID() }],
  ])('refuses %s with validation_failed and changes nothing', async (_label, body) => {
    const res = await call('dataEntry', 'PATCH', '/me/preferences', body);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text).code).toBe('validation_failed');
    const profile = await owner.profile.findUniqueOrThrow({ where: { id: A.users.dataEntry.id } });
    expect(profile).toMatchObject({ language: 'en', role: 'data_entry' });
  });

  it("leaves every other profile as it was — A's other users and B's", async () => {
    // Only this file's tenants: other spec files create and remove theirs concurrently.
    const others = [...ROLES.filter((r) => r !== 'dataEntry').map((r) => A.users[r].id), ...ROLES.map((r) => B.users[r].id)];
    const read = () => owner.profile.findMany({ where: { id: { in: others } }, orderBy: { id: 'asc' } });
    const before = await read();
    expect(before).toHaveLength(others.length);
    expect((await call('dataEntry', 'PATCH', '/me/preferences', { language: 'tr' })).status).toBe(200);
    expect(await read()).toEqual(before);
  });
});
