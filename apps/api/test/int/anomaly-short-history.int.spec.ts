import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecordStatus } from '@tonyai/db';
import { VarianceReasonRequiredError } from '../../src/activity-records/errors';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { attachEvidence, connect, connectOwner, createRecord, createTenant, type Tenant } from './db';
import { lifecycleServices } from './services';
import { loadTrReleases } from './tr-releases';

/**
 * The short-history anomaly check (owner, 2026-11-11; QA BUG-R2-07; OpenSpec
 * `uat2-anomaly-short-history`) against real PostgreSQL: a new series' first
 * month is not checked, its second is judged against the first alone and is
 * refused at submit until its author explains it, and its third is judged
 * against the average of the two before it.
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

/** One month of a priced TR marine gas oil series at `locationId`, with its file. */
async function mgoMonth(locationId: string, periodValue: string, activityValue: number) {
  const record = await createRecord(
    runtime,
    tenant,
    {
      locationId,
      reportingYear: 2025,
      reportingPeriod: 'monthly',
      periodValue,
      category: 'Mobile Combustion',
      activityType: 'marine_gas_oil',
      activityValue,
      activityUnit: 'kg',
    },
    { priced: true },
  );
  // Mobile Combustion needs a file before submit (K3); attached here so the
  // only gate left for these tests to meet is the anomaly one.
  await attachEvidence(runtime, tenant, [record.id]);
  return record;
}

async function stored(id: string) {
  return runtime.activityRecord.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      anomalyFlag: true,
      anomalyBaselinePriorCount: true,
      anomalyBaselineTCo2e: true,
      calculation: true,
    },
  });
}

const tCo2eOf = (row: { calculation: unknown }) => (row.calculation as { tCo2e: number }).tCo2e;

describe('the short-history anomaly check', () => {
  it('leaves the first month unchecked, gates the second on the first, and averages two for the third', async () => {
    const site = await owner.location.create({
      data: { subsidiaryId: tenant.subsidiaryId, name: `R2-07 TR ${randomUUID().slice(0, 8)}`, geographyCode: 'TR' },
    });
    const author = tenant.users.dataEntry;

    // January: the first period of its series. Nothing to compare with.
    const january = await mgoMonth(site.id, 'January', 1000);
    await s.records.submit(author, january.id);
    const jan = await stored(january.id);
    expect(jan).toMatchObject({
      status: ActivityRecordStatus.submitted,
      anomalyFlag: false,
      anomalyBaselinePriorCount: 0,
      anomalyBaselineTCo2e: null,
    });

    // February: twice January. One earlier period is enough for the rule to
    // run, so the submit is refused until the author says why.
    const february = await mgoMonth(site.id, 'February', 2000);
    const auditBefore = await owner.auditLog.count({ where: { entityId: february.id } });
    await expect(s.records.submit(author, february.id)).rejects.toBeInstanceOf(VarianceReasonRequiredError);
    expect((await stored(february.id)).status).toBe(ActivityRecordStatus.draft);
    expect(await owner.auditLog.count({ where: { entityId: february.id } })).toBe(auditBefore);

    await runtime.activityRecord.update({
      where: { id: february.id },
      data: { varianceReason: 'Second vessel entered service in February' },
    });
    await s.records.submit(author, february.id);
    const feb = await stored(february.id);
    expect(feb).toMatchObject({
      status: ActivityRecordStatus.submitted,
      anomalyFlag: true,
      anomalyBaselinePriorCount: 1,
    });
    // Prisma rounds a double to 16 significant digits on write, so the stored
    // average is compared for closeness, never for equality.
    expect(feb.anomalyBaselineTCo2e).toBeCloseTo(tCo2eOf(jan), 9);

    // March: 1,100 kg against an average of 1,500 kg is -27%. Within range, on
    // two periods.
    const march = await mgoMonth(site.id, 'March', 1100);
    await s.records.submit(author, march.id);
    const mar = await stored(march.id);
    expect(mar).toMatchObject({
      status: ActivityRecordStatus.submitted,
      anomalyFlag: false,
      anomalyBaselinePriorCount: 2,
    });
    expect(mar.anomalyBaselineTCo2e).toBeCloseTo((tCo2eOf(jan) + tCo2eOf(feb)) / 2, 9);
  });

  it('does not let another site or a draft seed the history', async () => {
    const siteA = await owner.location.create({
      data: { subsidiaryId: tenant.subsidiaryId, name: `R2-07 A ${randomUUID().slice(0, 8)}`, geographyCode: 'TR' },
    });
    const siteB = await owner.location.create({
      data: { subsidiaryId: tenant.subsidiaryId, name: `R2-07 B ${randomUUID().slice(0, 8)}`, geographyCode: 'TR' },
    });
    const author = tenant.users.dataEntry;

    // A committed January at site A, and a January DRAFT at site B.
    await s.records.submit(author, (await mgoMonth(siteA.id, 'January', 1000)).id);
    await mgoMonth(siteB.id, 'January', 1000);

    // Site B's February is twice both of them, and neither is its history:
    // one belongs to another site and the other was never committed.
    const february = await mgoMonth(siteB.id, 'February', 2000);
    await s.records.submit(author, february.id);
    expect(await stored(february.id)).toMatchObject({
      status: ActivityRecordStatus.submitted,
      anomalyFlag: false,
      anomalyBaselinePriorCount: 0,
      anomalyBaselineTCo2e: null,
    });
  });
});
