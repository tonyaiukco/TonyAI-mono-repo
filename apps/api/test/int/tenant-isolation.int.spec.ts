import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ActivityRecordStatus } from '@tonyai/db';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { attachEvidence, connectOwner, createRecord, createTenant, createTenantData, type Tenant, type TenantData } from './db';

/**
 * LP1-03 (F06): every externally reachable tenant path, through the REAL API —
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
 * aggregate, unfiltered, carries no trace of B for any of A's roles.
 */

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

// An integer, so rounding cannot hide it; also searched for in the grouped
// forms a CSV or a Turkish locale would print.
const B_TCO2E = 987654;
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
  const { ValidationPipe } = await import('@nestjs/common');
  const { AppModule } = await import('../../src/app.module');
  app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/api/v1`.replace('[::1]', '127.0.0.1');

  owner = connectOwner(2);
  B = await createTenant();
  dataB = await createTenantData(owner, B);
  // B's approved figure: a number no response to A may contain.
  const approvedB = await createRecord(owner, B, {
    status: ActivityRecordStatus.approved,
    periodValue: 'March',
    calculation: { tCo2e: B_TCO2E, factorId: 'int-test-placeholder' },
  });
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
  markersB = [
    B.organisationId,
    B.subsidiaryId,
    subB.legalName,
    approvedB.id,
    String(B_TCO2E),
    '987,654',
    '987.654',
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
  dataA = await createTenantData(owner, A);
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
  text: string;
}

async function call(role: Role, method: string, path: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${await tokenFor(A.users[role].id)}` };
  let payload: FormData | string | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  return { status: res.status, text: await res.text() };
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

const normalise = (res: Res, ids: Ids) =>
  `${res.status} ${Object.values(ids).reduce((t, id) => t.split(id).join('<id>'), res.text)}`;

interface Route {
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
  const record = await createRecord(owner, A, { status, periodValue: 'June', ...extra });
  await attachEvidence(owner, A, [record.id]);
  return { recordId: record.id };
};

const created = (res: Res) => res.status === 200 || res.status === 201;
const differs = (res: Res, foreign: Res) => res.status !== foreign.status || res.text !== foreign.text;

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
    ] as const
  ).map(
    ([path, rest]): Route => ({
      name: `GET ${path}?subsidiaryId=`,
      method: 'GET',
      path: (i) => `${path}?subsidiaryId=${i.subsidiaryId}${rest}`,
      own: { role: 'consultant', ok: (res) => res.status === 200 },
    }),
  ),
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
      // An id the caller sent may come back (a per-record refusal names it);
      // anything else of B's may not.
      const sent = new Set(Object.values(foreignIds));
      for (const marker of markersB.filter((m) => !sent.has(m))) {
        expect(foreign.text, `${context} — leaks ${marker}`).not.toContain(marker);
      }
    }
    expect(await snapshotB(), `${route.name} changed B's data`).toBe(before);

    // Positive control: A's own id, as a role allowed to use the route.
    const ownIds: Ids = { ...dataA, subsidiaryId: A.subsidiaryId, organisationId: A.organisationId, ...(await route.own.prepare?.()) };
    const own = await call(route.own.role, route.method, route.path(ownIds), route.body?.(ownIds));
    const foreign = await call(route.own.role, route.method, route.path(foreignIds), route.body?.(foreignIds));
    const ok = route.own.ok ?? ((res: Res) => res.status === 200);
    expect(ok(own, foreign), `${route.name} positive control: ${own.status} ${own.text.slice(0, 300)}`).toBe(true);
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
];

describe("every list and aggregate, unfiltered, as each of A's roles: no trace of B", () => {
  it.each(LIST_ROUTES)('GET %s', async (path) => {
    let answered = 0;
    for (const role of ROLES) {
      const res = await call(role, 'GET', path);
      expect(res.status, `${role} GET ${path}: ${res.text.slice(0, 200)}`).toBeLessThan(500);
      if (res.status === 200) answered += 1;
      for (const marker of markersB) expect(res.text, `${role} GET ${path} leaks ${marker}`).not.toContain(marker);
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
