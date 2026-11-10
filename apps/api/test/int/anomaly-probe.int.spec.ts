import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecordStatus, type Prisma } from '@tonyai/db';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { BASE_SQL, DRIFT_WHERE, LEGACY_WHERE } from '../../../../packages/db/scripts/anomaly-probe.lib.mjs';
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
