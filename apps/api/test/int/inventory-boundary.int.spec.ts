/**
 * LP3-04 PR B — the declared inventory boundary on the real database
 * (Decisions 2026-10-15 (second), W1–W13): its keys and CHECKs, the freeze
 * guard (TA014) against every writer, the owner included, the deletions it
 * refuses (W9) and the one it admits (W10), RLS and the client roles, and the
 * capture snapshot the reader and the one factor lookup share — an erratum
 * committed by another session does not reach a capture already reading.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import { directCalorificBasisFor, scope2MethodFor } from '@tonyai/shared-types';
import { AuditService } from '../../src/audit/audit.service';
import { CalculationsService } from '../../src/calculations/calculations.service';
import { CaptureSnapshot, CaptureSnapshotError } from '../../src/calculations/factor-lookup';
import { readInventoryBoundary } from '../../src/inventory-boundary/boundary-reader';
import { LocationsService } from '../../src/locations/locations.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { SubsidiariesService } from '../../src/subsidiaries/subsidiaries.service';
import {
  backendPid,
  connect,
  connectOwner,
  createBoundary,
  createTenant,
  deferred,
  holdBefore,
  INT_FACTOR_POLICY,
  settledOrBlocked,
  withRollback,
  type Tenant,
} from './db';

let owner: PrismaService;
let ownerB: PrismaService;
let observer: PrismaService;
let runtime: PrismaService;
let a: Tenant;
let b: Tenant;
/** A's own site, declared in A's fixtures; B's, for the cross-tenant keys. */
let siteA: string;
let siteB: string;

beforeAll(async () => {
  owner = connectOwner(3);
  ownerB = connectOwner(1);
  observer = connectOwner(1);
  runtime = connect(2);
  [a, b] = await Promise.all([createTenant(), createTenant()]);
  siteA = (await owner.location.create({ data: { subsidiaryId: a.subsidiaryId, name: 'Int-test site A', geographyCode: 'UK' } })).id;
  siteB = (await owner.location.create({ data: { subsidiaryId: b.subsidiaryId, name: 'Int-test site B', geographyCode: 'TR' } })).id;
});

afterAll(async () => {
  // The organisations' own deletion takes their versions, frozen ones
  // included (W10) — `cleanup()` is that proof on committed rows.
  await Promise.all([a?.cleanup(), b?.cleanup()]);
  await Promise.all([owner?.$disconnect(), ownerB?.$disconnect(), observer?.$disconnect(), runtime?.$disconnect()]);
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

/** The SQLSTATE `fn` fails with as the owner, in a rolled-back transaction. */
const refusedAsOwner = async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
  sqlstateOf(await failure(withRollback(owner, fn)));

const FK = ['P2003', '23503'];
const NIL = '00000000-0000-0000-0000-000000000000';

const header = (tenant: Tenant, over: Partial<Prisma.InventoryBoundaryUncheckedCreateInput> = {}) => ({
  id: randomUUID(), organisationId: tenant.organisationId, reportingYear: 2026, version: 1, createdBy: tenant.users.superAdmin.id, ...over,
});
/**
 * A source row of the version: the fixture's site meter unless overridden. Its
 * claim key follows the row (an included mapped source claims its type, ''
 * untyped; every other none) unless a case sets it to break that rule.
 */
const sourceRow = (boundaryId: string, tenant: Tenant, over: Partial<Prisma.InventorySourceUncheckedCreateInput> = {}) => {
  const row = {
    id: randomUUID(), boundaryId, subsidiaryId: tenant.subsidiaryId, locationId: siteA as string | null, locationKey: siteA,
    name: 'Int-test meter', scope: 2, mapping: 'mapped', category: 'Electricity' as string | null, activityType: null as string | null,
    applicability: 'included', reportingPeriod: 'monthly' as string | null, evidenceReportingPeriod: 'monthly' as string | null, ...over,
  };
  const claim = row.applicability === 'included' && row.mapping === 'mapped' ? (row.activityType ?? '') : null;
  return { includedActivityKey: claim, ...row };
};

/** Declares one more subsidiary of the version, with its site and one row in each row table. */
async function createRows(db: Prisma.TransactionClient | PrismaService, boundaryId: string, organisationId: string, subsidiaryId: string, locationId: string) {
  await db.inventoryBoundarySubsidiary.create({ data: { boundaryId, organisationId, subsidiaryId, firstMonth: 1, lastMonth: 12 } });
  await db.inventoryBoundarySite.create({ data: { boundaryId, subsidiaryId, locationId, firstMonth: 1, lastMonth: 12 } });
  await db.inventoryAttributionPolicy.create({ data: { boundaryId, subsidiaryId, category: 'Electricity', level: 'sites', reportingPeriod: 'monthly' } });
  await db.inventoryApplicabilityCell.create({ data: { boundaryId, subsidiaryId, locationId, locationKey: locationId, category: 'Electricity', applicability: 'included' } });
  await db.inventorySource.create({
    data: {
      boundaryId, subsidiaryId, locationId, locationKey: locationId, name: 'Int-test second meter', scope: 2, mapping: 'mapped',
      category: 'Electricity', includedActivityKey: '', applicability: 'included', reportingPeriod: 'monthly', evidenceReportingPeriod: null,
    },
  });
}

describe('the schema: keys and CHECKs', () => {
  it("declares only its own organisation's subsidiaries, and only their own sites", async () => {
    expect(FK).toContain(
      await refusedAsOwner(async (tx) => {
        const { id } = await tx.inventoryBoundary.create({ data: header(a) });
        await tx.inventoryBoundarySubsidiary.create({
          data: { boundaryId: id, organisationId: a.organisationId, subsidiaryId: b.subsidiaryId, firstMonth: 1, lastMonth: 12 },
        });
      }),
    );
    expect(FK).toContain(
      await refusedAsOwner(async (tx) => {
        const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
        await tx.inventoryBoundarySite.create({ data: { boundaryId, subsidiaryId: a.subsidiaryId, locationId: siteB, firstMonth: 1, lastMonth: 12 } });
      }),
    );
  });

  it('holds no cell or source at an entity the version does not declare', async () => {
    const otherSite = (await owner.location.create({ data: { subsidiaryId: a.subsidiaryId, name: 'Int-test undeclared site', geographyCode: 'UK' } })).id;
    try {
      expect(FK).toContain(
        await refusedAsOwner(async (tx) => {
          const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
          await tx.inventoryApplicabilityCell.create({
            data: { boundaryId, subsidiaryId: a.subsidiaryId, locationId: otherSite, locationKey: otherSite, category: 'Natural Gas', applicability: 'undetermined', reason: 'Int test' },
          });
        }),
      );
      expect(FK).toContain(
        await refusedAsOwner(async (tx) => {
          const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
          await tx.inventorySource.create({ data: sourceRow(boundaryId, a, { locationId: otherSite, locationKey: otherSite }) });
        }),
      );
    } finally {
      await owner.location.delete({ where: { id: otherSite } });
    }
  });

  const zwsp = String.fromCharCode(0x200b);
  const rlo = String.fromCharCode(0x202e);
  it.each<[string, (boundaryId: string) => (tx: Prisma.TransactionClient) => Promise<unknown>]>([
    ['a confirmed version that is not frozen', () => (tx) =>
      tx.inventoryBoundary.create({ data: header(a, { version: 2, decision: 'confirmed', decidedBy: a.users.superAdmin.id, decidedAt: new Date() }) })],
    ['a decision but confirmed or unconfirmed', () => (tx) => tx.inventoryBoundary.create({ data: header(a, { version: 2, decision: 'final' }) })],
    ['a year out of range', () => (tx) => tx.inventoryBoundary.create({ data: header(a, { version: 2, reportingYear: 1999 }) })],
    ['operating months in reverse', (id) => (tx) =>
      tx.inventoryBoundarySite.update({ where: { boundaryId_locationId: { boundaryId: id, locationId: siteA } }, data: { firstMonth: 9, lastMonth: 3 } })],
    ['a month past December', (id) => (tx) =>
      tx.inventoryBoundarySubsidiary.update({ where: { boundaryId_subsidiaryId: { boundaryId: id, subsidiaryId: a.subsidiaryId } }, data: { lastMonth: 13 } })],
    ['a policy for a Scope 3 category', (id) => (tx) =>
      tx.inventoryAttributionPolicy.create({ data: { boundaryId: id, subsidiaryId: a.subsidiaryId, category: 'Water', level: 'company', reportingPeriod: 'annual' } })],
    ['a level but company or sites', (id) => (tx) =>
      tx.inventoryAttributionPolicy.create({ data: { boundaryId: id, subsidiaryId: a.subsidiaryId, category: 'Fuel', level: 'both', reportingPeriod: 'annual' } })],
    ['an excluded cell with no reason', (id) => (tx) =>
      tx.inventoryApplicabilityCell.create({ data: { boundaryId: id, subsidiaryId: a.subsidiaryId, locationKey: NIL, category: 'Fuel', applicability: 'excluded' } })],
    ['an included cell with a reason', (id) => (tx) =>
      tx.inventoryApplicabilityCell.create({ data: { boundaryId: id, subsidiaryId: a.subsidiaryId, locationKey: NIL, category: 'Fuel', applicability: 'included', reason: 'Why' } })],
    ['a reason with an edge space', (id) => (tx) =>
      tx.inventoryApplicabilityCell.create({ data: { boundaryId: id, subsidiaryId: a.subsidiaryId, locationKey: NIL, category: 'Fuel', applicability: 'excluded', reason: ' Why' } })],
    ['a reason with a zero-width character', (id) => (tx) =>
      tx.inventoryApplicabilityCell.create({ data: { boundaryId: id, subsidiaryId: a.subsidiaryId, locationKey: NIL, category: 'Fuel', applicability: 'excluded', reason: `Wh${zwsp}y` } })],
    ['a company cell whose key is not the nil uuid', (id) => (tx) =>
      tx.inventoryApplicabilityCell.create({ data: { boundaryId: id, subsidiaryId: a.subsidiaryId, locationKey: siteA, category: 'Fuel', applicability: 'undetermined', reason: 'Why' } })],
    ['a mapped Electricity source under Scope 1', (id) => (tx) => tx.inventorySource.create({ data: sourceRow(id, a, { scope: 1 }) })],
    // Review round 2 (architect P2): NULL OR FALSE is NULL, which a CHECK admits.
    ['a mapped source with no category', (id) => (tx) => tx.inventorySource.create({ data: sourceRow(id, a, { category: null, scope: 1 }) })],
    ['a Fuel source with no fuel named (21)', (id) => (tx) =>
      tx.inventorySource.create({ data: sourceRow(id, a, { category: 'Fuel', scope: 1, applicability: 'excluded', reason: 'Why', reportingPeriod: null, evidenceReportingPeriod: null }) })],
    ['an Electricity source naming an activity type', (id) => (tx) =>
      tx.inventorySource.create({ data: sourceRow(id, a, { activityType: 'grid_electricity', applicability: 'excluded', reason: 'Why', reportingPeriod: null, evidenceReportingPeriod: null }) })],
    ['an unsupported source with a category', (id) => (tx) =>
      tx.inventorySource.create({ data: sourceRow(id, a, { mapping: 'unsupported', unsupportedReason: 'No factor' }) })],
    ['an unsupported source with no reason', (id) => (tx) =>
      tx.inventorySource.create({ data: sourceRow(id, a, { mapping: 'unsupported', category: null }) })],
    ['an included source with no cadence', (id) => (tx) =>
      tx.inventorySource.create({ data: sourceRow(id, a, { mapping: 'unsupported', category: null, unsupportedReason: 'No factor', reportingPeriod: null, evidenceReportingPeriod: null }) })],
    ['an excluded source with an evidence cadence', (id) => (tx) =>
      tx.inventorySource.create({ data: sourceRow(id, a, { applicability: 'excluded', reason: 'Why', reportingPeriod: null }) })],
    ['a nameless source', (id) => (tx) => tx.inventorySource.create({ data: sourceRow(id, a, { name: '' }) })],
    ['a source named with a bidi override', (id) => (tx) => tx.inventorySource.create({ data: sourceRow(id, a, { name: `Meter ${rlo}1` }) })],
    ['an included source claiming a key that is not its type', (id) => (tx) => tx.inventorySource.create({ data: sourceRow(id, a, { includedActivityKey: 'other' }) })],
    ['an excluded source claiming a key', (id) => (tx) =>
      tx.inventorySource.create({ data: sourceRow(id, a, { applicability: 'excluded', reason: 'Why', reportingPeriod: null, evidenceReportingPeriod: null, includedActivityKey: '' }) })],
    // Review round 1 (qa-auditor P2-4): the type must be one its category has (recordActivityTypesFor).
    ['a Fuel source naming a refrigerant', (id) => (tx) =>
      tx.inventorySource.create({ data: sourceRow(id, a, { category: 'Fuel', scope: 1, activityType: 'R-410A', applicability: 'excluded', reason: 'Why', reportingPeriod: null, evidenceReportingPeriod: null }) })],
    ['a Mobile Combustion source naming no fuel of the list', (id) => (tx) =>
      tx.inventorySource.create({ data: sourceRow(id, a, { category: 'Mobile Combustion', scope: 1, activityType: 'banana', applicability: 'excluded', reason: 'Why', reportingPeriod: null, evidenceReportingPeriod: null }) })],
    // (architect P3-4): the nil uuid is the company entity's key, never a site.
    ['a site at the nil uuid', (id) => async (tx) => {
      await tx.location.create({ data: { id: NIL, subsidiaryId: a.subsidiaryId, name: 'Int-test nil site', geographyCode: 'UK' } });
      return tx.inventoryBoundarySite.create({ data: { boundaryId: id, subsidiaryId: a.subsidiaryId, locationId: NIL, firstMonth: 7, lastMonth: 12 } });
    }],
  ])('refuses %s (CHECK)', async (_name, write) => {
    expect(
      await refusedAsOwner(async (tx) => {
        const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
        await write(boundaryId)(tx);
      }),
    ).toBe('23514');
  });

  it('names an excluded and an undetermined source beside an included one of the same key (D05), and refuses a second included one', async () => {
    // Review round 1 (architect P2-4, qa-auditor P2-3): only included mapped
    // sources are unique by entity, category and activity type.
    const named = await withRollback(owner, async (tx) => {
      const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
      await tx.inventorySource.create({ data: sourceRow(boundaryId, a, { name: 'Tenant sub-meter', applicability: 'excluded', reason: 'Recharged to the tenant', reportingPeriod: null, evidenceReportingPeriod: null }) });
      await tx.inventorySource.create({ data: sourceRow(boundaryId, a, { name: 'Landlord meter', applicability: 'undetermined', reason: 'Awaiting the lease', reportingPeriod: null, evidenceReportingPeriod: null }) });
      return tx.inventorySource.count({ where: { boundaryId } });
    });
    expect(named).toBe(3);
    expect(['P2002', '23505']).toContain(
      await refusedAsOwner(async (tx) => {
        const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
        await tx.inventorySource.create({ data: sourceRow(boundaryId, a, { name: 'A second included meter' }) });
      }),
    );
  });

  it("keeps a site's months inside its subsidiary's (a site is not in the boundary before its subsidiary is)", async () => {
    // Review round 1 (architect P2-3, qa-auditor P2-5): a subsidiary acquired
    // in July has no site that operated, for this inventory, in June. The
    // fixture's subsidiary operates all year, its site from July.
    expect(
      await refusedAsOwner(async (tx) => {
        const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
        await tx.inventoryBoundarySubsidiary.updateMany({ where: { boundaryId }, data: { firstMonth: 8 } });
      }),
      'the subsidiary shrinks below its site',
    ).toBe('TA014');
    expect(
      await refusedAsOwner(async (tx) => {
        const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
        await tx.inventoryBoundarySubsidiary.updateMany({ where: { boundaryId }, data: { firstMonth: 7 } });
        await tx.inventoryBoundarySite.updateMany({ where: { boundaryId }, data: { firstMonth: 6 } });
      }),
      'the site grows past its subsidiary',
    ).toBe('TA014');
    expect(
      await refusedAsOwner(async (tx) => {
        const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
        await tx.inventoryBoundarySubsidiary.updateMany({ where: { boundaryId }, data: { firstMonth: 7 } });
        const second = await tx.location.create({ data: { subsidiaryId: a.subsidiaryId, name: 'Int-test second site', geographyCode: 'UK' } });
        await tx.inventoryBoundarySite.create({ data: { boundaryId, subsidiaryId: a.subsidiaryId, locationId: second.id, firstMonth: 1, lastMonth: 12 } });
      }),
      'a new site operating before its subsidiary',
    ).toBe('TA014');
    const inside = await withRollback(owner, async (tx) => {
      const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
      await tx.inventoryBoundarySite.updateMany({ where: { boundaryId }, data: { firstMonth: 3, lastMonth: 11 } });
      await tx.inventoryBoundarySubsidiary.updateMany({ where: { boundaryId }, data: { firstMonth: 3, lastMonth: 11 } });
      const site = await tx.inventoryBoundarySite.findFirstOrThrow({ where: { boundaryId } });
      return [site.firstMonth, site.lastMonth];
    });
    expect(inside, 'control: a site inside its subsidiary').toEqual([3, 11]);
  });

  it("holds an included mapped source to its category's policy cadence, and moves it with the policy", async () => {
    expect(FK).toContain(
      await refusedAsOwner(async (tx) => {
        const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
        await tx.inventorySource.create({ data: sourceRow(boundaryId, a, { locationId: null, locationKey: NIL, reportingPeriod: 'quarterly' }) });
      }),
    );
    expect(FK).toContain(
      await refusedAsOwner(async (tx) => {
        const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
        await tx.inventoryAttributionPolicy.deleteMany({ where: { boundaryId } });
      }),
    );
    const followed = await withRollback(owner, async (tx) => {
      const { boundaryId, sourceId } = await createBoundary(tx, a, { locationId: siteA });
      await tx.inventoryAttributionPolicy.updateMany({ where: { boundaryId }, data: { reportingPeriod: 'quarterly' } });
      return (await tx.inventorySource.findUniqueOrThrow({ where: { id: sourceId } })).reportingPeriod;
    });
    expect(followed).toBe('quarterly');
  });
});

describe('a frozen version takes no change (TA014)', () => {
  it('is born unfrozen', async () => {
    expect(await refusedAsOwner((tx) => tx.inventoryBoundary.create({ data: header(a, { version: 3, frozenAt: new Date() }) }))).toBe('TA014');
  });

  it('freezes once, at the database clock as it runs, confirmed at the same instant, with the names and geography as they are (W7)', async () => {
    const seen = await withRollback(owner, async (tx) => {
      await tx.subsidiary.update({ where: { id: a.subsidiaryId }, data: { tradingName: 'Alpha Trading' } });
      const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
      const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
      const frozen = await tx.inventoryBoundary.update({
        where: { id: boundaryId },
        data: { frozenAt: new Date('2000-01-01'), decision: 'confirmed', decidedBy: a.users.superAdmin.id, decidedAt: new Date('2000-01-01') },
      });
      await tx.subsidiary.update({ where: { id: a.subsidiaryId }, data: { tradingName: 'Renamed after the freeze', geographyCode: 'TR' } });
      await tx.location.update({ where: { id: siteA }, data: { name: 'Renamed site' } });
      const company = await tx.inventoryBoundarySubsidiary.findFirstOrThrow({ where: { boundaryId } });
      const site = await tx.inventoryBoundarySite.findFirstOrThrow({ where: { boundaryId } });
      return { now, frozen, company, site };
    });
    // Not the caller's 2000-01-01: the database's clock, as the freeze ran.
    expect(seen.frozen.frozenAt!.getTime()).toBeGreaterThanOrEqual(seen.now.getTime());
    expect(seen.frozen.frozenAt!.getTime() - seen.now.getTime()).toBeLessThan(60_000);
    expect(seen.frozen.decidedAt?.getTime()).toBe(seen.frozen.frozenAt!.getTime());
    expect([seen.company.subsidiaryName, seen.company.geographyCode]).toEqual(['Alpha Trading', 'UK']);
    expect([seen.site.locationName, seen.site.geographyCode]).toEqual(['Int-test site A', 'UK']);
  });

  it('refuses every write the owner tries on a frozen version, and a truncate of any of its tables', async () => {
    const writes: [string, (tx: Prisma.TransactionClient, ids: { boundaryId: string; sourceId: string }) => Promise<unknown>][] = [
      ['header update', (tx, { boundaryId }) => tx.inventoryBoundary.update({ where: { id: boundaryId }, data: { frozenAt: new Date() } })],
      ['header unfreeze', (tx, { boundaryId }) => tx.$executeRaw`UPDATE inventory_boundaries SET frozen_at = NULL WHERE id = ${boundaryId}::uuid`],
      ['header delete', (tx, { boundaryId }) => tx.inventoryBoundary.delete({ where: { id: boundaryId } })],
      ['subsidiary months', (tx, { boundaryId }) => tx.inventoryBoundarySubsidiary.updateMany({ where: { boundaryId }, data: { firstMonth: 2 } })],
      ['subsidiary delete', (tx, { boundaryId }) => tx.inventoryBoundarySubsidiary.deleteMany({ where: { boundaryId } })],
      ['site rename', (tx, { boundaryId }) => tx.inventoryBoundarySite.updateMany({ where: { boundaryId }, data: { locationName: 'Forged' } })],
      ['policy cadence', (tx, { boundaryId }) => tx.inventoryAttributionPolicy.updateMany({ where: { boundaryId }, data: { reportingPeriod: 'annual' } })],
      ['new policy', (tx, { boundaryId }) =>
        tx.inventoryAttributionPolicy.create({ data: { boundaryId, subsidiaryId: a.subsidiaryId, category: 'Fuel', level: 'company', reportingPeriod: 'annual' } })],
      ['cell flipped', (tx, { boundaryId }) =>
        tx.inventoryApplicabilityCell.updateMany({ where: { boundaryId }, data: { applicability: 'excluded', reason: 'Forged' } })],
      ['source renamed', (tx, { sourceId }) => tx.inventorySource.update({ where: { id: sourceId }, data: { name: 'Forged' } })],
      ['source deleted', (tx, { sourceId }) => tx.inventorySource.delete({ where: { id: sourceId } })],
    ];
    for (const [name, write] of writes) {
      const code = await refusedAsOwner(async (tx) => {
        const ids = await createBoundary(tx, a, { locationId: siteA, frozen: true });
        await write(tx, ids);
      });
      expect(code, name).toBe('TA014');
    }
    for (const table of ['inventory_boundaries', 'inventory_boundary_subsidiaries', 'inventory_boundary_sites', 'inventory_attribution_policies', 'inventory_applicability_cells', 'inventory_sources']) {
      expect(await refusedAsOwner((tx) => tx.$executeRawUnsafe(`TRUNCATE "${table}" CASCADE`)), table).toBe('TA014');
    }
  });

  it("lets the owner change and delete an open version's rows, table by table", async () => {
    const left = await withRollback(owner, async (tx) => {
      const { boundaryId, sourceId } = await createBoundary(tx, a, { locationId: siteA });
      await tx.inventorySource.update({ where: { id: sourceId }, data: { name: 'Renamed meter' } });
      await tx.inventorySource.delete({ where: { id: sourceId } });
      await tx.inventoryApplicabilityCell.deleteMany({ where: { boundaryId } });
      await tx.inventoryAttributionPolicy.updateMany({ where: { boundaryId }, data: { level: 'company' } });
      await tx.inventoryAttributionPolicy.deleteMany({ where: { boundaryId } });
      await tx.inventoryBoundarySite.deleteMany({ where: { boundaryId } });
      await tx.inventoryBoundarySubsidiary.deleteMany({ where: { boundaryId } });
      return tx.inventoryBoundary.count({ where: { id: boundaryId, subsidiaries: { some: {} } } });
    });
    expect(left).toBe(0);
  });

  it('freezes only in READ COMMITTED — a stricter snapshot could freeze rows it never saw (W8)', async () => {
    // Review round 1 (architect P2-2, security-rls P2-1, reproduced there): a
    // REPEATABLE READ freeze waits on a row writer's FOR SHARE, sees no
    // serialization failure once it commits, and copies names in a snapshot
    // that misses that row.
    for (const isolationLevel of [Prisma.TransactionIsolationLevel.RepeatableRead, Prisma.TransactionIsolationLevel.Serializable]) {
      const outcome = await failure(
        owner.$transaction(async (tx) => {
          const { boundaryId } = await createBoundary(tx, a, { locationId: siteA, version: 70 });
          await tx.inventoryBoundary.update({ where: { id: boundaryId }, data: { frozenAt: new Date() } });
          throw new Error('frozen — rolled back');
        }, { isolationLevel }),
      );
      expect(sqlstateOf(outcome), isolationLevel).toBe('TA014');
    }
  });

  it("refuses to freeze a version whose site operates outside its subsidiary's months — what two writers could pass between them", async () => {
    // Two writers each pass the rows' guard (one widens a site, the other
    // narrows its subsidiary) but not together; the freeze holds the whole
    // version. Planted here with the rows' guard switched off, in the
    // rolled-back transaction alone.
    expect(
      await refusedAsOwner(async (tx) => {
        // The fixture's subsidiary operates all year, its site from July.
        const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
        await tx.$executeRawUnsafe('ALTER TABLE "inventory_boundary_subsidiaries" DISABLE TRIGGER "inventory_boundary_subsidiaries_frozen"');
        await tx.inventoryBoundarySubsidiary.updateMany({ where: { boundaryId }, data: { firstMonth: 8 } });
        await tx.$executeRawUnsafe('ALTER TABLE "inventory_boundary_subsidiaries" ENABLE ALWAYS TRIGGER "inventory_boundary_subsidiaries_frozen"');
        await tx.inventoryBoundary.update({ where: { id: boundaryId }, data: { frozenAt: new Date() } });
      }),
    ).toBe('TA014');
  });

  it("holds the months rule between two writers of an open version: a site written while its subsidiary narrows (review round 2)", async () => {
    // The site's writer reads its subsidiary's months FOR SHARE, so a writer
    // narrowing them waits, then sees the site and refuses.
    const { boundaryId } = await createBoundary(owner, a, { locationId: siteA, version: 72 });
    const site = await owner.location.create({ data: { subsidiaryId: a.subsidiaryId, name: 'Int-test early site', geographyCode: 'UK' } });
    const wrote = deferred();
    const gate = deferred();
    const writer = ownerB.$transaction(async (tx) => {
      await tx.inventoryBoundarySite.create({ data: { boundaryId, subsidiaryId: a.subsidiaryId, locationId: site.id, firstMonth: 1, lastMonth: 12 } });
      wrote.resolve();
      await gate.promise;
    }, { timeout: 30_000 });
    const narrower = connectOwner(1);
    let narrow: Promise<unknown> | undefined;
    try {
      await wrote.promise;
      const pid = await backendPid(narrower);
      narrow = narrower.inventoryBoundarySubsidiary.updateMany({ where: { boundaryId }, data: { firstMonth: 7 } });
      expect(await settledOrBlocked(narrow, pid, observer)).toBe('blocked');
    } finally {
      gate.resolve();
      await writer;
      await narrow?.catch(() => undefined);
      await narrower.$disconnect();
    }
    expect(sqlstateOf(await failure(narrow!))).toBe('TA014');
    const months = await owner.inventoryBoundarySubsidiary.findFirstOrThrow({ where: { boundaryId } });
    expect(months.firstMonth).toBe(1);
    await owner.inventoryBoundary.delete({ where: { id: boundaryId } });
    await owner.location.delete({ where: { id: site.id } });
  });

  it('copies the names of a row written while the freeze waited, once that row commits', async () => {
    const { boundaryId } = await createBoundary(owner, a, { locationId: siteA, version: 71 });
    const second = await owner.location.create({ data: { subsidiaryId: a.subsidiaryId, name: 'Int-test row-first site', geographyCode: 'TR' } });
    const wrote = deferred();
    const gate = deferred();
    const writer = ownerB.$transaction(async (tx) => {
      await tx.inventoryBoundarySite.create({ data: { boundaryId, subsidiaryId: a.subsidiaryId, locationId: second.id, firstMonth: 9, lastMonth: 12 } });
      wrote.resolve();
      await gate.promise;
    }, { timeout: 30_000 });
    const freezer = connectOwner(1);
    let freeze: Promise<unknown> | undefined;
    try {
      await wrote.promise;
      const pid = await backendPid(freezer);
      freeze = freezer.inventoryBoundary.update({ where: { id: boundaryId }, data: { frozenAt: new Date() } });
      // The freeze waits on the writer's share lock of the header.
      expect(await settledOrBlocked(freeze, pid, observer)).toBe('blocked');
    } finally {
      gate.resolve();
      await writer;
      await freeze?.catch(() => undefined);
      await freezer.$disconnect();
    }
    await freeze;
    const row = await owner.inventoryBoundarySite.findUniqueOrThrow({ where: { boundaryId_locationId: { boundaryId, locationId: second.id } } });
    expect([row.locationName, row.geographyCode]).toEqual(['Int-test row-first site', 'TR']);
  });

  it('stamps the freeze with the time it ran, not the start of its transaction (security-rls P3-1)', async () => {
    const seen = await withRollback(owner, async (tx) => {
      const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
      await tx.$executeRaw`SELECT pg_sleep(0.3)`;
      const frozen = await tx.inventoryBoundary.update({
        where: { id: boundaryId },
        data: { frozenAt: new Date(), decision: 'confirmed', decidedBy: a.users.superAdmin.id, decidedAt: new Date() },
      });
      const [{ started }] = await tx.$queryRaw<{ started: Date }[]>`SELECT now() AS started`;
      return { frozen, started };
    });
    expect(seen.frozen.frozenAt!.getTime() - seen.started.getTime()).toBeGreaterThanOrEqual(250);
    expect(seen.frozen.decidedAt!.getTime()).toBe(seen.frozen.frozenAt!.getTime());
  });

  it('keeps every row its key — a policy is not re-keyed under its sources, nor a source moved (review round 1)', async () => {
    // Architect P2-1, qa-auditor P2-2: the cadence key's ON UPDATE CASCADE
    // carried a policy's new category or subsidiary into its sources.
    const other = async (tx: Prisma.TransactionClient, boundaryId: string) => {
      const sub = await tx.subsidiary.create({ data: { organisationId: a.organisationId, legalName: 'Int-test second declared subsidiary', geographyCode: 'UK' } });
      await tx.inventoryBoundarySubsidiary.create({ data: { boundaryId, organisationId: a.organisationId, subsidiaryId: sub.id, firstMonth: 1, lastMonth: 12 } });
      return sub.id;
    };
    const rekeys: [string, (tx: Prisma.TransactionClient, ids: { boundaryId: string; sourceId: string }) => Promise<unknown>][] = [
      ['policy category', (tx, { boundaryId }) => tx.inventoryAttributionPolicy.updateMany({ where: { boundaryId }, data: { category: 'Natural Gas' } })],
      ['policy subsidiary', async (tx, { boundaryId }) => {
        const sub = await other(tx, boundaryId);
        return tx.inventoryAttributionPolicy.updateMany({ where: { boundaryId }, data: { subsidiaryId: sub } });
      }],
      ['cell category', (tx, { boundaryId }) => tx.inventoryApplicabilityCell.updateMany({ where: { boundaryId }, data: { category: 'Natural Gas' } })],
      ['source to the company entity', (tx, { sourceId }) =>
        tx.inventorySource.update({ where: { id: sourceId }, data: { locationId: null, locationKey: NIL, applicability: 'excluded', reason: 'Moved', reportingPeriod: null, evidenceReportingPeriod: null } })],
      ['site to another location', async (tx, { boundaryId }) => {
        const loc = await tx.location.create({ data: { subsidiaryId: a.subsidiaryId, name: 'Int-test moved site', geographyCode: 'UK' } });
        return tx.$executeRaw`UPDATE inventory_boundary_sites SET location_id = ${loc.id}::uuid WHERE boundary_id = ${boundaryId}::uuid`;
      }],
    ];
    for (const [name, rekey] of rekeys) {
      const code = await refusedAsOwner(async (tx) => {
        const ids = await createBoundary(tx, a, { locationId: siteA });
        await rekey(tx, ids);
      });
      expect(code, name).toBe('TA014');
    }
  });

  it('refuses, failing closed, a table the rows\' guard does not know (review round 2)', async () => {
    expect(
      await refusedAsOwner(async (tx) => {
        await tx.$executeRawUnsafe('CREATE TABLE "int_test_stray" ("boundary_id" uuid)');
        await tx.$executeRawUnsafe(
          'CREATE TRIGGER "int_test_stray_frozen" BEFORE INSERT ON "int_test_stray" FOR EACH ROW EXECUTE FUNCTION "public"."inventory_boundary_rows_frozen"()',
        );
        await tx.$executeRawUnsafe('INSERT INTO "int_test_stray" VALUES (gen_random_uuid())');
      }),
    ).toBe('TA014');
  });

  it('keeps an open version its identity, and every row in its version', async () => {
    expect(
      await refusedAsOwner(async (tx) => {
        const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
        await tx.inventoryBoundary.update({ where: { id: boundaryId }, data: { version: 9 } });
      }),
    ).toBe('TA014');
    expect(
      await refusedAsOwner(async (tx) => {
        const first = await createBoundary(tx, a, { locationId: siteA });
        const second = await createBoundary(tx, a, { locationId: siteA, version: 2 });
        await tx.$executeRaw`UPDATE inventory_sources SET boundary_id = ${second.boundaryId}::uuid WHERE id = ${first.sourceId}::uuid`;
      }),
    ).toBe('TA014');
  });

  it('refuses a row written while its version freezes, once the freeze commits', async () => {
    const { boundaryId } = await createBoundary(owner, a, { locationId: siteA, version: 10 });
    const froze = deferred();
    const gate = deferred();
    const freeze = owner.$transaction(async (tx) => {
      await tx.inventoryBoundary.update({ where: { id: boundaryId }, data: { frozenAt: new Date() } });
      froze.resolve();
      await gate.promise;
    }, { timeout: 30_000 });
    let late: Promise<unknown> | undefined;
    try {
      await froze.promise;
      const pid = await backendPid(ownerB);
      late = ownerB.inventoryApplicabilityCell.create({
        data: { boundaryId, subsidiaryId: a.subsidiaryId, locationKey: NIL, category: 'Natural Gas', applicability: 'undetermined', reason: 'Written during the freeze' },
      });
      expect(await settledOrBlocked(late, pid, observer)).toBe('blocked');
    } finally {
      gate.resolve();
      await freeze;
    }
    expect(sqlstateOf(await failure(late!))).toBe('TA014');
    expect(await owner.inventoryApplicabilityCell.count({ where: { boundaryId, category: 'Natural Gas' } })).toBe(0);
  });
});

describe('deletion: a declared subsidiary or site stays (W9); the organisation takes its versions (W10)', () => {
  it('refuses the owner deleting a declared site or subsidiary, open version or frozen', async () => {
    for (const frozen of [false, true]) {
      expect(
        await refusedAsOwner(async (tx) => {
          await createBoundary(tx, a, { locationId: siteA, frozen });
          await tx.location.delete({ where: { id: siteA } });
        }),
        `site, frozen ${frozen}`,
      ).toBe('TA014');
      expect(
        await refusedAsOwner(async (tx) => {
          await createBoundary(tx, a, { locationId: siteA, frozen });
          await tx.subsidiary.delete({ where: { id: a.subsidiaryId } });
        }),
        `subsidiary, frozen ${frozen}`,
      ).toBe('TA014');
      // Declared at company level alone — no site of it in the version, so
      // the subsidiary's own check, not a site's, is what refuses.
      expect(
        await refusedAsOwner(async (tx) => {
          const bare = await tx.subsidiary.create({ data: { organisationId: a.organisationId, legalName: 'Int-test company-only subsidiary', geographyCode: 'UK' } });
          const { id } = await tx.inventoryBoundary.create({ data: header(a, { version: 50 }) });
          await tx.inventoryBoundarySubsidiary.create({
            data: { boundaryId: id, organisationId: a.organisationId, subsidiaryId: bare.id, firstMonth: 1, lastMonth: 12 },
          });
          if (frozen) await tx.inventoryBoundary.update({ where: { id }, data: { frozenAt: new Date() } });
          await tx.subsidiary.delete({ where: { id: bare.id } });
        }),
        `company-only subsidiary, frozen ${frozen}`,
      ).toBe('TA014');
    }
  });

  it('deletes an open version whole, and its organisation with its frozen versions — whatever order the cascades run in', async () => {
    const left = await withRollback(owner, async (tx) => {
      const open = await createBoundary(tx, b, { locationId: siteB });
      await tx.inventoryBoundary.delete({ where: { id: open.boundaryId } });
      const afterOpen = await tx.inventorySource.count({ where: { boundaryId: open.boundaryId } });
      await createBoundary(tx, b, { locationId: siteB, version: 2, frozen: true });
      await createBoundary(tx, b, { locationId: siteB, version: 3, frozen: true });
      await tx.organisation.delete({ where: { id: b.organisationId } });
      const rows = await Promise.all([
        tx.inventoryBoundary.count({ where: { organisationId: b.organisationId } }),
        tx.inventoryBoundarySubsidiary.count({ where: { organisationId: b.organisationId } }),
        tx.inventoryBoundarySite.count({ where: { subsidiaryId: b.subsidiaryId } }),
        tx.inventorySource.count({ where: { subsidiaryId: b.subsidiaryId } }),
      ]);
      return { afterOpen, rows };
    });
    expect(left).toEqual({ afterOpen: 0, rows: [0, 0, 0, 0] });
  });

  it('answers the API 409, not 500, for a declared site or subsidiary — and for a version declaring the site after the check', async () => {
    const audit = new AuditService(runtime);
    const locations = new LocationsService(runtime, audit);
    const subsidiaries = new SubsidiariesService(runtime, audit, locations);
    const site = (await owner.location.create({ data: { subsidiaryId: a.subsidiaryId, name: 'Int-test declared site', geographyCode: 'UK' } })).id;
    const open = await createBoundary(owner, a, { locationId: site, version: 20 });
    try {
      const siteRefusal = await failure(locations.remove(a.users.superAdmin, site));
      expect(siteRefusal).toBeInstanceOf(ConflictException);
      expect((siteRefusal as Error).message).toMatch(/declared in 1 inventory boundary version\(s\)/);
    } finally {
      await owner.inventoryBoundary.delete({ where: { id: open.boundaryId } });
    }
    const openB = await createBoundary(owner, b, { locationId: siteB, version: 20 });
    try {
      const refusal = await failure(subsidiaries.remove(b.users.superAdmin, b.subsidiaryId));
      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as Error).message).toMatch(/1 open inventory boundary version\(s\) declaring it/);
    } finally {
      await owner.inventoryBoundary.delete({ where: { id: openB.boundaryId } });
    }
    // A frozen version keeps its subsidiary for good (deleted with the
    // organisation in afterAll).
    await createBoundary(owner, a, { locationId: siteA, version: 22, frozen: true });
    const kept = await failure(subsidiaries.remove(a.users.superAdmin, a.subsidiaryId));
    expect(kept).toBeInstanceOf(ConflictException);
    expect((kept as Error).message).toMatch(/declared in \d+ confirmed or captured inventory boundary version\(s\)[\s\S]*"inactive"/);

    // The race: the check passes, then a version declares the site before
    // the delete runs — the guard's TA014 answers the same 409.
    const hold = holdBefore(runtime, 'Location', 'delete');
    const raced = new LocationsService(hold.client, new AuditService(hold.client)).remove(a.users.superAdmin, site);
    let late: { boundaryId: string } | undefined;
    try {
      await hold.reached();
      late = await createBoundary(owner, a, { locationId: site, version: 21 });
    } finally {
      hold.release();
    }
    const racedRefusal = await failure(raced);
    expect(racedRefusal).toBeInstanceOf(ConflictException);
    expect((racedRefusal as Error).message).toMatch(/declared in 1 inventory boundary version\(s\)/);
    await owner.inventoryBoundary.delete({ where: { id: late!.boundaryId } });
    expect(await owner.location.count({ where: { id: site } })).toBe(1);
    await owner.location.delete({ where: { id: site } });
  });
});

describe('RLS and the client roles', () => {
  /** Rows of the version `userId` sees through RLS (PostgREST's role), per table. */
  async function seenAs(tx: Prisma.TransactionClient, role: 'anon' | 'authenticated', userId: string | null, boundaryId: string) {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
    if (userId) {
      await tx.$executeRaw`SELECT set_config('request.jwt.claim.sub', ${userId}, true),
                                  set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role })}, true)`;
    }
    const seen: number[] = [];
    for (const [table, column] of [
      ['inventory_boundaries', 'id'], ['inventory_boundary_subsidiaries', 'boundary_id'], ['inventory_boundary_sites', 'boundary_id'],
      ['inventory_attribution_policies', 'boundary_id'], ['inventory_applicability_cells', 'boundary_id'], ['inventory_sources', 'boundary_id'],
    ]) {
      const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = $1::uuid`, boundaryId);
      seen.push(n);
    }
    await tx.$executeRawUnsafe('RESET ROLE');
    return seen;
  }

  it('shows a data_entry user a version only through a declared subsidiary it is granted (W3)', async () => {
    const seen = await withRollback(owner, async (tx) => {
      const declared = await createBoundary(tx, a, { locationId: siteA });
      // A second subsidiary of A's, not granted to A's data_entry user, alone in its own version.
      const other = await tx.subsidiary.create({ data: { organisationId: a.organisationId, legalName: 'Int-test other subsidiary', geographyCode: 'UK' } });
      const otherSite = await tx.location.create({ data: { subsidiaryId: other.id, name: 'Int-test other site', geographyCode: 'UK' } });
      const undeclared = await createBoundary(tx, { ...a, subsidiaryId: other.id }, { locationId: otherSite.id, version: 2 });
      return {
        entryDeclared: await seenAs(tx, 'authenticated', a.users.dataEntry.id, declared.boundaryId),
        entryOther: await seenAs(tx, 'authenticated', a.users.dataEntry.id, undeclared.boundaryId),
        consultantOther: await seenAs(tx, 'authenticated', a.users.consultant.id, undeclared.boundaryId),
        foreignAdmin: await seenAs(tx, 'authenticated', b.users.superAdmin.id, declared.boundaryId),
        anon: await seenAs(tx, 'anon', null, declared.boundaryId),
      };
    });
    expect(seen).toEqual({
      entryDeclared: [1, 1, 1, 1, 1, 1],
      entryOther: [0, 0, 0, 0, 0, 0],
      consultantOther: [1, 1, 1, 1, 1, 1],
      foreignAdmin: [0, 0, 0, 0, 0, 0],
      anon: [0, 0, 0, 0, 0, 0],
    });
  });

  it('shows a data_entry user only its granted subsidiary\'s rows of a version that also declares another (security-rls P3-4)', async () => {
    const seen = await withRollback(owner, async (tx) => {
      const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
      const other = await tx.subsidiary.create({ data: { organisationId: a.organisationId, legalName: 'Int-test ungranted subsidiary', geographyCode: 'UK' } });
      const otherSite = await tx.location.create({ data: { subsidiaryId: other.id, name: 'Int-test ungranted site', geographyCode: 'UK' } });
      await createRows(tx, boundaryId, a.organisationId, other.id, otherSite.id);
      return {
        entry: await seenAs(tx, 'authenticated', a.users.dataEntry.id, boundaryId),
        consultant: await seenAs(tx, 'authenticated', a.users.consultant.id, boundaryId),
      };
    });
    expect(seen.entry).toEqual([1, 1, 1, 1, 1, 1]);
    expect(seen.consultant).toEqual([1, 2, 2, 2, 2, 2]);
  });

  it('lets no client role, the service role included, and not the runtime role, write a row (42501)', async () => {
    for (const role of ['authenticated', 'service_role']) {
      const code = await refusedAsOwner(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
        await tx.$executeRaw`INSERT INTO inventory_boundaries (id, organisation_id, reporting_year, version, created_by)
                             VALUES (gen_random_uuid(), ${a.organisationId}::uuid, 2026, 30, gen_random_uuid())`;
      });
      expect(code, role).toBe('42501');
    }
    const fixture = await createBoundary(owner, a, { locationId: siteA, version: 31 });
    try {
      expect(sqlstateOf(await failure(runtime.inventorySource.update({ where: { id: fixture.sourceId }, data: { name: 'Forged' } })))).toBe('42501');
      expect(sqlstateOf(await failure(runtime.inventoryBoundary.delete({ where: { id: fixture.boundaryId } })))).toBe('42501');
    } finally {
      await owner.inventoryBoundary.delete({ where: { id: fixture.boundaryId } });
    }
  });
});

describe('one capture snapshot: the reader and the one factor lookup', () => {
  const capture = <T>(fn: (snapshot: CaptureSnapshot) => Promise<T>) =>
    runtime.$transaction(async (tx) => fn(await CaptureSnapshot.open(tx)), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    });

  it('refuses a READ COMMITTED transaction and the root client', async () => {
    expect(await failure(runtime.$transaction((tx) => CaptureSnapshot.open(tx)))).toBeInstanceOf(CaptureSnapshotError);
    expect(await failure(CaptureSnapshot.open(runtime as unknown as Prisma.TransactionClient))).toBeInstanceOf(CaptureSnapshotError);
    await expect(capture(async () => 'opened')).resolves.toBe('opened');
  });

  it('reads a version whole, bound to its organisation and to the caller\'s current access', async () => {
    const fixture = await createBoundary(owner, a, { locationId: siteA, version: 40 });
    try {
      const seen = await capture(async (snapshot) => ({
        mine: await readInventoryBoundary(snapshot, { boundaryId: fixture.boundaryId, organisationId: a.organisationId, accessibleSubsidiaryIds: [a.subsidiaryId] }),
        otherOrganisation: await readInventoryBoundary(snapshot, { boundaryId: fixture.boundaryId, organisationId: b.organisationId, accessibleSubsidiaryIds: [a.subsidiaryId, b.subsidiaryId] }),
        noAccess: await readInventoryBoundary(snapshot, { boundaryId: fixture.boundaryId, organisationId: a.organisationId, accessibleSubsidiaryIds: [b.subsidiaryId] }),
      }));
      expect(seen.otherOrganisation).toBeNull();
      expect(seen.noAccess).toBeNull();
      expect(seen.mine).toMatchObject({
        id: fixture.boundaryId, version: 40, organisationId: a.organisationId, reportingYear: 2026, subsidiaryIds: [a.subsidiaryId], decision: 'unconfirmed',
        attribution: [{ subsidiaryId: a.subsidiaryId, category: 'Electricity', level: 'sites', reportingPeriod: 'monthly' }],
        applicability: [{ subsidiaryId: a.subsidiaryId, locationId: siteA, category: 'Electricity', applicability: 'included', sourceIds: [fixture.sourceId] }],
      });
      const [meter] = seen.mine!.sources;
      expect(meter.entity).toMatchObject({ locationId: siteA, locationName: 'Int-test site A', firstMonth: 7, lastMonth: 12 });
      expect(meter.applicability === 'included' && meter.obligations.map((o) => o.id)).toEqual(
        ['July', 'August', 'September', 'October', 'November', 'December'].map((m) => `${fixture.sourceId}:${m}`),
      );
    } finally {
      await owner.inventoryBoundary.delete({ where: { id: fixture.boundaryId } });
    }
  });

  it('answers a version declaring any subsidiary outside the caller\'s access as not found, and an empty one too (qa-auditor P1-1)', async () => {
    const other = await owner.subsidiary.create({ data: { organisationId: a.organisationId, legalName: 'Int-test second subsidiary of A', geographyCode: 'UK' } });
    const otherSite = await owner.location.create({ data: { subsidiaryId: other.id, name: 'Int-test second site of A', geographyCode: 'UK' } });
    const mixed = await createBoundary(owner, a, { locationId: siteA, version: 42 });
    await createRows(owner, mixed.boundaryId, a.organisationId, other.id, otherSite.id);
    const empty = await owner.inventoryBoundary.create({ data: header(a, { version: 43 }) });
    try {
      const seen = await capture(async (snapshot) => ({
        partial: await readInventoryBoundary(snapshot, { boundaryId: mixed.boundaryId, organisationId: a.organisationId, accessibleSubsidiaryIds: [a.subsidiaryId] }),
        whole: await readInventoryBoundary(snapshot, { boundaryId: mixed.boundaryId, organisationId: a.organisationId, accessibleSubsidiaryIds: [a.subsidiaryId, other.id] }),
        empty: await readInventoryBoundary(snapshot, { boundaryId: empty.id, organisationId: a.organisationId, accessibleSubsidiaryIds: [a.subsidiaryId, other.id] }),
      }));
      expect(seen.partial).toBeNull();
      expect(seen.empty).toBeNull();
      expect(seen.whole?.subsidiaryIds).toEqual([a.subsidiaryId, other.id].sort());
    } finally {
      await owner.inventoryBoundary.deleteMany({ where: { id: { in: [mixed.boundaryId, empty.id] } } });
      await owner.location.delete({ where: { id: otherSite.id } });
      await owner.subsidiary.delete({ where: { id: other.id } });
    }
  });

  it('refuses a snapshot it did not open, however it was made (security-rls P3-2)', async () => {
    // Made from the prototype, with the transaction a real one exposes: `instanceof` passes, `#tx` is absent.
    const forged = Object.defineProperty(Object.create(CaptureSnapshot.prototype), 'tx', { value: runtime }) as CaptureSnapshot;
    expect(forged).toBeInstanceOf(CaptureSnapshot);
    expect(
      await failure(readInventoryBoundary(forged, { boundaryId: randomUUID(), organisationId: a.organisationId, accessibleSubsidiaryIds: [a.subsidiaryId] })),
    ).toBeInstanceOf(CaptureSnapshotError);
    const engine = new CalculationsService(runtime, INT_FACTOR_POLICY);
    expect(
      await failure(engine.lookupFactorPath({ category: 'Electricity', activityType: 'grid_electricity', geographyCode: 'UK', reportingYear: 2087 }, 'kWh', forged)),
    ).toBeInstanceOf(CaptureSnapshotError);
  });

  it('holds its snapshot while another session renames a site and withdraws the factor it priced with', async () => {
    const fixture = await createBoundary(owner, a, { locationId: siteA, version: 41 });
    const release = await owner.$transaction(async (tx) => {
      const [{ next }] = await tx.$queryRaw<{ next: number }[]>`
        SELECT COALESCE(max(ordinal), 0) + 1 AS next FROM factor_releases WHERE publisher = 'TonyAI test fixture'`;
      const created = await tx.factorRelease.create({
        data: { publisher: 'TonyAI test fixture', title: 'Int test', edition: `int-${randomUUID()}`, ordinal: Number(next), status: 'fixture' },
      });
      await tx.emissionFactor.create({
        data: {
          releaseId: created.id, version: created.edition, category: 'Electricity', activityType: 'grid_electricity', gas: 'CO2e', gasCoverage: 'all_ghg',
          geographyCode: 'UK', reportingYear: 2087, dataYear: 2087, scope: 2, scope2Method: scope2MethodFor('Electricity'),
          calorificBasis: directCalorificBasisFor('Electricity', 'kWh'), factorValue: 0.2, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh',
          methodology: 'int test', source: 'int test',
        },
      });
      return tx.factorRelease.update({ where: { id: created.id }, data: { sealedAt: new Date() } });
    });
    const engine = new CalculationsService(runtime, INT_FACTOR_POLICY);
    const key = { category: 'Electricity', activityType: 'grid_electricity', geographyCode: 'UK', reportingYear: 2087 };
    try {
      const seen = await capture(async (snapshot) => {
        const before = {
          site: (await readInventoryBoundary(snapshot, { boundaryId: fixture.boundaryId, organisationId: a.organisationId, accessibleSubsidiaryIds: [a.subsidiaryId] }))!
            .entities.find((e) => e.locationId === siteA)!.locationName,
          factor: await engine.lookupFactorPath(key, 'kWh', snapshot),
        };
        // Another session commits while this capture is reading.
        await ownerB.location.update({ where: { id: siteA }, data: { name: 'Renamed mid-capture' } });
        await ownerB.$executeRaw`UPDATE factor_releases
          SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = 'int-test', withdrawal_reason = 'Int-test erratum'
          WHERE id = ${release.id}::uuid`;
        const after = {
          site: (await readInventoryBoundary(snapshot, { boundaryId: fixture.boundaryId, organisationId: a.organisationId, accessibleSubsidiaryIds: [a.subsidiaryId] }))!
            .entities.find((e) => e.locationId === siteA)!.locationName,
          factor: await engine.lookupFactorPath(key, 'kWh', snapshot),
        };
        return { before, after };
      });
      expect(seen.before.site).toBe('Int-test site A');
      expect(seen.after.site).toBe('Int-test site A');
      expect(seen.before.factor.ok && seen.before.factor.factor.releaseId).toBe(release.id);
      expect(seen.after.factor.ok && seen.after.factor.factor.releaseId).toBe(release.id);
      // Outside the capture, the erratum is in force.
      expect(await engine.lookupFactorPath(key, 'kWh')).toEqual({ ok: false, code: 'no_factor' });
    } finally {
      await owner.location.update({ where: { id: siteA }, data: { name: 'Int-test site A' } });
      await owner.inventoryBoundary.delete({ where: { id: fixture.boundaryId } });
      await owner.emissionFactor.deleteMany({ where: { releaseId: release.id } });
      await owner.factorRelease.deleteMany({ where: { id: release.id } });
    }
  });
});
