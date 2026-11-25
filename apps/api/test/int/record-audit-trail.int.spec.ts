/**
 * WP5 (`uat4-review-resubmit`): one record's audit trail over HTTP, against the
 * real database, as the runtime role.
 *
 * The story is driven through the API's own routes (evidence is linked on the
 * owner's client: the upload path needs Storage, which this suite stubs
 * elsewhere), then the trail is read by each role, and across the two
 * boundaries the API alone enforces for this read: another organisation and a
 * subsidiary the caller holds no grant for. Both must answer exactly as
 * `GET /activity-records/:id` does.
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { ActivityRecordDTO, RecordAuditTrailDTO } from '@tonyai/shared-types';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestUser } from '../../src/auth/auth.types';
import { PrismaService } from '../../src/prisma/prisma.service';
import { apiTokenIssuer, attachEvidence, connectOwner, createRecord, createTenant, type Tenant } from './db';

const JWT_SECRET = randomBytes(32).toString('hex');
let app: INestApplication;
let base: string;
let owner: PrismaService;
let A: Tenant;
let B: Tenant;

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
  A = await createTenant();
  B = await createTenant();
});

afterEach(async () => {
  await Promise.all([A?.cleanup(), B?.cleanup()]);
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

async function call(user: RequestUser | null, method: string, path: string, body?: unknown): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (user) headers.authorization = `Bearer ${await tokenFor(user.id)}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

async function ok<T>(user: RequestUser, method: string, path: string, body?: unknown): Promise<T> {
  const answer = await call(user, method, path, body);
  if (answer.status >= 300) throw new Error(`${method} ${path} answered ${answer.status}: ${answer.text}`);
  return JSON.parse(answer.text) as T;
}

const trailOf = (user: RequestUser | null, id: string) => call(user, 'GET', `/activity-records/${id}/audit-trail`);

/** The spec's whole story, every step through the API. */
async function elevenEventStory(t: Tenant): Promise<ActivityRecordDTO> {
  const entry = t.users.dataEntry;
  const reviewer = t.users.consultant;
  const created = await ok<ActivityRecordDTO>(entry, 'POST', '/activity-records', {
    subsidiaryId: t.subsidiaryId,
    locationId: null,
    reportingYear: 2026,
    reportingPeriod: 'monthly',
    periodValue: 'January',
    category: 'Electricity',
    activityType: null,
    activityValue: 1000,
    activityUnit: 'kWh',
    varianceReason: null,
    input: null,
  });
  const id = created.id;
  await attachEvidence(owner, t, [id]);
  await ok(entry, 'POST', `/activity-records/${id}/submit`);
  await ok(entry, 'POST', `/activity-records/${id}/recall`);
  await ok(entry, 'PATCH', `/activity-records/${id}`, { activityValue: 1200 });
  let rec = await ok<ActivityRecordDTO>(entry, 'POST', `/activity-records/${id}/submit`);
  await ok(reviewer, 'POST', `/activity-records/${id}/review`, { seenSubmittedAt: rec.submittedAt });
  await ok(reviewer, 'POST', `/activity-records/${id}/reject`, {
    varianceReason: 'The March invoice is missing',
    seenSubmittedAt: rec.submittedAt,
  });
  await ok(entry, 'PATCH', `/activity-records/${id}`, { activityValue: 1250 });
  rec = await ok<ActivityRecordDTO>(entry, 'POST', `/activity-records/${id}/submit`);
  await ok(reviewer, 'POST', `/activity-records/${id}/review`, { seenSubmittedAt: rec.submittedAt });
  return ok<ActivityRecordDTO>(reviewer, 'POST', `/activity-records/${id}/approve`, { seenSubmittedAt: rec.submittedAt });
}

describe('WP5 — a record\'s audit trail over HTTP', () => {
  it('tells the eleven-event story, numbers the submissions and names the reviewer', async () => {
    const approved = await elevenEventStory(A);
    expect(approved.status).toBe('approved');
    expect(approved.submissionCount).toBe(3);

    const trail = JSON.parse((await trailOf(A.users.consultant, approved.id)).text) as RecordAuditTrailDTO;

    expect(trail.truncated).toBe(false);
    expect(trail.events.map((e) => e.kind)).toEqual([
      'created',
      'submitted',
      'recalled',
      'edited',
      'resubmitted',
      'review_started',
      'returned',
      'edited',
      'resubmitted',
      'review_started',
      'approved',
    ]);
    expect(trail.events.filter((e) => e.submission !== null).map((e) => e.submission)).toEqual([1, 2, 3]);
    const returned = trail.events[6];
    expect(returned.reason).toBe('The March invoice is missing');
    expect(returned.actor?.role).toBe('consultant');
    const firstEdit = trail.events[3];
    expect(firstEdit.changes.map((c) => c.field)).toEqual(['activityValue', 'figure']);
    expect(firstEdit.changes[0]).toEqual({ field: 'activityValue', before: 1000, after: 1200 });
  });

  it("shows the author's variance reason on the submit, as the record held it (owner review)", async () => {
    const entry = A.users.dataEntry;
    const created = await ok<ActivityRecordDTO>(entry, 'POST', '/activity-records', {
      subsidiaryId: A.subsidiaryId,
      locationId: null,
      reportingYear: 2026,
      reportingPeriod: 'monthly',
      periodValue: 'June',
      category: 'Electricity',
      activityType: null,
      activityValue: 1000,
      activityUnit: 'kWh',
      varianceReason: 'New chiller since March',
      input: null,
    });
    await attachEvidence(owner, A, [created.id]);
    await ok(entry, 'POST', `/activity-records/${created.id}/submit`);

    const row = await owner.auditLog.findFirstOrThrow({ where: { entityId: created.id, action: 'submit' } });
    expect(row.diff).toMatchObject({ submission: 1, varianceReason: 'New chiller since March' });
    const trail = JSON.parse((await trailOf(A.users.consultant, created.id)).text) as RecordAuditTrailDTO;
    expect(trail.events.find((e) => e.kind === 'submitted')?.reason).toBe('New chiller since March');
  });

  it('numbers a submit after a legacy `update` submit and an uncounted `submit` as the third (owner review)', async () => {
    const entry = A.users.dataEntry;
    const created = await ok<ActivityRecordDTO>(entry, 'POST', '/activity-records', {
      subsidiaryId: A.subsidiaryId, locationId: null, reportingYear: 2026, reportingPeriod: 'monthly',
      periodValue: 'July', category: 'Electricity', activityType: null, activityValue: 1000,
      activityUnit: 'kWh', varianceReason: null, input: null,
    });
    await attachEvidence(owner, A, [created.id]);
    // History the API cannot write any more: a pre-taxonomy submit (an `update`
    // moving to `submitted`), counted by the migration as 1, then a `submit` by
    // the previous image in the deploy window, which raised nothing.
    const row = (action: string, at: string) => ({
      userId: entry.id, organisationId: A.organisationId, role: 'data_entry', action,
      entity: 'activity_record', entityId: created.id, createdAt: new Date(at),
      diff: { transition: { from: 'draft', to: 'submitted' } },
    });
    await owner.auditLog.createMany({ data: [row('update', '2026-01-01T00:00:00Z'), row('submit', '2026-01-02T00:00:00Z')] });
    await owner.activityRecord.update({ where: { id: created.id }, data: { submissionCount: 1 } });

    const third = await ok<ActivityRecordDTO>(entry, 'POST', `/activity-records/${created.id}/submit`);
    expect(third.submissionCount).toBe(3);
    const trail = JSON.parse((await trailOf(A.users.consultant, created.id)).text) as RecordAuditTrailDTO;
    expect(trail.events.filter((e) => e.submission !== null).map((e) => e.submission)).toEqual([1, 2, 3]);
  });

  it('is read by the three organisation-wide roles and the author, never written', async () => {
    const approved = await elevenEventStory(A);
    const auditRows = () => owner.auditLog.count({ where: { entityId: approved.id } });
    const before = await auditRows();

    const answers = await Promise.all(
      [A.users.superAdmin, A.users.consultant, A.users.executiveViewer, A.users.dataEntry].map((u) =>
        trailOf(u, approved.id),
      ),
    );
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
    // Two reads hold the same events and write no audit row.
    expect(answers[0].text).toBe((await trailOf(A.users.superAdmin, approved.id)).text);
    expect(await auditRows()).toBe(before);
  });

  it('refuses a data_entry user the trail of a colleague\'s record, which they can read', async () => {
    const colleagues = await createRecord(owner, A, { createdBy: A.users.superAdmin.id, periodValue: 'February' });
    expect((await call(A.users.dataEntry, 'GET', `/activity-records/${colleagues.id}`)).status).toBe(200);
    const refused = await trailOf(A.users.dataEntry, colleagues.id);
    expect(refused.status).toBe(403);
    expect(refused.text).not.toContain('"events"');
  });

  it('refuses a record of another organisation exactly as its read is', async () => {
    const recordB = await createRecord(owner, B, { periodValue: 'March' });
    const read = await call(A.users.superAdmin, 'GET', `/activity-records/${recordB.id}`);
    const trail = await trailOf(A.users.superAdmin, recordB.id);
    expect(read.status).toBe(404);
    expect(trail).toEqual(read);
  });

  it('refuses a record in a subsidiary without a grant exactly as its read is', async () => {
    const sibling = await owner.subsidiary.create({
      data: { organisationId: A.organisationId, legalName: `Int-test no grant ${A.organisationId.slice(0, 8)}`, geographyCode: 'UK' },
    });
    try {
      const ungranted = await createRecord(owner, A, {
        subsidiaryId: sibling.id,
        createdBy: A.users.dataEntry.id,
        periodValue: 'April',
      });
      const read = await call(A.users.dataEntry, 'GET', `/activity-records/${ungranted.id}`);
      const trail = await trailOf(A.users.dataEntry, ungranted.id);
      expect(read.status).toBe(404);
      expect(trail).toEqual(read);
    } finally {
      await owner.activityRecord.deleteMany({ where: { subsidiaryId: sibling.id } });
      await owner.subsidiary.delete({ where: { id: sibling.id } });
    }
  });

  it('refuses a request with no session', async () => {
    const record = await createRecord(owner, A);
    expect((await trailOf(null, record.id)).status).toBe(401);
  });

  it('returns no calculation, no user id and no email address', async () => {
    const approved = await elevenEventStory(A);
    const text = (await trailOf(A.users.dataEntry, approved.id)).text;
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, item] of Object.entries(v)) {
          keys.add(k);
          walk(item);
        }
      }
    };
    walk(JSON.parse(text));
    for (const key of ['calculation', 'diff', 'transition', 'userId', 'email', 'createdBy', 'factorId']) {
      expect(keys.has(key), key).toBe(false);
    }
    // A change carries values, never a stored snapshot.
    const trail = JSON.parse(text) as RecordAuditTrailDTO;
    for (const change of trail.events.flatMap((e) => e.changes)) {
      for (const value of [change.before, change.after]) {
        expect(value === null || typeof value !== 'object', change.field).toBe(true);
      }
    }
    for (const id of A.profileIds) expect(text).not.toContain(id);
    expect(text).not.toContain('@');
  });

  it('holds only this record\'s events, not a neighbour\'s edited in the same minute', async () => {
    const first = await elevenEventStory(A);
    const neighbour = await createRecord(owner, A, { periodValue: 'May' });
    await ok(A.users.dataEntry, 'PATCH', `/activity-records/${neighbour.id}`, { activityValue: 7 });
    const trail = JSON.parse((await trailOf(A.users.superAdmin, first.id)).text) as RecordAuditTrailDTO;
    const ids = new Set(
      (await owner.auditLog.findMany({ where: { entityId: neighbour.id }, select: { id: true } })).map((r) => r.id),
    );
    expect(ids.size).toBeGreaterThan(0);
    expect(trail.events.some((e) => ids.has(e.id))).toBe(false);
  });
});
