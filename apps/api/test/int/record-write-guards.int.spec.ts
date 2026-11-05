/**
 * LP4-02 B2's record-lifecycle follow-ups (Open questions, "LP4-02
 * follow-ups" (27), (29), (33); the owner's D1a–D4a, 2026-10-15) — what a
 * draft is priced from is the API's to write, and what a record says is
 * refused at the door when no API could have written it.
 *
 * - (27) a subsidiary's or a site's `geography_code` changes in the API's
 *   session or the owner's alone (`geography_code_writer`, TA015);
 * - (29) a record is inserted in the API's session or the owner's alone
 *   (`activity_records_lifecycle_writer`, TA006);
 * - (33) a record's scope is its category's, its period value its
 *   granularity's canonical token, and 0 ≤ its value ≤ ACTIVITY_VALUE_MAX —
 *   CHECKs, for every writer, the owner included (23514).
 *
 * The service role's refusals are proven through PostgREST with the service
 * key, as an attacker holding it would act (see `serviceRest`). The catalogue
 * half — the triggers present, ENABLE ALWAYS and unaltered, the CHECKs' md5
 * pins — is `runtime-role.int.spec.ts`'s, through `checkIntegrityTriggers`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTIVITY_VALUE_MAX } from '@tonyai/shared-types';
import { ActivityRecordStatus, Prisma } from '@tonyai/db';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { connect, connectOwner, createTenant, recordInput, refusal, serviceRest, withRollback, type Tenant } from './db';

let runtime: PrismaService;
let owner: PrismaService;
let tenant: Tenant;
let siteId: string;

beforeAll(async () => {
  runtime = connect();
  owner = connectOwner();
  tenant = await createTenant();
  siteId = (await owner.location.create({ data: { subsidiaryId: tenant.subsidiaryId, name: 'Int-test geography site', geographyCode: 'UK' } })).id;
});

afterAll(async () => {
  await tenant?.cleanup();
  await runtime?.$disconnect();
  await owner?.$disconnect();
});

/** The SQLSTATE behind a Prisma error: a raw query's P2010 `meta.code`, or the code in an unknown request error's text. */
function sqlstateOf(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return (e.meta as { code?: string } | undefined)?.code ?? e.code;
  }
  return /code: "([0-9A-Z]{5})"/.exec(String((e as Error | null)?.message))?.[1] ?? null;
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

/** A draft row as a direct client would POST it (the slot is the test's own). */
function draftRow(id: string, periodValue: string) {
  return {
    id, subsidiary_id: tenant.subsidiaryId, reporting_year: 2026, reporting_period: 'monthly', period_value: periodValue,
    category: 'Electricity', scope: 2, activity_value: 99, activity_unit: 'kWh', calculation: { tCo2e: 9, factorId: 'forged' },
    created_by: tenant.users.dataEntry.id, updated_at: new Date().toISOString(), status: 'draft',
  };
}

describe("LP4-02 (29) — a record is the API's to insert", () => {
  it('refuses the service role a NEW draft POSTed straight in (TA006) — its inputs are whatever the key holder says', async () => {
    const id = randomUUID();
    expect(await refusal(await serviceRest('POST', 'activity_records', draftRow(id, 'January')))).toEqual({ ok: false, code: 'TA006' });
    expect(await owner.activityRecord.count({ where: { id } })).toBe(0);
  });

  it('answers a committed status first (TA005) — the born-a-draft rule — and then who inserts (TA006)', async () => {
    const id = randomUUID();
    expect(await refusal(await serviceRest('POST', 'activity_records', { ...draftRow(id, 'February'), status: 'approved' }))).toEqual({ ok: false, code: 'TA005' });
    expect(await owner.activityRecord.count({ where: { id } })).toBe(0);
  });

  it("lets the API's login and the owner insert a draft (the API's create; a fixture)", async () => {
    for (const client of [runtime, owner]) {
      const created = await withRollback(client, (tx) => tx.activityRecord.create({ data: recordInput(tenant, { periodValue: 'March' }) }));
      expect(created.status).toBe(ActivityRecordStatus.draft);
    }
  });
});

describe("LP4-02 (27) — a geography is the API's to change", () => {
  it("refuses the service role a subsidiary's new geography (TA015), and leaves it as it was", async () => {
    expect(await refusal(await serviceRest('PATCH', `subsidiaries?id=eq.${tenant.subsidiaryId}`, { geography_code: 'TR' }))).toEqual({ ok: false, code: 'TA015' });
    expect((await owner.subsidiary.findUniqueOrThrow({ where: { id: tenant.subsidiaryId } })).geographyCode).toBe('UK');
  });

  it("refuses the service role a site's new geography (TA015), and leaves it as it was", async () => {
    expect(await refusal(await serviceRest('PATCH', `locations?id=eq.${siteId}`, { geography_code: 'TR' }))).toEqual({ ok: false, code: 'TA015' });
    expect((await owner.location.findUniqueOrThrow({ where: { id: siteId } })).geographyCode).toBe('UK');
  });

  it('compares the value, not the column: the same geography written again is no change', async () => {
    expect((await serviceRest('PATCH', `subsidiaries?id=eq.${tenant.subsidiaryId}`, { geography_code: 'UK' })).ok).toBe(true);
    expect((await serviceRest('PATCH', `locations?id=eq.${siteId}`, { geography_code: 'UK' })).ok).toBe(true);
  });

  it("lets the API's login and the owner change either (the API's audited update; the operator)", async () => {
    for (const client of [runtime, owner]) {
      const changed = await withRollback(client, async (tx) => [
        (await tx.subsidiary.update({ where: { id: tenant.subsidiaryId }, data: { geographyCode: 'TR' } })).geographyCode,
        (await tx.location.update({ where: { id: siteId }, data: { geographyCode: 'TR' } })).geographyCode,
      ]);
      expect(changed).toEqual(['TR', 'TR']);
    }
  });
});

describe('LP4-02 (33) — what a record says, at the door, for every writer', () => {
  it.each([
    ['a scope that is not its category\'s', { category: 'Electricity', scope: 1 }, 'activity_records_scope_check'],
    ['a Scope 3 category filed under Scope 1', { category: 'Waste', scope: 1, activityUnit: 'kg' }, 'activity_records_scope_check'],
    ['a category the map does not name', { category: 'Vibes', scope: 1 }, 'activity_records_scope_check'],
    ['a month spelled other than canonically', { periodValue: 'january' }, 'activity_records_period_value_check'],
    ["a quarter under the monthly granularity", { periodValue: 'Q1' }, 'activity_records_period_value_check'],
    ['a quarter that does not exist', { reportingPeriod: 'quarterly', periodValue: 'Q5' }, 'activity_records_period_value_check'],
    ['the year as an annual period value', { reportingPeriod: 'annual', periodValue: '2026' }, 'activity_records_period_value_check'],
    ['a granularity the CHECK does not name', { reportingPeriod: 'weekly', periodValue: 'January' }, 'activity_records_period_value_check'],
    ['a negative activity value', { activityValue: -1 }, 'activity_records_activity_value_check'],
    ['an activity value past ACTIVITY_VALUE_MAX', { activityValue: ACTIVITY_VALUE_MAX + 1 }, 'activity_records_activity_value_check'],
  ] as [string, Partial<Prisma.ActivityRecordUncheckedCreateInput>, string][])('refuses the owner %s (23514)', async (_label, data, constraint) => {
    const e = await failure(withRollback(owner, (tx) => tx.activityRecord.create({ data: recordInput(tenant, { periodValue: 'April', ...data }) })));
    expect(sqlstateOf(e)).toBe('23514');
    expect(String((e as Error).message)).toContain(constraint);
  });

  it.each([['NaN'], ['Infinity'], ['-Infinity']])('refuses an activity value of %s, which float8 holds and no reading is (23514)', async (value) => {
    const e = await failure(
      withRollback(owner, async (tx) => {
        const rec = await tx.activityRecord.create({ data: recordInput(tenant, { periodValue: 'May' }) });
        await tx.$executeRawUnsafe(`UPDATE "activity_records" SET "activity_value" = '${value}'::double precision WHERE "id" = $1::uuid`, rec.id);
      }),
    );
    expect(sqlstateOf(e)).toBe('23514');
    expect(String((e as Error).message)).toContain('activity_records_activity_value_check');
  });

  it("refuses the API's login too — and an update as surely as an insert", async () => {
    const e = await failure(withRollback(runtime, (tx) => tx.activityRecord.create({ data: recordInput(tenant, { periodValue: 'June', scope: 3 }) })));
    expect(sqlstateOf(e)).toBe('23514');
    const moved = await failure(
      withRollback(runtime, async (tx) => {
        const rec = await tx.activityRecord.create({ data: recordInput(tenant, { periodValue: 'June' }) });
        await tx.activityRecord.update({ where: { id: rec.id }, data: { category: 'Natural Gas' } }); // scope left at 2
      }),
    );
    expect(sqlstateOf(moved)).toBe('23514');
    expect(String((moved as Error).message)).toContain('activity_records_scope_check');
  });

  it('accepts every canonical token of every granularity, and both bounds of the value', async () => {
    const accepted = await withRollback(owner, async (tx) => {
      const before = await tx.activityRecord.count({ where: { subsidiaryId: tenant.subsidiaryId } });
      const rows = [
        ...['January', 'December'].map((periodValue) => ({ periodValue })),
        ...['Q1', 'Q4'].map((periodValue) => ({ reportingPeriod: 'quarterly', periodValue })),
        { reportingPeriod: 'annual', periodValue: 'Annual' },
      ];
      for (const [i, row] of rows.entries()) {
        await tx.activityRecord.create({ data: recordInput(tenant, { ...row, activityValue: i % 2 === 0 ? 0 : ACTIVITY_VALUE_MAX }) });
      }
      // And a Scope 1 and a Scope 3 category under their own scopes.
      await tx.activityRecord.create({ data: recordInput(tenant, { periodValue: 'July', category: 'Natural Gas' }) });
      await tx.activityRecord.create({ data: recordInput(tenant, { periodValue: 'July', category: 'Waste', activityUnit: 'kg' }) });
      return (await tx.activityRecord.count({ where: { subsidiaryId: tenant.subsidiaryId } })) - before;
    });
    expect(accepted).toBe(7);
  });
});

describe('LP4-02 (D3) — a record\'s parameters', () => {
  const gas = (parameters: unknown, periodValue = 'August') =>
    recordInput(tenant, { category: 'Natural Gas', periodValue, parameters: parameters as Prisma.InputJsonValue });
  const refrigerant = (parameters: unknown) =>
    recordInput(tenant, {
      category: 'Refrigerants', activityType: 'R-32', activityUnit: 'kg', periodValue: 'August',
      parameters: parameters as Prisma.InputJsonValue,
    });
  const line = (over: Record<string, unknown> = {}) => ({
    equipmentType: 'chiller', capacityKg: 10, refillKg: 0, leakRateChoice: 'alternative', ...over,
  });
  const equipment = (...lines: unknown[]) => refrigerant({ equipment: lines });

  it.each([
    ['both calorific values', () => gas({ ncvKcalPerSm3: 8250, billedGcvKcalPerSm3: 9155 })],
    ['a zero NCV', () => gas({ ncvKcalPerSm3: 0 })],
    ['a negative correction factor', () => gas({ volumeCorrectionFactor: -1 })],
    ['a calorific value as text', () => gas({ ncvKcalPerSm3: '8250' })],
    ['a key the category does not define', () => gas({ ncvKcalPerSm3: 8250, gwp: 1 })],
    ['an array', () => gas([])],
    ['a JSON scalar', () => gas(1)],
    ['a key beside the list', () => refrigerant({ equipment: [line()], installedCapacityKg: 10 })],
    ['the old flat shape', () => refrigerant(line())],
    ['no list', () => refrigerant({})],
    ['a list that is no array', () => refrigerant({ equipment: line() })],
    ['an empty list', () => equipment()],
    ['a line that is no object', () => equipment('chiller')],
    ['a line missing a field', () => equipment({ equipmentType: 'chiller', capacityKg: 1, refillKg: 1 })],
    ['a JSON-null field', () => equipment(line({ leakRateChoice: null }))],
    ['a capacity as text', () => equipment(line({ capacityKg: '10' }))],
    ['an unknown equipment type', () => equipment(line({ equipmentType: 'kettle' }))],
    ['a negative refill', () => equipment(line({ refillKg: -1 }))],
    ['neither capacity nor refill', () => equipment(line({ capacityKg: 0 }))],
    ['the alternative rate where none is defined', () => equipment(line({ equipmentType: 'refrigerator' }))],
    ['a key the line does not define', () => equipment(line({ gwp: 1 }))],
    ['a repeated equipment type', () => equipment(line(), line())],
    ['a nested list, which lax jsonpath would unwrap', () => equipment([line()])],
    ['a nested list hiding a bad line', () => equipment([line(), { equipmentType: 'evil', capacityKg: 'x' }])],
    ['an array as the equipment type', () => equipment(line({ equipmentType: ['chiller', 'evil'] }))],
    ['an array as the rate choice, which would read as the alternative', () => equipment(line({ leakRateChoice: ['default'] }))],
    ['a capacity past the activity value bound', () => equipment(line({ capacityKg: 1e13 }))],
    ['a refill past the activity value bound', () => equipment(line({ refillKg: 1e13 }))],
    ["another category's fields", () => refrigerant({ ncvKcalPerSm3: 8250 })],
    ['parameters on a category that takes none', () => recordInput(tenant, { periodValue: 'August', parameters: { ncvKcalPerSm3: 1 } })],
  ])('refuses %s, as the owner too (23514)', async (_what, data) => {
    const e = await failure(withRollback(owner, (tx) => tx.activityRecord.create({ data: data() })));
    expect(sqlstateOf(e)).toBe('23514');
    expect(String((e as Error).message)).toContain('activity_records_parameters_check');
  });

  it.each(['{"ncvKcalPerSm3": 1e400}', '{"ncvKcalPerSm3": 1e-400}', '{"volumeCorrectionFactor": 1e400}'])(
    'refuses %s, which JSON holds but a double cannot',
    async (parameters) => {
      const e = await failure(withRollback(owner, async (tx) => {
        const rec = await tx.activityRecord.create({ data: gas({}, 'August') });
        await tx.$executeRawUnsafe(`UPDATE "activity_records" SET "parameters" = '${parameters}'::jsonb WHERE "id" = '${rec.id}'`);
      }));
      expect(String((e as Error).message)).toContain('23514');
    },
  );

  it('accepts each category\'s valid shape, and no parameters at all', async () => {
    const accepted = await withRollback(owner, async (tx) => {
      await tx.activityRecord.create({ data: gas({ ncvKcalPerSm3: 8100, volumeCorrectionFactor: 0.97 }, 'August') });
      await tx.activityRecord.create({ data: gas({ billedGcvKcalPerSm3: 9000, ncvKcalPerSm3: null }, 'September') });
      await tx.activityRecord.create({ data: gas({}, 'October') });
      await tx.activityRecord.create({ data: equipment(line(), line({ equipmentType: 'refrigerator', capacityKg: 0, refillKg: 2, leakRateChoice: 'default' })) });
      await tx.activityRecord.create({ data: recordInput(tenant, { periodValue: 'August' }) });
      return tx.activityRecord.count({ where: { subsidiaryId: tenant.subsidiaryId, periodValue: { in: ['August', 'September', 'October'] } } });
    });
    expect(accepted).toBe(5);
  });

  it('freezes them with the other inputs once a record is committed (TA001), the owner included', async () => {
    const e = await failure(
      withRollback(owner, async (tx) => {
        const rec = await tx.activityRecord.create({ data: gas({ ncvKcalPerSm3: 8100 }) });
        await tx.activityRecord.update({ where: { id: rec.id }, data: { status: ActivityRecordStatus.submitted } });
        await tx.activityRecord.update({ where: { id: rec.id }, data: { parameters: { ncvKcalPerSm3: 9000 } } });
      }),
    );
    expect(sqlstateOf(e)).toBe('TA001');
  });

  it('lets only the API change them on a draft: the service role is refused (TA006)', async () => {
    const rec = await owner.activityRecord.create({ data: gas({ ncvKcalPerSm3: 8100 }, 'November') });
    try {
      expect(await refusal(await serviceRest('PATCH', `activity_records?id=eq.${rec.id}`, { parameters: { ncvKcalPerSm3: 9000 } })))
        .toEqual({ ok: false, code: 'TA006' });
      expect((await owner.activityRecord.findUniqueOrThrow({ where: { id: rec.id } })).parameters).toEqual({ ncvKcalPerSm3: 8100 });
      await runtime.activityRecord.update({ where: { id: rec.id }, data: { parameters: { ncvKcalPerSm3: 9000 } } });
      expect((await owner.activityRecord.findUniqueOrThrow({ where: { id: rec.id } })).parameters).toEqual({ ncvKcalPerSm3: 9000 });
    } finally {
      await owner.activityRecord.delete({ where: { id: rec.id } });
    }
  });
});
