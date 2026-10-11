/**
 * LP4-01 — a record is removed, moved or given a committed status by no one
 * but the owner and the API's login, through its lifecycle (Open questions,
 * "LP3-03 PR B" (11); the owner's K10).
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
import { connect, connectOwner, createRecord, createTenant, refusal, serviceRest, withRollback, type Tenant } from './db';
import { lifecycleServices } from './services';

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

  it("refuses the service role a subsidiary's new id (TA004), and lets the owner's session move one (the operator)", async () => {
    expect(await refusal(await serviceRest('PATCH', `subsidiaries?id=eq.${foreign.subsidiaryId}`, { id: randomUUID() }))).toEqual({ ok: false, code: 'TA004' });
    // A subsidiary with no grant (a granted one is held by LP1-03's keys, for the owner too).
    const moved = await withRollback(owner, async (tx) => {
      const spare = await tx.subsidiary.create({ data: { organisationId: foreign.organisationId, legalName: 'Int-test spare', geographyCode: 'UK' } });
      return (await tx.subsidiary.update({ where: { id: spare.id }, data: { organisationId: tenant.organisationId } })).organisationId;
    });
    expect(moved).toBe(tenant.organisationId);
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

describe('LP4-02 (K11) — what a draft says is what the API computed', () => {
  // The measured attack (LP4-01 follow-ups (9)): the API saved 3.4 tCO2e, a
  // service-role PATCH made it 0.0001, and the author's ordinary submit and a
  // reviewer's approve committed it.
  const forged = { tCo2e: 0.0001, factorId: 'forged' };

  it("refuses the service role a draft's or a rejected record's figure and inputs rewritten through PostgREST (TA006)", async () => {
    const id = randomUUID();
    try {
      expect((await serviceRest('POST', 'activity_records', recordRow(id, 'draft', 'October'))).ok).toBe(true);
      for (const change of [
        { calculation: forged },
        { input: { value: 1 } },
        { activity_value: 0.001 },
        { activity_unit: 'MWh' },
        { category: 'Natural Gas' },
        { scope: 1 },
        { reporting_year: 2025 },
        { reporting_period: 'quarterly' },
        { period_value: 'November' },
        { activity_type: 'grid_electricity' },
        { subsidiary_id: randomUUID() },
        { location_id: randomUUID() },
      ]) {
        expect(await refusal(await serviceRest('PATCH', `activity_records?id=eq.${id}`, change)), JSON.stringify(change)).toEqual({ ok: false, code: 'TA006' });
      }
      // Rejected is editable too — by the API alone.
      await owner.activityRecord.update({ where: { id }, data: { status: ActivityRecordStatus.submitted } });
      await owner.activityRecord.update({ where: { id }, data: { status: ActivityRecordStatus.rejected } });
      expect(await refusal(await serviceRest('PATCH', `activity_records?id=eq.${id}`, { calculation: forged }))).toEqual({ ok: false, code: 'TA006' });
      const stored = await owner.activityRecord.findUniqueOrThrow({ where: { id } });
      expect(stored).toMatchObject({ activityValue: 99, calculation: { tCo2e: 9, factorId: 'forged' } });
    } finally {
      await owner.activityRecord.deleteMany({ where: { id } });
    }
  });

  it("refuses the service role a committed record's free-form input (TA006), and leaves its figure to K5 (TA001)", async () => {
    const id = randomUUID();
    try {
      expect((await serviceRest('POST', 'activity_records', recordRow(id, 'draft', 'December'))).ok).toBe(true);
      await owner.activityRecord.update({ where: { id }, data: { status: ActivityRecordStatus.submitted } });
      await owner.activityRecord.update({ where: { id }, data: { status: ActivityRecordStatus.approved } });
      expect(await refusal(await serviceRest('PATCH', `activity_records?id=eq.${id}`, { input: { value: 1 } }))).toEqual({ ok: false, code: 'TA006' });
      expect(await refusal(await serviceRest('PATCH', `activity_records?id=eq.${id}`, { calculation: forged }))).toEqual({ ok: false, code: 'TA001' });
    } finally {
      await owner.activityRecord.deleteMany({ where: { id } });
    }
  });

  it('refuses the service role deleting a draft or a rejected record — the delete-and-re-insert rewrite (TA006)', async () => {
    const id = randomUUID();
    try {
      expect((await serviceRest('POST', 'activity_records', recordRow(id, 'draft', 'October'))).ok).toBe(true);
      expect(await refusal(await serviceRest('DELETE', `activity_records?id=eq.${id}`))).toEqual({ ok: false, code: 'TA006' });
      // So its id cannot be re-used for a forged figure.
      expect((await serviceRest('POST', 'activity_records', { ...recordRow(id, 'draft', 'October'), calculation: forged })).ok).toBe(false);
      await owner.activityRecord.update({ where: { id }, data: { status: ActivityRecordStatus.submitted } });
      await owner.activityRecord.update({ where: { id }, data: { status: ActivityRecordStatus.rejected } });
      expect(await refusal(await serviceRest('DELETE', `activity_records?id=eq.${id}`))).toEqual({ ok: false, code: 'TA006' });
      expect(await owner.activityRecord.findUniqueOrThrow({ where: { id } })).toMatchObject({ calculation: { factorId: 'forged' }, activityValue: 99 });
    } finally {
      await owner.activityRecord.deleteMany({ where: { id } });
    }
  });

  it('refuses the service role rewriting who wrote a record, at any status — the self-approval rule reads it (TA006)', async () => {
    const id = randomUUID();
    try {
      expect((await serviceRest('POST', 'activity_records', recordRow(id, 'draft', 'October'))).ok).toBe(true);
      expect(await refusal(await serviceRest('PATCH', `activity_records?id=eq.${id}`, { created_by: tenant.users.superAdmin.id }))).toEqual({
        ok: false,
        code: 'TA006',
      });
      await owner.activityRecord.update({ where: { id }, data: { status: ActivityRecordStatus.submitted } });
      expect(await refusal(await serviceRest('PATCH', `activity_records?id=eq.${id}`, { created_by: tenant.users.superAdmin.id }))).toEqual({
        ok: false,
        code: 'TA006',
      });
      expect((await owner.activityRecord.findUniqueOrThrow({ where: { id } })).createdBy).toBe(tenant.users.dataEntry.id);
    } finally {
      await owner.activityRecord.deleteMany({ where: { id } });
    }
  });

  it("lets the API's login and the owner delete a draft (the API's delete; a teardown)", async () => {
    for (const client of [runtime, owner]) {
      const left = await withRollback(client, async (tx) => {
        const rec = await createRecord(tx as unknown as PrismaService, tenant, { periodValue: 'October' });
        await tx.activityRecord.delete({ where: { id: rec.id } });
        return tx.activityRecord.count({ where: { id: rec.id } });
      });
      expect(left).toBe(0);
    }
  });

  it("lets the API's login and the owner rewrite a draft's figure and inputs (the API's save; a fixture)", async () => {
    for (const client of [runtime, owner]) {
      const saved = await withRollback(client, async (tx) => {
        const rec = await createRecord(tx as unknown as PrismaService, tenant, { periodValue: 'October' });
        return tx.activityRecord.update({
          where: { id: rec.id },
          data: { calculation: { tCo2e: 1.5, factorId: 'resaved' }, input: { value: 2 }, activityValue: 2 },
        });
      });
      expect(saved).toMatchObject({ activityValue: 2, calculation: { tCo2e: 1.5 }, input: { value: 2 } });
    }
  });
});

describe("LP4-01 — the API still files a draft at the company or at one of its own sites", () => {
  // The site key is (location_id, subsidiary_id): a relation write would set
  // both columns (Prisma's `disconnect` NULLed the subsidiary — P2011, a 500
  // on every save of a company-level draft). The service writes the column.
  it('saves a company-level draft as such, moves it to its own site and back, and refuses another tenant\'s site', async () => {
    const { records } = lifecycleServices(runtime);
    const foreignSite = await owner.location.create({ data: { subsidiaryId: foreign.subsidiaryId, name: 'Int-test foreign site', geographyCode: 'UK' } });
    const created = await records.create(tenant.users.dataEntry, {
      subsidiaryId: tenant.subsidiaryId, reportingYear: 2026, reportingPeriod: 'quarterly', periodValue: 'Q1',
      category: 'Fuel', activityType: 'diesel', activityValue: 10, activityUnit: 'litres',
    });
    try {
      // Data Entry sends `locationId: null` on every save of a company-level draft.
      expect((await records.update(tenant.users.dataEntry, created.id, { locationId: null, activityValue: 11 })).locationId).toBeNull();
      expect((await records.update(tenant.users.dataEntry, created.id, { locationId: siteId })).locationId).toBe(siteId);
      expect((await records.update(tenant.users.dataEntry, created.id, { locationId: null })).locationId).toBeNull();
      expect(await failure(records.update(tenant.users.dataEntry, created.id, { locationId: foreignSite.id }))).toMatchObject({ code: 'location_not_found' });
      const stored = await owner.activityRecord.findUniqueOrThrow({ where: { id: created.id } });
      expect(stored).toMatchObject({ subsidiaryId: tenant.subsidiaryId, locationId: null });
    } finally {
      await owner.activityRecord.deleteMany({ where: { id: created.id } });
      await owner.location.delete({ where: { id: foreignSite.id } });
    }
  });
});
