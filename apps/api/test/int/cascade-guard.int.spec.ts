/**
 * LP4-01 — a committed record is removed, moved or made by no one but the
 * owner and the API's own lifecycle (Open questions, "LP3-03 PR B" (11); the
 * owner's K10).
 *
 * A foreign key's action runs as the referencing table's owner, whom
 * `activity_records_committed_delete` lets delete a committed record; so no
 * key of `activity_records` has one (RESTRICT / NO ACTION, both ways), the site
 * key is (location_id, subsidiary_id), an organisation is deleted and a
 * subsidiary moved by the owner's session alone, and a record is born a draft
 * and moved by the API's login or the owner's (`session_user`). The K5 halves
 * — a site or a subsidiary that holds a record refuses the runtime role and the
 * owner — are in `factor-model.int.spec.ts`; the catalogue half (keys,
 * triggers, bodies) in `runtime-role.int.spec.ts` through
 * `checkIntegrityTriggers`.
 *
 * The service role's refusals are proven through PostgREST with the service
 * key, as an attacker holding it would act: an owner session that `SET ROLE`s
 * to `service_role` keeps `session_user` = the owner, and the guards rightly
 * let the owner through.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityRecordStatus, Prisma } from '@tonyai/db';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { connect, connectOwner, createRecord, createTenant, withRollback, type Tenant } from './db';

let runtime: PrismaService;
let owner: PrismaService;
let tenant: Tenant;
let foreign: Tenant;
let siteId: string;
let siteRecordId: string;
let batchId: string;

beforeAll(async () => {
  runtime = connect();
  owner = connectOwner();
  [tenant, foreign] = await Promise.all([createTenant(), createTenant()]);
  await createRecord(owner, tenant, { status: ActivityRecordStatus.approved });
  const site = await owner.location.create({ data: { subsidiaryId: tenant.subsidiaryId, name: 'Int-test cascade site', geographyCode: 'UK' } });
  siteId = site.id;
  siteRecordId = (await createRecord(owner, tenant, { periodValue: 'February', locationId: site.id, status: ActivityRecordStatus.approved })).id;
  const batch = await owner.importBatch.create({
    data: {
      organisationId: tenant.organisationId, uploadedBy: tenant.users.dataEntry.id, fileName: 'int-test.csv', fileFormat: 'csv',
      sizeBytes: 1, sha256: '0'.repeat(64), totalRows: 1, subsidiaryIds: [tenant.subsidiaryId],
    },
  });
  batchId = batch.id;
  await createRecord(owner, tenant, { periodValue: 'March', importBatchId: batch.id });
});

afterAll(async () => {
  await tenant?.cleanup();
  await foreign?.cleanup();
  await runtime?.$disconnect();
  await owner?.$disconnect();
});

async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

/** Prisma's error code, or a raw query's SQLSTATE. */
function codeOf(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return (e.meta as { code?: string } | undefined)?.code ?? e.code;
  return /code: "([0-9A-Z]{5})"/.exec(String((e as Error | null)?.message))?.[1] ?? null;
}

/** The local stack's PostgREST with the service key — the credential OQ (11)'s first attack used. */
function serviceRest(method: string, path: string, body?: unknown): Promise<Response> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'The service-role probe needs the local stack: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (`set -a; source apps/api/.env; set +a`). CI exports both.',
    );
  }
  const target = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error(`refusing a non-local SUPABASE_URL (${target.hostname})`);
  return fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** PostgREST's refusal: its HTTP status and the SQLSTATE in its body. */
async function refusal(res: Response): Promise<{ ok: boolean; code?: string }> {
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  return { ok: res.ok, code: body.code };
}

/** A record inserted directly, in the status given — not walked there like `createRecord`'s. */
function recordData(periodValue: string, status: ActivityRecordStatus): Prisma.ActivityRecordUncheckedCreateInput {
  return {
    subsidiaryId: tenant.subsidiaryId, reportingYear: 2026, reportingPeriod: 'monthly', periodValue, category: 'Electricity', scope: 2,
    activityValue: 1, activityUnit: 'kWh', calculation: { tCo2e: 0, factorId: 'int-test-placeholder' }, createdBy: tenant.users.dataEntry.id, status,
  };
}

/** A record row as a direct client would POST it (the slot is the test's own). */
function recordRow(id: string, status: string, periodValue: string) {
  return {
    id, subsidiary_id: tenant.subsidiaryId, reporting_year: 2026, reporting_period: 'monthly', period_value: periodValue,
    category: 'Electricity', scope: 2, activity_value: 99, activity_unit: 'kWh', calculation: { tCo2e: 9, factorId: 'forged' },
    created_by: tenant.users.dataEntry.id, updated_at: new Date().toISOString(), status,
  };
}

describe('LP4-01 — an organisation is the operator’s to delete', () => {
  it('refuses the service role through PostgREST (TA004), and the tenant stays whole', async () => {
    const res = await serviceRest('DELETE', `organisations?id=eq.${tenant.organisationId}`);
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    expect(res.ok).toBe(false);
    expect(body.code).toBe('TA004');
    expect(body.message).toMatch(/deleted by the database owner alone/);
    expect(await owner.organisation.count({ where: { id: tenant.organisationId } })).toBe(1);
    expect(await owner.activityRecord.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(3); // the three records beforeAll files
  });

  it('refuses the service role a subsidiary that holds a record — its key, not a cascade, answers (23503)', async () => {
    const res = await serviceRest('DELETE', `subsidiaries?id=eq.${tenant.subsidiaryId}`);
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    expect(res.ok).toBe(false);
    expect(body.code).toBe('23503');
    expect(await owner.activityRecord.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(3);
  });

  it('gives the runtime role no DELETE on organisations at all (42501, before any trigger)', async () => {
    const e = await failure(withRollback(runtime, (tx) => tx.$executeRawUnsafe(`DELETE FROM organisations WHERE id = '${tenant.organisationId}'`)));
    expect(codeOf(e)).toBe('42501');
  });

  it('refuses the owner too while the organisation holds records — they go first, then it may (the teardown order)', async () => {
    const e = await failure(withRollback(owner, (tx) => tx.organisation.delete({ where: { id: tenant.organisationId } })));
    expect(['P2003', '23503']).toContain(codeOf(e));
    const left = await withRollback(owner, async (tx) => {
      await tx.activityRecord.deleteMany({ where: { subsidiaryId: tenant.subsidiaryId } });
      await tx.organisation.delete({ where: { id: tenant.organisationId } });
      return tx.organisation.count({ where: { id: tenant.organisationId } });
    });
    expect(left).toBe(0);
    expect(await owner.organisation.count({ where: { id: tenant.organisationId } })).toBe(1); // rolled back
  });
});

describe('LP4-01 — records stay where they were filed', () => {
  it('refuses the service role a site that holds a record (23503), instead of re-filing it at company level', async () => {
    expect(await refusal(await serviceRest('DELETE', `locations?id=eq.${siteId}`))).toEqual({ ok: false, code: '23503' });
    expect((await owner.activityRecord.findUniqueOrThrow({ where: { id: siteRecordId } })).locationId).toBe(siteId);
  });

  it('refuses the service role a subsidiary moved to another organisation (TA004) — its records would follow it', async () => {
    expect(await refusal(await serviceRest('PATCH', `subsidiaries?id=eq.${tenant.subsidiaryId}`, { organisation_id: foreign.organisationId }))).toEqual({
      ok: false, code: 'TA004',
    });
    expect((await owner.subsidiary.findUniqueOrThrow({ where: { id: tenant.subsidiaryId } })).organisationId).toBe(tenant.organisationId);
  });

  it('refuses moving a site that holds a record to another subsidiary — the service role (23503) and the runtime role', async () => {
    expect(await refusal(await serviceRest('PATCH', `locations?id=eq.${siteId}`, { subsidiary_id: foreign.subsidiaryId }))).toEqual({
      ok: false, code: '23503',
    });
    const e = await failure(withRollback(runtime, (tx) => tx.location.update({ where: { id: siteId }, data: { subsidiaryId: foreign.subsidiaryId } })));
    expect(['P2003', '23503']).toContain(codeOf(e));
    expect((await owner.location.findUniqueOrThrow({ where: { id: siteId } })).subsidiaryId).toBe(tenant.subsidiaryId);
  });

  it("holds a record's site to the record's own subsidiary, whoever writes it (the owner included)", async () => {
    const e = await failure(withRollback(owner, (tx) => createRecord(tx as unknown as PrismaService, foreign, { periodValue: 'April', locationId: siteId })));
    expect(['P2003', '23503']).toContain(codeOf(e));
  });

  it("refuses the service role an import batch's new id (NO ACTION) — no key change reaches a record", async () => {
    const next = randomUUID();
    expect(await refusal(await serviceRest('PATCH', `import_batches?id=eq.${batchId}`, { id: next }))).toEqual({ ok: false, code: '23503' });
    expect(await owner.activityRecord.count({ where: { importBatchId: batchId } })).toBe(1);
  });
});

describe('LP4-01 — a record is born a draft and moved by the API alone', () => {
  it('refuses the service role an approved record POSTed straight in (TA005)', async () => {
    const id = randomUUID();
    expect(await refusal(await serviceRest('POST', 'activity_records', recordRow(id, 'approved', 'May')))).toEqual({ ok: false, code: 'TA005' });
    expect(await owner.activityRecord.count({ where: { id } })).toBe(0);
  });

  it('refuses the runtime role a locked record inserted directly (TA005)', async () => {
    const e = await failure(withRollback(runtime, (tx) => tx.activityRecord.create({ data: recordData('June', ActivityRecordStatus.locked) })));
    expect(codeOf(e) ?? String(e)).toMatch(/TA005|created as a draft/);
  });

  it('refuses the service role walking its own draft up the lifecycle, one valid step at a time (TA005)', async () => {
    const id = randomUUID();
    try {
      expect((await serviceRest('POST', 'activity_records', recordRow(id, 'draft', 'July'))).ok).toBe(true);
      expect(await refusal(await serviceRest('PATCH', `activity_records?id=eq.${id}`, { status: 'submitted' }))).toEqual({ ok: false, code: 'TA005' });
      expect((await owner.activityRecord.findUniqueOrThrow({ where: { id } })).status).toBe(ActivityRecordStatus.draft);
    } finally {
      await owner.activityRecord.deleteMany({ where: { id } });
    }
  });

  it("lets the API's login move a draft (submit), and the owner insert a committed record (fixtures, a restore)", async () => {
    const moved = await withRollback(runtime, async (tx) => {
      const rec = await createRecord(tx as unknown as PrismaService, tenant, { periodValue: 'August' });
      return (await tx.activityRecord.update({ where: { id: rec.id }, data: { status: ActivityRecordStatus.submitted } })).status;
    });
    expect(moved).toBe(ActivityRecordStatus.submitted);
    const inserted = await withRollback(owner, async (tx) =>
      (await tx.activityRecord.create({ data: recordData('September', ActivityRecordStatus.approved) })).status,
    );
    expect(inserted).toBe(ActivityRecordStatus.approved);
  });
});
