import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityRecordStatus, Prisma } from '@tonyai/db';
import { NotFoundException } from '@nestjs/common';
import { ActivityTypeSlotConflictError, recordTriggerCode } from '../../src/activity-records/errors';
import { CalculationsService } from '../../src/calculations/calculations.service';
import { NoEmissionFactorError } from '../../src/calculations/errors';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { backendPid, connect, connectOwner, createRecord, createTenant, deferred, settledOrBlocked, withRollback, type Tenant } from './db';
import { INT_FACTOR_POLICY, lifecycleServices } from './services';

/**
 * LP3-03 PR B against real PostgreSQL: the K5 snapshot trigger, the slot-kind
 * trigger and its lock, the append-only factor library, and the engine reading
 * the seed's placeholder library — on the runtime role the API uses, and on
 * the owner where the rule must hold for every writer.
 */

let runtime: PrismaService;
let owner: PrismaService;
let tenant: Tenant;
let foreign: Tenant;

beforeAll(async () => {
  runtime = connect(2);
  owner = connectOwner(2);
  tenant = await createTenant();
  foreign = await createTenant();
});

afterAll(async () => {
  await tenant?.cleanup();
  await foreign?.cleanup();
  await runtime?.$disconnect();
  await owner?.$disconnect();
});

/** The settled rejection of `p`, or null if it resolved. */
async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

/** The SQLSTATE behind a Prisma error: a raw query's P2010 `meta.code`, or the code in an unknown request error's text. */
function sqlstateOf(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return (e.meta as { code?: string } | undefined)?.code ?? e.code;
  }
  return /code: "([0-9A-Z]{5})"/.exec(String((e as Error | null)?.message))?.[1] ?? null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let month = 0;
/** A fresh monthly slot of the tenant, so no two records here share one. */
const nextSlot = () => ({ reportingYear: 2026, reportingPeriod: 'monthly', periodValue: MONTHS[month++ % 12] });

describe('K5 — a snapshot that has left draft never changes', () => {
  it.each([
    ActivityRecordStatus.submitted,
    ActivityRecordStatus.approved,
    ActivityRecordStatus.locked,
    ActivityRecordStatus.voided,
  ])('refuses the runtime role and the owner on a %s record — the snapshot and its inputs', async (status) => {
    const rec = await createRecord(owner, tenant, { ...nextSlot(), status });
    for (const client of [runtime, owner]) {
      for (const data of [
        { calculation: { tCo2e: 999, factorId: 'forged' } },
        { activityValue: 1 },
        { activityUnit: 'MWh' },
        { category: 'Natural Gas' },
        { activityType: 'diesel' },
        { reportingYear: 2025 },
      ] as Prisma.ActivityRecordUpdateInput[]) {
        const e = await failure(client.activityRecord.update({ where: { id: rec.id }, data }));
        expect(sqlstateOf(e), JSON.stringify(data)).toBe('TA001');
        // The service's own mapping reads the real error, not a fixture of it.
        expect(recordTriggerCode(e)).toBe('TA001');
      }
    }
    // What the lifecycle legitimately writes on such a row still lands.
    await runtime.activityRecord.update({
      where: { id: rec.id },
      data: { anomalyFlag: true, anomalyBaselinePriorCount: 3, anomalyBaselineTCo2e: 1.5 },
    });
  });

  it('lets draft and rejected records be recalculated, and status-only transitions through', async () => {
    for (const status of [ActivityRecordStatus.draft, ActivityRecordStatus.rejected]) {
      const rec = await createRecord(owner, tenant, { ...nextSlot(), status });
      await runtime.activityRecord.update({
        where: { id: rec.id },
        data: { activityValue: 5, calculation: { tCo2e: 1, factorId: 'recomputed' } },
      });
    }
    const approved = await createRecord(owner, tenant, { ...nextSlot(), status: ActivityRecordStatus.approved });
    // The period lock's bulk lock and unlock, then a void — status only.
    await runtime.activityRecord.updateMany({ where: { id: approved.id }, data: { status: ActivityRecordStatus.locked } });
    await runtime.activityRecord.updateMany({ where: { id: approved.id }, data: { status: ActivityRecordStatus.approved } });
    await runtime.activityRecord.update({
      where: { id: approved.id },
      data: { status: ActivityRecordStatus.voided, voidReason: 'int test', voidedBy: tenant.users.superAdmin.id, voidedAt: new Date() },
    });
  });

  it('refuses re-pointing an approved record at another site, but lets its site be deleted (ON DELETE SET NULL)', async () => {
    const [siteA, siteB] = await Promise.all(
      ['A', 'B'].map((n) => owner.location.create({ data: { subsidiaryId: tenant.subsidiaryId, name: `Int-test K5 site ${n}`, geographyCode: 'UK' } })),
    );
    const rec = await createRecord(owner, tenant, { ...nextSlot(), locationId: siteA.id, status: ActivityRecordStatus.approved });
    expect(sqlstateOf(await failure(runtime.activityRecord.update({ where: { id: rec.id }, data: { locationId: siteB.id } })))).toBe('TA001');
    await owner.location.delete({ where: { id: siteA.id } });
    expect((await owner.activityRecord.findUniqueOrThrow({ where: { id: rec.id } })).locationId).toBeNull();
    await owner.location.delete({ where: { id: siteB.id } });
  });
});

describe('a slot holds typed records or one untyped record, never both', () => {
  const fuel = { category: 'Fuel', scope: 1, activityUnit: 'litres' };

  it('refuses either order, for the runtime role and the owner, while two types share a slot', async () => {
    const untypedFirst = nextSlot();
    await createRecord(owner, tenant, { ...untypedFirst, ...fuel });
    for (const client of [runtime, owner]) {
      expect(sqlstateOf(await failure(createRecord(client, tenant, { ...untypedFirst, ...fuel, activityType: 'diesel' })))).toBe('TA002');
    }

    const typedFirst = nextSlot();
    await createRecord(owner, tenant, { ...typedFirst, ...fuel, activityType: 'diesel' });
    await createRecord(runtime, tenant, { ...typedFirst, ...fuel, activityType: 'gas_oil' });
    expect(sqlstateOf(await failure(createRecord(runtime, tenant, { ...typedFirst, ...fuel })))).toBe('TA002');
    // Moving an untyped record INTO the slot is the same refusal.
    const elsewhere = await createRecord(owner, tenant, { ...nextSlot(), ...fuel });
    expect(
      sqlstateOf(await failure(runtime.activityRecord.update({ where: { id: elsewhere.id }, data: { periodValue: typedFirst.periodValue } }))),
    ).toBe('TA002');
  });

  it('frees the slot when the other kind is voided', async () => {
    const slot = nextSlot();
    const legacy = await createRecord(owner, tenant, { ...slot, ...fuel, status: ActivityRecordStatus.voided });
    await createRecord(runtime, tenant, { ...slot, ...fuel, activityType: 'diesel' });
    expect(legacy.status).toBe(ActivityRecordStatus.voided);
  });

  it('serialises a concurrent typed and untyped insert: the second waits on the slot lock, then is refused', async () => {
    const slot = nextSlot();
    const a = connect(1);
    const b = connect(1);
    const observer = connectOwner(1);
    try {
      const inserted = deferred();
      const commit = deferred();
      const txA = a.$transaction(async (tx) => {
        await tx.activityRecord.create({
          data: {
            subsidiaryId: tenant.subsidiaryId, ...slot, ...fuel, activityType: 'diesel', activityValue: 1,
            calculation: { tCo2e: 0, factorId: 'int' }, createdBy: tenant.users.dataEntry.id,
          },
        });
        inserted.resolve();
        await commit.promise;
      });
      await inserted.promise;
      const pidB = await backendPid(b);
      const insertB = createRecord(b, tenant, { ...slot, ...fuel });
      // Without the advisory lock nothing would hold B: the unique index sees
      // NULL and 'diesel' as different keys, and B's check cannot see A's
      // uncommitted row.
      expect(await settledOrBlocked(insertB, pidB, observer)).toBe('blocked');
      commit.resolve();
      await txA;
      expect(sqlstateOf(await failure(insertB))).toBe('TA002');
    } finally {
      await Promise.all([a.$disconnect(), b.$disconnect(), observer.$disconnect()]);
    }
  });

  it('is answered by the record service with a 409 that names the problem', async () => {
    const slot = nextSlot();
    await createRecord(owner, tenant, { ...slot, ...fuel });
    const { records } = lifecycleServices(runtime);
    const e = await failure(
      records.create(tenant.users.dataEntry, {
        subsidiaryId: tenant.subsidiaryId,
        reportingYear: 2026,
        reportingPeriod: 'monthly',
        periodValue: slot.periodValue,
        category: 'Fuel',
        activityType: 'diesel',
        activityValue: 10,
        activityUnit: 'litres',
      }),
    );
    expect(e).toBeInstanceOf(ActivityTypeSlotConflictError);
  });
});

describe('the factor library is append-only, for the owner too', () => {
  async function seededFactor() {
    return owner.emissionFactor.findFirstOrThrow({
      where: { release: { status: 'placeholder' } },
      include: { release: true },
    });
  }

  it('refuses rewriting, deleting or truncating a loaded factor, conversion or release (TA010)', async () => {
    const factor = await seededFactor();
    const conversion = await owner.unitConversion.findFirstOrThrow();
    for (const sql of [
      `UPDATE emission_factors SET factor_value = 0 WHERE id = '${factor.id}'`,
      `DELETE FROM emission_factors WHERE id = '${factor.id}'`,
      `UPDATE unit_conversions SET multiplier = 1 WHERE id = '${conversion.id}'`,
      `DELETE FROM unit_conversions WHERE id = '${conversion.id}'`,
      `UPDATE factor_releases SET title = 'rewritten' WHERE id = '${factor.releaseId}'`,
      `DELETE FROM factor_releases WHERE id = '${factor.releaseId}'`,
      'TRUNCATE emission_factors',
      'TRUNCATE unit_conversions',
      'TRUNCATE factor_releases CASCADE',
    ]) {
      // Rolled back whatever happens: a regression must not take the library with it.
      const e = await failure(withRollback(owner, (tx) => tx.$executeRawUnsafe(sql)));
      expect(sqlstateOf(e), sql).toBe('TA010');
    }
  });

  it('accepts a withdrawal — status, who, when and why — and nothing else, once', async () => {
    const { releaseId } = await seededFactor();
    const withdraw = `UPDATE factor_releases SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = 'TonyAI test', withdrawal_reason = 'int test' WHERE id = '${releaseId}'`;
    await withRollback(owner, async (tx) => {
      expect(await tx.$executeRawUnsafe(withdraw)).toBe(1);
    });
    const attempts: Array<[string, string]> = [
      [`${withdraw.replace("status = 'withdrawn'", "status = 'withdrawn', title = 'x'")}`, 'TA010'],
      [`UPDATE factor_releases SET status = 'withdrawn' WHERE id = '${releaseId}'`, '23514'],
      [`UPDATE factor_releases SET status = 'authoritative' WHERE id = '${releaseId}'`, 'TA010'],
    ];
    for (const [sql, state] of attempts) {
      expect(sqlstateOf(await failure(withRollback(owner, (tx) => tx.$executeRawUnsafe(sql)))), sql).toBe(state);
    }
    // Withdrawn is final.
    const reverted = await failure(
      withRollback(owner, async (tx) => {
        await tx.$executeRawUnsafe(withdraw);
        await tx.$executeRawUnsafe(`UPDATE factor_releases SET status = 'placeholder', withdrawn_at = NULL, withdrawn_by = NULL, withdrawal_reason = NULL WHERE id = '${releaseId}'`);
      }),
    );
    expect(sqlstateOf(reverted)).toBe('TA010');
  });

  it('refuses a release out of order or loaded as withdrawn (TA011), and an unregistered publisher or unsourced authority (CHECK)', async () => {
    const insert = (publisher: string, ordinal: number, status: string, extra = '') =>
      `INSERT INTO factor_releases (id, publisher, title, edition, ordinal, status${extra ? ', source_url, licence, published_at, reviewed_by, reviewed_at' : ''})
       VALUES ('${randomUUID()}', '${publisher}', 'Int test', 'int-${randomUUID()}', ${ordinal}, '${status}'${extra})`;
    const states = async (...sql: string[]) =>
      sqlstateOf(await failure(withRollback(owner, async (tx) => { for (const s of sql) await tx.$executeRawUnsafe(s); })));
    expect(await states(insert('TonyAI test fixture', 900_005, 'fixture'), insert('TonyAI test fixture', 900_003, 'fixture'))).toBe('TA011');
    expect(await states(insert('TonyAI test fixture', 900_007, 'withdrawn'))).toBe('TA011');
    // A look-alike of a registered name is not a second publisher.
    expect(await states(insert('TonyAI prototype ', 999_999, 'placeholder'))).toBe('23514');
    expect(await states(insert('DESNZ', 1, 'authoritative'))).toBe('23514');
    // Not even the internal publishers may load an authoritative release.
    expect(
      await states(insert('TonyAI prototype', 999_999, 'authoritative', `, 'https://www.gov.uk/x', 'OGL', '2026-01-01', 'Reviewer firm', '2026-02-01'`)),
    ).toBe('23514');
  });

  it('refuses an unspecified row under an authoritative release (TA012) — the trigger, past the registry', async () => {
    const releaseId = randomUUID();
    const e = await failure(
      withRollback(owner, async (tx) => {
        // Only inside this rolled-back transaction: lift the registry so an
        // authoritative release can exist, to reach the row trigger behind it.
        await tx.$executeRawUnsafe('ALTER TABLE factor_releases DROP CONSTRAINT factor_releases_publisher_check');
        await tx.$executeRawUnsafe(
          `INSERT INTO factor_releases (id, publisher, title, edition, ordinal, status, source_url, licence, published_at, reviewed_by, reviewed_at)
           VALUES ('${releaseId}', 'DESNZ', 'Conversion factors', '2026', 1, 'authoritative', 'https://www.gov.uk/x', 'OGL v3.0', '2026-06-10', 'Reviewer firm', '2026-06-20')`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO emission_factors (id, release_id, category, activity_type, gas, gas_coverage, geography_code, reporting_year, data_year, scope, scope2_method, calorific_basis, factor_value, factor_unit, normalized_unit, methodology, source, version, updated_at)
           VALUES (gen_random_uuid(), '${releaseId}', 'Fuel', 'unspecified', 'CO2e', 'all_ghg', 'UK', 2031, 2031, 1, 'not_applicable', 'not_applicable', 2.5, 'kgCO2e/L', 'litres', 'x', 'x', '2026', now())`,
        );
      }),
    );
    expect(sqlstateOf(e)).toBe('TA012');
  });
});

describe('the engine on the real library', () => {
  it('prices metered m³ of natural gas through the seed\'s 11.36 placeholder conversion row (K4)', async () => {
    const engine = new CalculationsService(runtime, INT_FACTOR_POLICY);
    const result = await engine.compute({ category: 'Natural Gas', geographyCode: 'UK', reportingYear: 2026, value: 100, unit: 'cubic_metres' });
    expect(result).toMatchObject({
      snapshotSchema: 2,
      normalizedUnit: 'kWh',
      conversionApplied: true,
      conversionFactor: 11.36,
      calorificBasis: 'gross',
      conversion: { fromUnit: 'cubic_metres', toUnit: 'kWh', multiplier: 11.36, release: { status: 'placeholder' } },
      factorRelease: { publisher: 'TonyAI prototype', status: 'placeholder' },
    });
    expect((result as { normalizedValue: number }).normalizedValue).toBeCloseTo(1136, 9);
  });

  it('refuses the same library where placeholders are refused, naming the gap and the lookup', async () => {
    const engine = new CalculationsService(runtime, Object.freeze({ allowPlaceholders: false }));
    const e = await failure(engine.compute({ category: 'Electricity', geographyCode: 'UK', reportingYear: 2026, value: 100, unit: 'kWh' }));
    expect(e).toBeInstanceOf(NoEmissionFactorError);
    expect((e as NoEmissionFactorError).getResponse()).toMatchObject({
      code: 'placeholder_refused',
      coverage: { category: 'Electricity', activityType: 'grid_electricity', geographyCode: 'UK', reportingYear: 2026, unit: 'kWh' },
    });
  });

  it("never applies another geography's or another year's conversion", async () => {
    // A fixture release of its own, committed so the runtime can read it,
    // removed in `finally` (fixture rows are the deletable ones).
    const [{ next }] = await owner.$queryRawUnsafe<{ next: number }[]>(
      `SELECT COALESCE(max(ordinal), 0) + 1 AS next FROM factor_releases WHERE publisher = 'TonyAI test fixture'`,
    );
    const release = await owner.factorRelease.create({
      data: { publisher: 'TonyAI test fixture', title: 'Int test', edition: `int-${randomUUID()}`, ordinal: Number(next), status: 'fixture' },
    });
    const conversion = (geographyCode: string, reportingYear: number) => ({
      releaseId: release.id, category: 'Natural Gas', activityType: 'natural_gas', geographyCode, reportingYear,
      dataYear: reportingYear, fromUnit: 'cubic_metres', toUnit: 'kWh', multiplier: 10, calorificBasis: 'gross', basis: 'int test',
    });
    try {
      await owner.emissionFactor.create({
        data: {
          releaseId: release.id, category: 'Natural Gas', activityType: 'natural_gas', gas: 'CO2e', gasCoverage: 'all_ghg',
          geographyCode: 'UK', reportingYear: 2031, dataYear: 2031, scope: 1, scope2Method: 'not_applicable', calorificBasis: 'gross',
          factorValue: 0.2, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'int test', source: 'int test', version: release.edition,
        },
      });
      await owner.unitConversion.createMany({ data: [conversion('TR', 2031), conversion('UK', 2030)] });
      const engine = new CalculationsService(runtime, INT_FACTOR_POLICY);
      const input = { category: 'Natural Gas', geographyCode: 'UK', reportingYear: 2031, value: 100, unit: 'cubic_metres' };
      expect(await failure(engine.compute(input))).toMatchObject({ code: 'no_conversion' });
      // Positive control: the matching conversion prices it.
      await owner.unitConversion.create({ data: conversion('UK', 2031) });
      expect(await engine.compute(input)).toMatchObject({ normalizedValue: 1000, kgCo2e: 200 });
    } finally {
      await owner.unitConversion.deleteMany({ where: { releaseId: release.id } });
      await owner.emissionFactor.deleteMany({ where: { releaseId: release.id } });
      await owner.factorRelease.delete({ where: { id: release.id } });
    }
  });

  it('answers a foreign subsidiary with the plain 404 — nothing about the factor library', async () => {
    const { records } = lifecycleServices(runtime);
    const dto = {
      subsidiaryId: tenant.subsidiaryId,
      reportingYear: 2031,
      reportingPeriod: 'monthly' as const,
      periodValue: 'January',
      category: 'Electricity' as const,
      activityValue: 1,
      activityUnit: 'kWh',
    };
    const foreignAnswer = await failure(records.previewCreate(foreign.users.superAdmin, dto));
    expect(foreignAnswer).toBeInstanceOf(NotFoundException);
    expect(foreignAnswer).not.toBeInstanceOf(NoEmissionFactorError);
    expect((foreignAnswer as NotFoundException).getResponse()).not.toHaveProperty('coverage');
    expect((foreignAnswer as NotFoundException).getResponse()).not.toHaveProperty('code');
    // Positive control: the tenant's own administrator learns the gap.
    const ownAnswer = await failure(records.previewCreate(tenant.users.superAdmin, dto));
    expect((ownAnswer as NoEmissionFactorError).getResponse()).toMatchObject({ code: 'no_factor', coverage: { reportingYear: 2031 } });
  });
});
