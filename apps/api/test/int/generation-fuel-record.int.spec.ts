import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecordStatus, type Prisma } from '@tonyai/db';
import type { RequestUser } from '../../src/auth/auth.types';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { attachEvidence, connect, connectOwner, createRecord, createTenant, type Tenant } from './db';
import { lifecycleServices } from './services';

/**
 * `ActivityRecordDTO.generationFuelRecord` against real PostgreSQL
 * (`self-gen-form`, design 6; Decisions 2026-11-20 D5): a fuel-sourced
 * Electricity record is `present` when a record that is not voided, of the
 * same subsidiary and location (none included) and the same reporting year,
 * is its fuel record; `missing` otherwise; null for every other record. One
 * case per scenario of the `record-lifecycle` delta.
 */

let runtime: PrismaService;
let owner: PrismaService;
let tenant: Tenant;
let other: Tenant | null;
let s: ReturnType<typeof lifecycleServices>;
let site: string;
let otherSite: string;

beforeAll(async () => {
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
  other = null;
  site = (await owner.location.create({ data: { subsidiaryId: tenant.subsidiaryId, name: 'Int CHP site', geographyCode: 'UK' } })).id;
  otherSite = (await owner.location.create({ data: { subsidiaryId: tenant.subsidiaryId, name: 'Int other site', geographyCode: 'UK' } })).id;
});

afterEach(async () => {
  await tenant?.cleanup();
  await other?.cleanup();
});

const block = (selfGenerationSource: string) => ({
  generationTopology: 'A',
  selfGenerationSource,
  selfGeneratedKwh: 400_000,
});

/** A quarterly 2026 Electricity draft with a block, at `locationId`. */
function electricity(
  selfGenerationSource: string,
  data: Partial<Prisma.ActivityRecordUncheckedCreateInput> = {},
  on: Tenant = tenant,
) {
  return createRecord(owner, on, {
    category: 'Electricity',
    reportingPeriod: 'quarterly',
    periodValue: 'Q1',
    locationId: site,
    activityValue: 600_000,
    parameters: block(selfGenerationSource),
    ...data,
  });
}

/** A fuel record: Natural Gas by default, January 2026 at `site`. */
function fuel(data: Partial<Prisma.ActivityRecordUncheckedCreateInput> = {}, on: Tenant = tenant) {
  return createRecord(owner, on, {
    category: 'Natural Gas',
    reportingPeriod: 'monthly',
    periodValue: 'January',
    locationId: site,
    activityValue: 50_000,
    activityUnit: 'cubic_metres',
    ...data,
  });
}

const reader = (): RequestUser => tenant.users.masterkey;
const stateOf = async (id: string, user: RequestUser = reader()) => (await s.records.get(user, id)).generationFuelRecord;

describe('generationFuelRecord on real PostgreSQL (self-gen-form)', () => {
  it('reads present when the site holds a monthly gas record of the year, whatever its status but voided', async () => {
    const chp = await electricity('natural_gas_chp');
    await fuel();
    expect(await stateOf(chp.id)).toBe('present');
  });

  it('reads missing when the site holds no gas record of the year', async () => {
    const chp = await electricity('natural_gas_chp');
    expect(await stateOf(chp.id)).toBe('missing');
  });

  it('reads missing when the gas record is at another site, or for the whole company', async () => {
    const chp = await electricity('natural_gas_chp');
    await fuel({ locationId: otherSite });
    await fuel({ locationId: null });
    expect(await stateOf(chp.id)).toBe('missing');
  });

  it('matches a whole-company record with a whole-company gas record', async () => {
    const chp = await electricity('natural_gas_chp', { locationId: null });
    await fuel({ locationId: site });
    expect(await stateOf(chp.id)).toBe('missing');
    await fuel({ locationId: null });
    expect(await stateOf(chp.id)).toBe('present');
  });

  it('reads missing when the only gas record is voided', async () => {
    const chp = await electricity('natural_gas_chp');
    await fuel({ status: ActivityRecordStatus.voided });
    expect(await stateOf(chp.id)).toBe('missing');
  });

  it('counts a submitted and an approved gas record', async () => {
    const chp = await electricity('natural_gas_chp');
    const gas = await fuel({ status: ActivityRecordStatus.approved });
    expect(await stateOf(chp.id)).toBe('present');
    expect(gas.status).toBe(ActivityRecordStatus.approved);
  });

  it('reads missing when the only gas record is of another year', async () => {
    const chp = await electricity('natural_gas_chp');
    await fuel({ reportingYear: 2025 });
    expect(await stateOf(chp.id)).toBe('missing');
  });

  it('never reads another subsidiary, of the same organisation or another, even for a reader of both', async () => {
    // Whole company on every side, so only the subsidiary condition keeps the
    // other subsidiaries' gas records out: a site is tied to one subsidiary by
    // its foreign key, and would hide a dropped condition (security-rls review).
    const chp = await electricity('natural_gas_chp', { locationId: null });
    const sister = await owner.subsidiary.create({
      data: { organisationId: tenant.organisationId, legalName: 'Int sister subsidiary', geographyCode: 'UK' },
    });
    await createRecord(owner, { ...tenant, subsidiaryId: sister.id }, {
      category: 'Natural Gas', reportingPeriod: 'monthly', periodValue: 'January', locationId: null,
      activityValue: 1, activityUnit: 'cubic_metres',
    });
    other = await createTenant();
    await createRecord(owner, other, {
      category: 'Natural Gas', reportingPeriod: 'monthly', periodValue: 'January', activityValue: 1, activityUnit: 'cubic_metres',
    });
    const both: RequestUser = {
      ...tenant.users.masterkey,
      accessibleSubsidiaryIds: [tenant.subsidiaryId, sister.id, other.subsidiaryId],
    };
    expect(await stateOf(chp.id, both)).toBe('missing');
  });

  it('matches a generator with a Fuel record for diesel, never with Mobile Combustion diesel', async () => {
    const generator = await electricity('diesel_generator');
    await createRecord(owner, tenant, {
      category: 'Mobile Combustion', activityType: 'diesel', reportingPeriod: 'monthly', periodValue: 'January',
      locationId: site, activityValue: 100, activityUnit: 'litres',
    });
    await createRecord(owner, tenant, {
      category: 'Fuel', activityType: 'petrol', reportingPeriod: 'monthly', periodValue: 'January',
      locationId: site, activityValue: 100, activityUnit: 'litres',
    });
    expect(await stateOf(generator.id)).toBe('missing');
    await createRecord(owner, tenant, {
      category: 'Fuel', activityType: 'diesel', reportingPeriod: 'monthly', periodValue: 'February',
      locationId: site, activityValue: 100, activityUnit: 'litres',
    });
    expect(await stateOf(generator.id)).toBe('present');
  });

  it('reads null for a renewable source and a plain record', async () => {
    const solar = await electricity('solar');
    const plain = await electricity('solar', { periodValue: 'Q2', parameters: undefined });
    await fuel();
    expect(await stateOf(solar.id)).toBeNull();
    expect(await stateOf(plain.id)).toBeNull();
  });

  it('fills every row of the review queue and the answer to a review step', async () => {
    const present = await electricity('natural_gas_chp', { status: ActivityRecordStatus.submitted });
    const missing = await electricity('natural_gas_chp', { status: ActivityRecordStatus.submitted, locationId: otherSite });
    await fuel();
    const page = await s.records.listPage(tenant.users.superAdmin, {
      sort: 'review_queue',
      status: [ActivityRecordStatus.submitted, ActivityRecordStatus.under_review],
    } as never);
    const states = Object.fromEntries(page.items.map((r) => [r.id, r.generationFuelRecord]));
    expect(states).toEqual({ [present.id]: 'present', [missing.id]: 'missing' });

    const reviewed = await s.records.startReview(tenant.users.superAdmin, missing.id);
    expect(reviewed.status).toBe(ActivityRecordStatus.under_review);
    expect(reviewed.generationFuelRecord).toBe('missing');
  });

  it('writes no audit row for a read, and none of its writes carry the field', async () => {
    const chp = await electricity('natural_gas_chp', { status: ActivityRecordStatus.submitted });
    const before = await owner.auditLog.count({ where: { entityId: chp.id } });
    await stateOf(chp.id);
    expect(await owner.auditLog.count({ where: { entityId: chp.id } })).toBe(before);
    await s.records.startReview(tenant.users.superAdmin, chp.id);
    const rows = await owner.auditLog.findMany({ where: { entityId: chp.id } });
    expect(rows.length).toBe(before + 1);
    expect(JSON.stringify(rows.map((r) => r.diff))).not.toContain('generationFuelRecord');
  });
});

describe('the fuel-record read belongs to the write (outside review of 833db34c)', () => {
  const INJECTED = 'injected fuel-record read failure';
  /** The runtime client, with the fuel lookup's query failing and every other query untouched. */
  const failingFuelRead = () =>
    runtime.$extends({
      query: {
        activityRecord: {
          async findMany({ args, query }) {
            const a = args as { select?: { activityType?: boolean }; where?: { status?: { not?: string } } };
            if (a.select?.activityType === true && a.where?.status?.not === 'voided') throw new Error(INJECTED);
            return query(args);
          },
        },
      },
    }) as unknown as PrismaService;

  it('a submit whose answer cannot be read is rolled back whole: the record stays a draft, no audit row', async () => {
    // Created through the service, so its snapshot is the engine's own (K11 at submit).
    const chp = await s.records.create(tenant.users.standardUser, {
      subsidiaryId: tenant.subsidiaryId, locationId: site, reportingYear: 2026, reportingPeriod: 'quarterly', periodValue: 'Q1',
      category: 'Electricity', activityValue: 5000, activityUnit: 'kWh', parameters: block('natural_gas_chp'),
    } as never);
    await attachEvidence(owner, tenant, [chp.id]);
    const before = await owner.auditLog.count({ where: { entityId: chp.id } });

    await expect(lifecycleServices(failingFuelRead()).records.submit(tenant.users.standardUser, chp.id)).rejects.toThrow(INJECTED);

    expect((await owner.activityRecord.findUniqueOrThrow({ where: { id: chp.id } })).status).toBe(ActivityRecordStatus.draft);
    expect(await owner.auditLog.count({ where: { entityId: chp.id } })).toBe(before);
    // The same submit, with the read working, commits.
    expect((await s.records.submit(tenant.users.standardUser, chp.id)).status).toBe(ActivityRecordStatus.submitted);
  });

  it('a create whose answer cannot be read writes nothing', async () => {
    const failing = lifecycleServices(failingFuelRead());
    await expect(
      failing.records.create(tenant.users.standardUser, {
        subsidiaryId: tenant.subsidiaryId, locationId: site, reportingYear: 2026, reportingPeriod: 'quarterly', periodValue: 'Q2',
        category: 'Electricity', activityValue: 5000, activityUnit: 'kWh', parameters: block('natural_gas_chp'),
      } as never),
    ).rejects.toThrow(INJECTED);
    expect(await owner.activityRecord.count({ where: { subsidiaryId: tenant.subsidiaryId, periodValue: 'Q2' } })).toBe(0);
  });
});
