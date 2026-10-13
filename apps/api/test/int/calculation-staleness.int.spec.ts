import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ActivityRecordStatus } from '@tonyai/db';
import {
  INTERNAL_FACTOR_PUBLISHERS,
  factorUnitFor,
  type ActivityRecordDTO,
  type FactorReleaseImport,
} from '@tonyai/shared-types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CalculationStaleError } from '../../src/activity-records/errors';
import { CalculationInputError } from '../../src/calculations/errors';
import { AuditService } from '../../src/audit/audit.service';
import { BulkSubmitService } from '../../src/bulk-upload/bulk-submit.service';
import { FactorReleaseLoader } from '../../src/factor-releases/factor-release-loader';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { attachEvidence, connect, connectLoader, connectOwner, createRecord, createTenant, type Tenant } from './db';
import { lifecycleServices } from './services';

/**
 * K11 (LP4-02 PR B2; Decisions 2026-10-11 L4 and P6, 2026-10-13 C1–C7)
 * against real PostgreSQL: a figure the API saved goes stale when the library
 * moves under it — an erratum, a withdrawal, a factor for a category that had
 * none — and submit and approve refuse it (`calculation_stale`) until the
 * author saves it again. The library moves through the loader's own login,
 * as an operator moves it. Labelled fixture releases only (L6): every value
 * here says it is not an emission factor, and each test removes its own.
 */

const FIXTURE = INTERNAL_FACTOR_PUBLISHERS.fixture;
const OPERATOR = 'TonyAI test operator';
/** A year no seed release covers, so only this spec's fixtures price it. */
const YEAR = 2031;

let runtime: PrismaService;
let owner: PrismaService;
let loaderDb: PrismaService;
let tenant: Tenant;
let warn: MockInstance;
const loaded: string[] = [];

beforeAll(() => {
  runtime = connect();
  owner = connectOwner();
  loaderDb = connectLoader();
});

beforeEach(async () => {
  tenant = await createTenant();
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  warn.mockRestore();
  await tenant?.cleanup();
  // Fixture releases are test data: deletable with their rows, withdrawn or not.
  for (const edition of loaded.splice(0)) {
    const release = await owner.factorRelease.findUnique({ where: { publisher_edition: { publisher: FIXTURE, edition } } });
    if (!release) continue;
    await owner.emissionFactor.deleteMany({ where: { releaseId: release.id } });
    await owner.unitConversion.deleteMany({ where: { releaseId: release.id } });
    await owner.factorRelease.delete({ where: { id: release.id } });
  }
});

afterAll(async () => {
  await Promise.all([runtime.$disconnect(), owner.$disconnect(), loaderDb.$disconnect()]);
});

async function nextOrdinal(): Promise<number> {
  const latest = await owner.factorRelease.findFirst({
    where: { publisher: FIXTURE },
    orderBy: { ordinal: 'desc' },
    select: { ordinal: true },
  });
  return (latest?.ordinal ?? 0) + 1;
}

type FixtureFactor = FactorReleaseImport['factors'][number];

const NATURAL_GAS = (factorValue: number): FixtureFactor => ({
  category: 'Natural Gas', activityType: 'natural_gas', gas: 'CO2e', gasCoverage: 'all_ghg', geographyCode: 'UK',
  reportingYear: YEAR, dataYear: YEAR, scope: 1, factorValue, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh',
  calorificBasis: 'gross', scope2Method: 'not_applicable',
  methodology: 'K11 integration fixture — not a methodology', source: 'INT FIXTURE — not a real emission factor',
}) as FixtureFactor;

const WATER = (factorValue: number): FixtureFactor => ({
  category: 'Water', activityType: 'water_supply', gas: 'CO2e', gasCoverage: 'all_ghg', geographyCode: 'UK',
  reportingYear: YEAR, dataYear: YEAR, scope: 3, factorValue, factorUnit: factorUnitFor('cubic_metres'),
  normalizedUnit: 'cubic_metres', calorificBasis: 'not_applicable', scope2Method: 'not_applicable',
  methodology: 'K11 integration fixture — not a methodology', source: 'INT FIXTURE — not a real emission factor',
}) as FixtureFactor;

/** A labelled fixture release file holding `factors`. */
async function fixture(factors: FixtureFactor[]): Promise<FactorReleaseImport> {
  const edition = `int-k11-${randomUUID()}`;
  loaded.push(edition);
  return {
    release: {
      publisher: FIXTURE, title: 'K11 integration fixture — not a source', edition, ordinal: await nextOrdinal(), status: 'fixture',
      sourceUrl: null, licence: null, publishedAt: null, gwpSet: null, reviewedBy: null, reviewedAt: null,
      notes: 'Written by the K11 integration spec and removed by it. Not a source.',
    },
    factors,
    conversions: [],
  } as FactorReleaseImport;
}

const loader = () => new FactorReleaseLoader(loaderDb, OPERATOR);

async function load(factors: FixtureFactor[]): Promise<string> {
  const file = await fixture(factors);
  expect(await loader().load(file, { apply: true })).toMatchObject({ outcome: 'loaded' });
  return file.release.edition;
}

/** An erratum: a new edition, loaded and sealed, withdrawing `edition` in the same transaction. */
async function erratum(edition: string, factors: FixtureFactor[]): Promise<string> {
  const file = await fixture(factors);
  const reason = 'Erratum: the K11 fixture factor corrected';
  expect(await loader().load(file, { apply: true, supersedes: edition, reason })).toMatchObject({ outcome: 'loaded' });
  return file.release.edition;
}

async function withdraw(edition: string): Promise<void> {
  expect(await loader().withdraw({ publisher: FIXTURE, edition, reason: 'Found wrong at review' }, true)).toMatchObject({
    outcome: 'withdrawn',
  });
}

/**
 * A draft saved through the API — the snapshot is the engine's at save time —
 * with its evidence file. Both categories name no activity type: theirs is
 * implicit (`natural_gas`, `water_supply`), which the fixture factors carry.
 */
async function saved(category: 'Natural Gas' | 'Water', periodValue = 'January'): Promise<ActivityRecordDTO> {
  const record = await lifecycleServices(runtime).records.create(tenant.users.dataEntry, {
    subsidiaryId: tenant.subsidiaryId,
    reportingYear: YEAR,
    reportingPeriod: 'monthly',
    periodValue,
    category,
    activityValue: 100,
    activityUnit: category === 'Natural Gas' ? 'kWh' : 'cubic_metres',
  } as Parameters<ReturnType<typeof lifecycleServices>['records']['create']>[1]);
  await attachEvidence(runtime, tenant, [record.id]);
  return record;
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

async function row(id: string) {
  return owner.activityRecord.findUniqueOrThrow({ where: { id } });
}

async function auditActions(id: string): Promise<string[]> {
  const rows = await owner.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: 'asc' } });
  return rows.map((r) => r.action);
}

function logged(): string[] {
  return warn.mock.calls.map((c) => String(c[0]));
}

describe('K11 — an erratum between save and submit', () => {
  it('refuses the submit (calculation_stale) and moves nothing; saving the draft again recalculates it, audited old → new, and it submits', async () => {
    const first = await load([NATURAL_GAS(0.2)]);
    const record = await saved('Natural Gas');
    expect(record.calculation).toMatchObject({ kgCo2e: 20, version: first });
    await erratum(first, [NATURAL_GAS(0.25)]);
    const { records } = lifecycleServices(runtime);

    expect(await failure(records.submit(tenant.users.dataEntry, record.id))).toBeInstanceOf(CalculationStaleError);
    expect((await row(record.id)).status).toBe(ActivityRecordStatus.draft);
    expect(await auditActions(record.id)).toEqual(['create']);
    expect(logged()).toEqual([`calculation_stale: submit of record ${record.id} refused — figure, factor differ`]);

    await records.update(tenant.users.dataEntry, record.id, { activityValue: 100 });
    const update = await owner.auditLog.findFirstOrThrow({ where: { entityId: record.id, action: 'update' } });
    const diff = update.diff as { before: { calculation: { kgCo2e: number } }; after: { calculation: { kgCo2e: number } } };
    expect([diff.before.calculation.kgCo2e, diff.after.calculation.kgCo2e]).toEqual([20, 25]);

    await records.submit(tenant.users.dataEntry, record.id);
    expect((await row(record.id)).status).toBe(ActivityRecordStatus.submitted);
  });

  it('bulk submit names the stale record `calculation_stale` and submits the fresh one beside it', async () => {
    const first = await load([NATURAL_GAS(0.2)]);
    const stale = await saved('Natural Gas', 'January');
    const fresh = await saved('Natural Gas', 'February');
    await erratum(first, [NATURAL_GAS(0.25)]);
    const { records } = lifecycleServices(runtime);
    await records.update(tenant.users.dataEntry, fresh.id, { activityValue: 100 });

    const report = await new BulkSubmitService(runtime, records, new AuditService(runtime)).submitIds(tenant.users.dataEntry, [
      stale.id,
      fresh.id,
    ]);

    expect(report.failed).toEqual([expect.objectContaining({ recordId: stale.id, code: 'calculation_stale' })]);
    expect(report.submitted.map((r) => r.recordId)).toEqual([fresh.id]);
    expect((await row(stale.id)).status).toBe(ActivityRecordStatus.draft);
  });
});

describe('K11 — an erratum between submit and approve', () => {
  it('refuses the approve; the reviewer returns the record, its author saves and resubmits it, and it is approved', async () => {
    const first = await load([NATURAL_GAS(0.2)]);
    const record = await saved('Natural Gas');
    const { records } = lifecycleServices(runtime);
    await records.submit(tenant.users.dataEntry, record.id);
    await erratum(first, [NATURAL_GAS(0.25)]);

    expect(await failure(records.approve(tenant.users.superAdmin, record.id))).toBeInstanceOf(CalculationStaleError);
    expect((await row(record.id)).status).toBe(ActivityRecordStatus.submitted);
    expect(logged()).toEqual([`calculation_stale: approve of record ${record.id} refused — figure, factor differ`]);

    await records.reject(tenant.users.consultant, record.id, 'The factor was corrected — please save it again');
    await records.update(tenant.users.dataEntry, record.id, { activityValue: 100 });
    await records.submit(tenant.users.dataEntry, record.id);
    await records.approve(tenant.users.superAdmin, record.id);
    expect(await row(record.id)).toMatchObject({ status: ActivityRecordStatus.approved, calculation: { kgCo2e: 25 } });
    expect(await auditActions(record.id)).toEqual(['create', 'submit', 'reject', 'update', 'submit', 'approve']);
  });
});

describe('K11 — a recompute that refuses', () => {
  it('a release withdrawn with no successor: calculation_stale, never not_found — on submit and in bulk', async () => {
    const edition = await load([NATURAL_GAS(0.2)]);
    const single = await saved('Natural Gas', 'January');
    const inBulk = await saved('Natural Gas', 'February');
    await withdraw(edition);
    const { records } = lifecycleServices(runtime);

    expect(await failure(records.submit(tenant.users.dataEntry, single.id))).toBeInstanceOf(CalculationStaleError);
    expect(logged()).toEqual([`calculation_stale: submit of record ${single.id} refused — recompute refused (no_factor)`]);
    const report = await new BulkSubmitService(runtime, records, new AuditService(runtime)).submitIds(tenant.users.dataEntry, [
      inBulk.id,
    ]);
    expect(report.failed).toEqual([expect.objectContaining({ recordId: inBulk.id, code: 'calculation_stale' })]);
  });
});

describe('K11 — an uncalculated record compares as one', () => {
  it('stays fresh while no factor covers it, is stale once one does, and fresh again when that factor is withdrawn', async () => {
    const record = await saved('Water');
    expect(record.calculation).toMatchObject({ reasonCode: 'no_emission_factor' });
    const edition = await load([WATER(0.3)]);
    const { records } = lifecycleServices(runtime);

    expect(await failure(records.submit(tenant.users.dataEntry, record.id))).toBeInstanceOf(CalculationStaleError);
    await withdraw(edition);
    await records.submit(tenant.users.dataEntry, record.id);
    expect((await row(record.id)).status).toBe(ActivityRecordStatus.submitted);
  });
});

describe('K11 — a snapshot from before LP3-03', () => {
  it('is stale even when its figure is what the engine gives now', async () => {
    await load([NATURAL_GAS(0.2)]);
    const priced = await saved('Natural Gas');
    const { factorId } = priced.calculation as { factorId: string };
    // The owner's direct insert of the old, untagged shape — a draft saved
    // before LP3-03 — with the very figure and factor the engine resolves now.
    const legacy = await createRecord(owner, tenant, {
      reportingYear: YEAR,
      periodValue: 'March',
      category: 'Natural Gas',
      scope: 1,
      activityValue: 100,
      activityUnit: 'kWh',
      calculation: { tCo2e: 0.02, kgCo2e: 20, factorId },
    });
    await attachEvidence(owner, tenant, [legacy.id]);

    expect(await failure(lifecycleServices(runtime).records.submit(tenant.users.dataEntry, legacy.id))).toBeInstanceOf(
      CalculationStaleError,
    );
    expect(logged()[0]).toMatch(new RegExp(`^calculation_stale: submit of record ${legacy.id} refused — legacy snapshot`));
  });
});

describe('C8 — an untyped record of a typed category is not committed', () => {
  it("refuses at submit an untyped Fuel draft a direct writer inserted with the engine's own figure; named its type and saved, it submits", async () => {
    // The seed prices untyped Fuel (`unspecified`, a placeholder), so the
    // recompute alone finds this draft fresh: C8 is what refuses it.
    const draft = await createRecord(
      owner,
      tenant,
      { reportingYear: 2026, periodValue: 'April', category: 'Fuel', scope: 1, activityValue: 10, activityUnit: 'litres' },
      { priced: true },
    );
    await attachEvidence(owner, tenant, [draft.id]);
    const { records } = lifecycleServices(runtime);

    const refused = await failure(records.submit(tenant.users.dataEntry, draft.id));
    expect(refused).toBeInstanceOf(CalculationInputError);
    expect((refused as CalculationInputError).code).toBe('activity_type_required');
    expect(logged()).toEqual([]);
    expect((await row(draft.id)).status).toBe(ActivityRecordStatus.draft);
    expect(await auditActions(draft.id)).toEqual([]);

    await records.update(tenant.users.dataEntry, draft.id, { activityType: 'diesel' });
    await records.submit(tenant.users.dataEntry, draft.id);
    expect(await row(draft.id)).toMatchObject({ status: ActivityRecordStatus.submitted, activityType: 'diesel' });
  });
});
