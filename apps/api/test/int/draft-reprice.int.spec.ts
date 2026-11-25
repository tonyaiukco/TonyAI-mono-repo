import { ActivityRecordStatus, type Prisma } from '@tonyai/db';
import type { CalculationResultV3 } from '@tonyai/shared-types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftRepriceService } from '../../src/activity-records/draft-reprice.service';
import { AuditService } from '../../src/audit/audit.service';
import { CalculationsService } from '../../src/calculations/calculations.service';
import legacy from '../../src/calculations/refrigerant-sum-rule.fixtures.json';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { attachEvidence, connect, connectOwner, createRecord, createTenant, deferred, type Tenant } from './db';
import { INT_FACTOR_POLICY, lifecycleServices } from './services';
import { loadTrReleases } from './tr-releases';

const YEAR = 2025;
const equipment = [{ equipmentType: 'fire_suppression_system', capacityKg: 50, refillKg: 35, leakRateChoice: 'default' }];
const input = { category: 'Refrigerants', activityType: 'HFC-227ea', geographyCode: 'TR',
  reportingYear: YEAR, reportingPeriod: 'annual', value: 50, unit: 'kg', parameters: { equipment } };

let owner: PrismaService;
let runtime: PrismaService;
let tenant: Tenant;
let oldSnapshot: Prisma.InputJsonValue;
let newSnapshot: Prisma.InputJsonValue;

beforeAll(async () => {
  owner = connectOwner();
  runtime = connect();
  await loadTrReleases();
  const current = (await new CalculationsService(runtime, INT_FACTOR_POLICY).compute(
    input as Parameters<CalculationsService['compute']>[0],
  )) as CalculationResultV3;
  expect(current.tCo2e).toBe(126);
  const old = legacy.bothMasses;
  oldSnapshot = {
    ...current, normalizedValue: old.normalizedValue, kgCo2e: old.kgCo2e, tCo2e: old.tCo2e,
    refrigerantTerms: old.refrigerantTerms,
  } as unknown as Prisma.InputJsonValue;
  newSnapshot = current as unknown as Prisma.InputJsonValue;
});

beforeEach(async () => {
  tenant = await createTenant();
  await owner.subsidiary.update({ where: { id: tenant.subsidiaryId }, data: { geographyCode: 'TR' } });
});
afterEach(async () => { await tenant?.cleanup(); });
afterAll(async () => { await Promise.all([owner.$disconnect(), runtime.$disconnect()]); });

// The operator intentionally scans the whole database. The integration test
// confines that discovery query to its synthetic data instead of re-pricing
// another developer's local drafts. All locks, recalculations and writes are real.
function operator() {
  const db = runtime.$extends({
    query: {
      activityRecord: {
        findMany({ args, query }) {
          return query({ ...args, where: { AND: [args.where ?? {}, { subsidiaryId: tenant.subsidiaryId }] } });
        },
      },
    },
  }) as unknown as PrismaService;
  const engine = new CalculationsService(db, INT_FACTOR_POLICY);
  return { engine, service: new DraftRepriceService(db, engine, new AuditService(db)) };
}

async function stored(status: ActivityRecordStatus, calculation = oldSnapshot, atCompany = false) {
  const site = atCompany ? null : await owner.location.create({
    data: { subsidiaryId: tenant.subsidiaryId, name: `Repricing fixture ${status}`, geographyCode: 'TR' },
  });
  return createRecord(runtime, tenant, {
    status, locationId: site?.id ?? null, category: input.category, activityType: input.activityType,
    scope: 1, reportingYear: YEAR, reportingPeriod: 'annual', periodValue: 'Annual',
    activityValue: 50, activityUnit: 'kg', parameters: { equipment }, calculation,
    anomalyFlag: true, anomalyBaselinePriorCount: 1, anomalyBaselineTCo2e: 1000,
  });
}

const read = (id: string) => owner.activityRecord.findUniqueOrThrow({ where: { id } });
const audit = (id: string) => owner.auditLog.findMany({ where: { entityId: id, action: 'reprice' } });

describe('draft repricing with PostgreSQL lifecycle locks', () => {
  it('re-prices draft and rejected figures, preserves all committed statuses and submits the new draft', async () => {
    const draft = await stored('draft');
    const rejected = await stored('rejected');
    const untouched: Array<Awaited<ReturnType<typeof stored>>> = [];
    for (const status of ['approved', 'locked', 'voided', 'submitted', 'under_review'] as const) {
      untouched.push(await stored(status));
    }
    const pricedReview = await stored('submitted', newSnapshot);
    const { service } = operator();

    const dry = await service.run(false);
    expect(dry.counts.would_reprice).toBe(2);
    expect(await read(draft.id)).toEqual(draft);
    expect(await audit(draft.id)).toEqual([]);
    const applied = await service.run(true);
    expect(applied.counts.repriced).toBe(2);
    expect(applied.reviewQueue.sumRule.map((entry) => entry.id).sort())
      .toEqual(untouched.filter((row) => ['submitted', 'under_review'].includes(row.status)).map((row) => row.id).sort());

    for (const before of [draft, rejected]) {
      const after = await read(before.id);
      expect(after).toMatchObject({
        status: before.status, createdBy: before.createdBy, parameters: before.parameters,
        activityValue: before.activityValue, calculation: newSnapshot, anomalyFlag: false,
        anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null,
      });
      expect(await audit(before.id)).toMatchObject([{
        userId: null, organisationId: tenant.organisationId,
        diff: { before: { tCo2e: 129.6 }, after: { tCo2e: 126 } },
      }]);
    }
    for (const entry of [...untouched, pricedReview]) {
      expect(await read(entry.id)).toEqual(entry);
      expect(await audit(entry.id)).toEqual([]);
    }
    expect((await service.run(true)).counts.up_to_date).toBe(2);
    expect(await audit(draft.id)).toHaveLength(1);

    const approved = untouched.find((row) => row.status === 'approved')!;
    await expect(runtime.activityRecord.update({
      where: { id: approved.id }, data: { calculation: newSnapshot },
    })).rejects.toThrow(/TA001/);
    await attachEvidence(runtime, tenant, [draft.id]);
    await expect(lifecycleServices(runtime).records.submit(tenant.users.standardUser, draft.id))
      .resolves.toMatchObject({ status: 'submitted' });
  });

  it('skips an open record in a locked period', async () => {
    const draft = await stored('draft', oldSnapshot, true);
    await owner.periodLock.create({ data: {
      subsidiaryId: tenant.subsidiaryId, reportingYear: YEAR, reportingPeriod: 'annual', periodValue: 'Annual',
      lockedBy: tenant.users.masterkey.id,
    } });
    expect((await operator().service.run(true)).records).toMatchObject([
      { id: draft.id, outcome: 'skipped', reason: 'locked_period' },
    ]);
    expect(await read(draft.id)).toEqual(draft);
    expect(await audit(draft.id)).toEqual([]);
  });

  it('two runs that saw the same snapshot commit one write and one audit', async () => {
    const draft = await stored('draft');
    const { service, engine } = operator();
    const gate = deferred();
    const compute = engine.compute.bind(engine);
    let arrived = 0;
    vi.spyOn(engine, 'compute').mockImplementation(async (...args) => {
      const calculated = await compute(...args);
      if (++arrived === 2) gate.resolve();
      await gate.promise;
      return calculated;
    });

    const reports = await Promise.all([service.run(true), service.run(true)]);
    expect(reports.map((report) => report.records[0].outcome).sort()).toEqual(['repriced', 'up_to_date']);
    expect(await read(draft.id)).toMatchObject({ calculation: newSnapshot });
    expect(await audit(draft.id)).toHaveLength(1);
  });
});
