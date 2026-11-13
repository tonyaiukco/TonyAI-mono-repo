import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecordStatus } from '@tonyai/db';
import { VarianceReasonRequiredError } from '../../src/activity-records/errors';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { attachEvidence, connect, connectOwner, createTenant, type Tenant } from './db';
import { lifecycleServices } from './services';
import { loadTrReleases } from './tr-releases';

/**
 * The first-period typo ceiling (BUG-R2-07 tier 3; Decisions 2026-11-12;
 * OpenSpec `uat2-anomaly-typo-ceiling`) against real PostgreSQL and the TR
 * factor package: a first period above its ceiling is stored flagged with no
 * earlier period, refused at submit until explained, and named as a ceiling
 * refusal; a refrigerant record is judged line by line; marine gas oil has
 * its own ceiling.
 */

let runtime: PrismaService;
let owner: PrismaService;
let tenant: Tenant;
let s: ReturnType<typeof lifecycleServices>;

beforeAll(async () => {
  await loadTrReleases();
  runtime = connect();
  owner = connectOwner();
  s = lifecycleServices(runtime);
}, 120_000);

afterAll(async () => {
  await runtime.$disconnect();
  await owner.$disconnect();
});

beforeEach(async () => {
  tenant = await createTenant();
});

afterEach(async () => {
  await tenant?.cleanup();
});

/** A first period on its own new TR site, created through the API's own path. */
async function firstPeriod(body: Record<string, unknown>) {
  const site = await owner.location.create({
    data: { subsidiaryId: tenant.subsidiaryId, name: `R2-07 ceiling ${randomUUID().slice(0, 8)}`, geographyCode: 'TR' },
  });
  const record = await s.records.create(tenant.users.dataEntry, {
    subsidiaryId: tenant.subsidiaryId,
    locationId: site.id,
    reportingYear: 2025,
    ...body,
  } as never);
  // Every Scope 1–2 category needs a file before submit (K3); attached so the
  // only gate left is the anomaly one.
  await attachEvidence(runtime, tenant, [record.id]);
  return record;
}

async function stored(id: string) {
  return runtime.activityRecord.findUniqueOrThrow({
    where: { id },
    select: { status: true, anomalyFlag: true, anomalyBaselinePriorCount: true, anomalyBaselineTCo2e: true },
  });
}

const refrigerant = (...capacities: number[]) => ({
  reportingPeriod: 'annual',
  periodValue: 'Annual',
  category: 'Refrigerants',
  activityType: 'HFC-227ea',
  activityValue: capacities.reduce((a, b) => a + b, 0),
  activityUnit: 'kg',
  parameters: {
    equipment: capacities.map((capacityKg, i) => ({
      // One line per equipment type (D3), so each capacity gets its own type.
      equipmentType: ['fire_suppression_system', 'fire_extinguisher', 'chiller'][i],
      capacityKg,
      refillKg: 0,
      leakRateChoice: 'default',
    })),
  },
});

describe('the first-period typo ceiling', () => {
  it('flags a first electricity month above 1,000,000 kWh and gates its submit on a reason', async () => {
    const record = await firstPeriod({
      reportingPeriod: 'monthly',
      periodValue: 'January',
      category: 'Electricity',
      activityValue: 4_500_000,
      activityUnit: 'kWh',
    });
    expect(await stored(record.id)).toEqual({
      status: ActivityRecordStatus.draft,
      anomalyFlag: true,
      anomalyBaselinePriorCount: 0,
      anomalyBaselineTCo2e: null,
    });

    const auditBefore = await owner.auditLog.count({ where: { entityId: record.id } });
    const refusal = await s.records.submit(tenant.users.dataEntry, record.id).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(VarianceReasonRequiredError);
    expect((refusal as VarianceReasonRequiredError).getResponse()).toMatchObject({
      code: 'variance_reason_required',
      params: { basis: 'ceiling' },
    });
    expect((await stored(record.id)).status).toBe(ActivityRecordStatus.draft);
    expect(await owner.auditLog.count({ where: { entityId: record.id } })).toBe(auditBefore);

    await runtime.activityRecord.update({
      where: { id: record.id },
      data: { varianceReason: 'New plant; read checked against the meter' },
    });
    await s.records.submit(tenant.users.dataEntry, record.id);
    expect(await stored(record.id)).toEqual({
      status: ActivityRecordStatus.submitted,
      anomalyFlag: true,
      anomalyBaselinePriorCount: 0,
      anomalyBaselineTCo2e: null,
    });
  });

  it('leaves a first electricity month at its ceiling unflagged and submittable', async () => {
    const record = await firstPeriod({
      reportingPeriod: 'monthly',
      periodValue: 'January',
      category: 'Electricity',
      activityValue: 1_000_000,
      activityUnit: 'kWh',
    });
    await s.records.submit(tenant.users.dataEntry, record.id);
    expect(await stored(record.id)).toMatchObject({
      status: ActivityRecordStatus.submitted,
      anomalyFlag: false,
      anomalyBaselinePriorCount: 0,
    });
  });

  it('flags a refrigerant record with one 650 kg line, not one of three small lines', async () => {
    const big = await firstPeriod(refrigerant(120, 650));
    expect((await stored(big.id)).anomalyFlag).toBe(true);

    const small = await firstPeriod(refrigerant(200, 200, 200)); // 600 kg in total
    expect((await stored(small.id)).anomalyFlag).toBe(false);
  });

  it('flags a refill with an extra zero and refuses its submit, but not a refill of exactly 125%', async () => {
    const refill = (capacityKg: number, refillKg: number) => ({
      reportingPeriod: 'annual',
      periodValue: 'Annual',
      category: 'Refrigerants',
      activityType: 'HFC-227ea',
      activityValue: capacityKg,
      activityUnit: 'kg',
      parameters: {
        equipment: [{ equipmentType: 'fire_suppression_system', capacityKg, refillKg, leakRateChoice: 'default' }],
      },
    });
    const typo = await firstPeriod(refill(10, 50_000));
    expect(await stored(typo.id)).toMatchObject({ anomalyFlag: true, anomalyBaselinePriorCount: 0 });
    const refusal = await s.records.submit(tenant.users.dataEntry, typo.id).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(VarianceReasonRequiredError);
    expect((refusal as VarianceReasonRequiredError).getResponse()).toMatchObject({ params: { basis: 'ceiling' } });

    const atRatio = await firstPeriod(refill(40, 50));
    expect((await stored(atRatio.id)).anomalyFlag).toBe(false);
  });

  it('holds marine gas oil to 1,000 t, not to the 100,000 kg Mobile Combustion row', async () => {
    const mgo = (activityValue: number, activityUnit: string) => ({
      reportingPeriod: 'monthly',
      periodValue: 'January',
      category: 'Mobile Combustion',
      activityType: 'marine_gas_oil',
      activityValue,
      activityUnit,
    });
    const bunkering = await firstPeriod(mgo(400_000, 'kg'));
    expect((await stored(bunkering.id)).anomalyFlag).toBe(false);

    const typo = await firstPeriod(mgo(1_200, 'tonnes'));
    expect((await stored(typo.id)).anomalyFlag).toBe(true);
  });
});
