import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecordStatus, type Prisma } from '@tonyai/db';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  CEILING_UNIT_MULTIPLIERS as CONTRACT_MULTIPLIERS,
  FIRST_PERIOD_CEILINGS as CONTRACT_CEILINGS,
  MARINE_GAS_OIL_ACTIVITY_TYPE as CONTRACT_MGO_TYPE,
  MARINE_GAS_OIL_CEILING_KG as CONTRACT_MGO_KG,
  REFRIGERANT_LINE_CEILING_KG as CONTRACT_LINE_KG,
  REFRIGERANT_REFILL_RATIO as CONTRACT_REFILL_RATIO,
  REFILL_CEILING_TOLERANCE as CONTRACT_REFILL_TOLERANCE,
} from '@tonyai/shared-types';
import {
  BASE_SQL,
  CEILING_UNIT_MULTIPLIERS,
  DRIFT_WHERE,
  FIRST_PERIOD_CEILINGS,
  LEGACY_WHERE,
  MARINE_GAS_OIL_ACTIVITY_TYPE,
  MARINE_GAS_OIL_CEILING_KG,
  PRE_CEILING_WHERE,
  REFRIGERANT_LINE_CEILING_KG,
  REFRIGERANT_REFILL_RATIO,
  REFILL_CEILING_TOLERANCE,
} from '../../../../packages/db/scripts/anomaly-probe.lib.mjs';
import { connect, createRecord, createTenant, type Tenant } from './db';

/**
 * `pnpm anomaly:probe` against real PostgreSQL: the SQL the script runs, over
 * rows built to be right or wrong in one known way each.
 *
 * The probe is the independent check on stored anomaly verdicts, and until
 * 2026-11-11 nothing ran its SQL in a test. A review then found a broken
 * verdict it reported as clean: flagged on one earlier period with no stored
 * average. The rule says "flagged" for that record too, so a comparison of the
 * flag alone passed it. This pins the drift query on that row and on its
 * neighbours.
 *
 * Each case is its own series (a category of its own): January approved at
 * 10 tCO2e, then February with the stored verdict under test.
 */

let runtime: PrismaService;
let tenant: Tenant;

beforeAll(() => {
  runtime = connect();
});

afterAll(async () => {
  await runtime.$disconnect();
});

beforeEach(async () => {
  tenant = await createTenant();
});

afterEach(async () => {
  await tenant?.cleanup();
});

type Stored = Pick<
  Prisma.ActivityRecordUncheckedCreateInput,
  'anomalyFlag' | 'anomalyBaselinePriorCount' | 'anomalyBaselineTCo2e'
>;

/** January at 10 tCO2e, correctly stored as the first of its series, then
 *  February at `tCo2e` carrying `stored`. Returns February's id. */
async function series(category: string, activityUnit: string, tCo2e: number, stored: Stored): Promise<string> {
  const month = (periodValue: string, figure: number, verdict: Stored) =>
    createRecord(runtime, tenant, {
      category,
      activityUnit,
      periodValue,
      status: ActivityRecordStatus.approved,
      calculation: { tCo2e: figure, factorId: 'int-test-placeholder' },
      ...verdict,
    });
  await month('January', 10, { anomalyFlag: false, anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null });
  return (await month('February', tCo2e, stored)).id;
}

/** The ids the probe's own query selects, among this tenant's records. */
async function selected(where: string): Promise<string[]> {
  const rows = await runtime.$queryRawUnsafe<{ id: string }[]>(
    `${BASE_SQL}\nSELECT id FROM verdict WHERE ${where} AND subsidiary_id = $1::uuid`,
    tenant.subsidiaryId,
  );
  return rows.map((r) => r.id).sort();
}

describe('anomaly:probe — drift is the whole verdict, not the flag alone', () => {
  it('reports a broken verdict whose flag still agrees with the rule, and excuses only what it should', async () => {
    // Flagged on one earlier period with NO average: no version of the rule
    // wrote this. The rule flags it today as well (20 against 10), so the
    // flags agree — and the verdict is still wrong.
    const flaggedNoAverage = await series('Electricity', 'kWh', 20, {
      anomalyFlag: true,
      anomalyBaselinePriorCount: 1,
      anomalyBaselineTCo2e: null,
    });
    // The same record, stored as the rule stores it.
    const healthy = await series('Natural Gas', 'kWh', 20, {
      anomalyFlag: true,
      anomalyBaselinePriorCount: 1,
      anomalyBaselineTCo2e: 10,
    });
    // Scored before the short-history check: a count, no average, no flag.
    // Kept, although the rule would flag it today.
    const kept = await series('Water', 'm3', 20, {
      anomalyFlag: false,
      anomalyBaselinePriorCount: 1,
      anomalyBaselineTCo2e: null,
    });
    // Stored as "no earlier period" although January is there: the pool moved
    // without the flag changing (11 against 10 is within range).
    const staleCount = await series('Waste', 'tonnes', 11, {
      anomalyFlag: false,
      anomalyBaselinePriorCount: 0,
      anomalyBaselineTCo2e: null,
    });
    // The right count, the wrong average.
    const staleAverage = await series('Business Travel', 'km', 11, {
      anomalyFlag: false,
      anomalyBaselinePriorCount: 1,
      anomalyBaselineTCo2e: 15,
    });
    // A figure of its own and no stored count at all. The legacy test is NULL
    // for this row in SQL, and "NOT NULL" once dropped it from the report.
    const noCount = await series('Commuting', 'km', 20, {
      anomalyFlag: false,
      anomalyBaselinePriorCount: null,
      anomalyBaselineTCo2e: null,
    });
    // An average off by one part in 10^13: the gap between Postgres's avg()
    // and the API's fold, not a different figure.
    const withinTolerance = await series('Logistics', 'km', 11, {
      anomalyFlag: false,
      anomalyBaselinePriorCount: 1,
      anomalyBaselineTCo2e: 10.000000000001,
    });

    const drift = await selected(DRIFT_WHERE);
    expect(drift).toEqual([flaggedNoAverage, staleCount, staleAverage, noCount].sort());
    // Named one by one as well, so a failure says which row moved.
    expect(drift).toContain(flaggedNoAverage);
    expect(drift).not.toContain(healthy);
    expect(drift).not.toContain(kept);
    expect(drift).not.toContain(withinTolerance);

    expect(await selected(LEGACY_WHERE)).toEqual([kept]);
    // The kept verdict the rule would flag today is still found: section 2b
    // of the report is this query.
    expect(await selected(`${LEGACY_WHERE} AND anomaly_flag <> computed`)).toEqual([kept]);
  });

  it('finds nothing in a series stored the way the rule stores it', async () => {
    // Three earlier periods, then a clean and a flagged record on a full
    // window. Every count and average is what the rule computes.
    const month = (periodValue: string, tCo2e: number, verdict: Stored) =>
      createRecord(runtime, tenant, {
        periodValue,
        status: ActivityRecordStatus.approved,
        calculation: { tCo2e, factorId: 'int-test-placeholder' },
        ...verdict,
      });
    await month('January', 9, { anomalyFlag: false, anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null });
    await month('February', 10, { anomalyFlag: false, anomalyBaselinePriorCount: 1, anomalyBaselineTCo2e: 9 });
    await month('March', 11, { anomalyFlag: false, anomalyBaselinePriorCount: 2, anomalyBaselineTCo2e: 9.5 });
    await month('April', 12, { anomalyFlag: false, anomalyBaselinePriorCount: 3, anomalyBaselineTCo2e: 10 });
    await month('May', 30, { anomalyFlag: true, anomalyBaselinePriorCount: 3, anomalyBaselineTCo2e: 11 });

    expect(await selected(DRIFT_WHERE)).toEqual([]);
    expect(await selected(LEGACY_WHERE)).toEqual([]);
  });
});

// BUG-R2-07 tier 3 (2026-11-13): a first period is held to its typo ceiling.
// The probe's copy of the ceilings is the only second copy of the rule.
describe('anomaly:probe — the first-period typo ceiling', () => {
  it('holds the same ceilings and multipliers as the contract', () => {
    expect(FIRST_PERIOD_CEILINGS).toEqual(CONTRACT_CEILINGS);
    expect(CEILING_UNIT_MULTIPLIERS).toEqual(CONTRACT_MULTIPLIERS);
    expect(MARINE_GAS_OIL_CEILING_KG).toBe(CONTRACT_MGO_KG);
    expect(MARINE_GAS_OIL_ACTIVITY_TYPE).toBe(CONTRACT_MGO_TYPE);
    expect(REFRIGERANT_LINE_CEILING_KG).toBe(CONTRACT_LINE_KG);
    expect(REFRIGERANT_REFILL_RATIO).toBe(CONTRACT_REFILL_RATIO);
    expect(REFILL_CEILING_TOLERANCE).toBe(CONTRACT_REFILL_TOLERANCE);
  });

  /** A lone first period (its own series) with the stored verdict under test. */
  const first = (data: Partial<Prisma.ActivityRecordUncheckedCreateInput>, flagged: boolean) =>
    createRecord(runtime, tenant, {
      periodValue: 'January',
      status: ActivityRecordStatus.approved,
      calculation: { tCo2e: 10, factorId: 'int-test-placeholder' },
      anomalyFlag: flagged,
      anomalyBaselinePriorCount: 0,
      anomalyBaselineTCo2e: null,
      ...data,
    }).then((r) => r.id);
  // One line per equipment type: the column's CHECK allows each type once.
  const TYPES = ['fire_suppression_system', 'fire_extinguisher', 'transformer_breaker', 'split_air_conditioner', 'water_dispenser', 'refrigerator', 'chiller'];
  const lines = (...capacities: number[]) => ({
    equipment: capacities.map((capacityKg, i) => ({
      equipmentType: TYPES[i],
      capacityKg,
      refillKg: 0,
      leakRateChoice: 'default',
    })),
  });

  it('agrees with a ceiling flag stored right, keeps a pre-ceiling verdict, and reports a baseless flag', async () => {
    // Above its ceiling and flagged: what the API now writes. No drift.
    const ceilingFlag = await first({ category: 'Electricity', activityValue: 4_500_000, activityUnit: 'kWh' }, true);
    // Above its ceiling, unflagged: scored before the ceilings. Kept.
    const preCeiling = await first({ category: 'Natural Gas', activityValue: 260_000, activityUnit: 'cubic_metres' }, false);
    // Flagged with no earlier period, NOT above its ceiling: no writer did this.
    const baseless = await first({ category: 'Fuel', activityValue: 120_000, activityUnit: 'kg', activityType: 'coal' }, true);
    // A refrigerant line above 500 kg, stored flagged: right.
    const line = await first(
      { category: 'Refrigerants', activityType: 'R-410A', activityUnit: 'kg', activityValue: 770, parameters: lines(120, 650) },
      true,
    );
    // Six small lines (600 kg in total), stored unflagged: right.
    const smallLines = await first(
      { category: 'Refrigerants', activityType: 'R-32', activityUnit: 'kg', activityValue: 600, parameters: lines(...Array(6).fill(100)) },
      false,
    );
    // Marine gas oil at 400 t: under its own ceiling, though above the road kg row.
    const mgo = await first(
      { category: 'Mobile Combustion', activityType: 'marine_gas_oil', activityUnit: 'tonnes', activityValue: 400 },
      false,
    );
    // Exactly at the ceiling, unflagged: right (strictly above flags).
    const atCeiling = await first({ category: 'Fugitive Gas', activityValue: 200_000, activityUnit: 'standard_cubic_metres' }, false);

    expect(await selected(DRIFT_WHERE)).toEqual([baseless]);
    expect(await selected(PRE_CEILING_WHERE)).toEqual([preCeiling]);
    for (const ok of [ceilingFlag, line, smallLines, mgo, atCeiling]) {
      expect(await selected(DRIFT_WHERE)).not.toContain(ok);
    }
  });

  it('judges the refill too: a stored refill flag is right, an unflagged committed one is pre-ceiling', async () => {
    const refill = (capacityKg: number, refillKg: number) => ({
      equipment: [{ equipmentType: 'fire_suppression_system', capacityKg, refillKg, leakRateChoice: 'default' }],
    });
    // 10 kg capacity, 50,000 kg refill, stored flagged: right.
    const flagged = await first(
      { category: 'Refrigerants', activityType: 'HFC-227ea', activityUnit: 'kg', activityValue: 10, parameters: refill(10, 50_000) },
      true,
    );
    // The same breach stored unflagged before the ceilings: a known difference.
    const kept = await first(
      { category: 'Refrigerants', activityType: 'R-32', activityUnit: 'kg', activityValue: 40, parameters: refill(40, 51) },
      false,
    );
    // Exactly 125%, unflagged: right.
    const atRatio = await first(
      { category: 'Refrigerants', activityType: 'R-410A', activityUnit: 'kg', activityValue: 40, parameters: refill(40, 50) },
      false,
    );
    // No capacity, 400 kg refill, unflagged: right (the 500 kg cap alone).
    const noCapacity = await first(
      { category: 'Refrigerants', activityType: 'R-134a', activityUnit: 'kg', activityValue: 0, parameters: refill(0, 400) },
      false,
    );

    // The SQL's other two branches, stored flagged as the contract judges them:
    // no capacity and a 600 kg refill (the 500 kg cap alone), and a 400 kg line
    // with a 501 kg refill (the cap, below 125% of the capacity).
    const noCapacityOver = await first(
      { category: 'Refrigerants', activityType: 'R-404A', activityUnit: 'kg', activityValue: 0, parameters: refill(0, 600) },
      true,
    );
    const capBelowRatio = await first(
      { category: 'Refrigerants', activityType: 'R-407C', activityUnit: 'kg', activityValue: 400, parameters: refill(400, 501) },
      true,
    );

    // Exactly 125% of a decimal capacity, unflagged: right (1.25 × 1.44 is
    // 1.7999999999999998 in binary).
    const decimalAtRatio = await first(
      { category: 'Refrigerants', activityType: 'R-448A', activityUnit: 'kg', activityValue: 1.44, parameters: refill(1.44, 1.8) },
      false,
    );

    const drift = await selected(DRIFT_WHERE);
    for (const ok of [flagged, kept, atRatio, noCapacity, noCapacityOver, capBelowRatio, decimalAtRatio]) {
      expect(drift).not.toContain(ok);
    }
    expect(await selected(PRE_CEILING_WHERE)).toEqual([kept]);
  });

  it('applies the ceiling over a zero average and to m³ × its factor, and keeps no broken average (owner review)', async () => {
    // K1: December at 0 tCO₂e, then January above its ceiling.
    const zeroSeries = async (category: string, data: Partial<Prisma.ActivityRecordUncheckedCreateInput>, flagged: boolean) => {
      await createRecord(runtime, tenant, {
        category,
        reportingPeriod: 'monthly',
        reportingYear: 2025,
        periodValue: 'December',
        status: ActivityRecordStatus.approved,
        calculation: { tCo2e: 0, factorId: 'int-test-placeholder' },
        anomalyFlag: false,
        anomalyBaselinePriorCount: 0,
        anomalyBaselineTCo2e: null,
        ...(data.activityUnit ? { activityUnit: data.activityUnit } : {}),
      });
      return first({ category, reportingPeriod: 'monthly', anomalyBaselinePriorCount: 1, anomalyBaselineTCo2e: 0, ...data }, flagged);
    };
    const zeroFlagged = await zeroSeries('Electricity', { activityValue: 4_500_000, activityUnit: 'kWh' }, true);
    const zeroKept = await zeroSeries('Fugitive Gas', { activityValue: 300_000, activityUnit: 'standard_cubic_metres' }, false);
    // K2: 240,000 m³ × 30 = 7,200,000 Sm³, flagged and right; the same unflagged is pre-ceiling.
    const vcf = { volumeCorrectionFactor: 30 };
    const corrected = await first({ category: 'Natural Gas', activityValue: 240_000, activityUnit: 'cubic_metres', parameters: vcf }, true);
    // A broken stored average beside a count of 0, unflagged and above: drift, not kept.
    const broken = await first({ category: 'Fuel', activityType: 'coal', activityValue: 200_000, activityUnit: 'kg', anomalyBaselineTCo2e: 99 }, false);

    const drift = await selected(DRIFT_WHERE);
    expect(drift).not.toContain(zeroFlagged);
    expect(drift).not.toContain(zeroKept);
    expect(drift).not.toContain(corrected);
    expect(drift).toContain(broken);
    expect(await selected(PRE_CEILING_WHERE)).toEqual([zeroKept]);
  });

  it('stops excusing a pre-ceiling verdict once the series has an earlier period', async () => {
    // December (2025) committed, then January 2026 stored as "no earlier
    // period" and above its ceiling: the count is stale, which is drift.
    await createRecord(runtime, tenant, {
      category: 'Electricity',
      reportingPeriod: 'monthly',
      reportingYear: 2025,
      periodValue: 'December',
      status: ActivityRecordStatus.approved,
      calculation: { tCo2e: 10, factorId: 'int-test-placeholder' },
      anomalyFlag: false,
      anomalyBaselinePriorCount: 0,
      anomalyBaselineTCo2e: null,
    });
    const january = await first({ category: 'Electricity', reportingPeriod: 'monthly', activityValue: 4_500_000, activityUnit: 'kWh' }, false);

    expect(await selected(PRE_CEILING_WHERE)).toEqual([]);
    expect(await selected(DRIFT_WHERE)).toEqual([january]);
  });
});
