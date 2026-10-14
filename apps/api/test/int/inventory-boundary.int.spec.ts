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
const sourceRow = (boundaryId: string, tenant: Tenant, over: Partial<Prisma.InventorySourceUncheckedCreateInput> = {}) => ({
  id: randomUUID(), boundaryId, subsidiaryId: tenant.subsidiaryId, locationId: siteA, locationKey: siteA,
  name: 'Int-test meter', scope: 2, mapping: 'mapped', category: 'Electricity', activityKey: '',
  applicability: 'included', reportingPeriod: 'monthly', evidenceReportingPeriod: 'monthly', ...over,
});

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
    ['a Fuel source with no fuel named (21)', (id) => (tx) =>
      tx.inventorySource.create({ data: sourceRow(id, a, { category: 'Fuel', scope: 1, applicability: 'excluded', reason: 'Why', reportingPeriod: null, evidenceReportingPeriod: null }) })],
    ['an Electricity source naming an activity type', (id) => (tx) =>
      tx.inventorySource.create({ data: sourceRow(id, a, { activityType: 'grid_electricity', activityKey: 'grid_electricity', applicability: 'excluded', reason: 'Why', reportingPeriod: null, evidenceReportingPeriod: null }) })],
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
    ['an activity key that is not its type', (id) => (tx) => tx.inventorySource.create({ data: sourceRow(id, a, { activityKey: 'other' }) })],
  ])('refuses %s (CHECK)', async (_name, write) => {
    expect(
      await refusedAsOwner(async (tx) => {
        const { boundaryId } = await createBoundary(tx, a, { locationId: siteA });
        await write(boundaryId)(tx);
      }),
    ).toBe('23514');
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

  it('freezes once, at the database clock, confirmed at the same instant, with the names and geography as they are (W7)', async () => {
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
    expect(seen.frozen.frozenAt?.getTime()).toBe(seen.now.getTime());
    expect(seen.frozen.decidedAt?.getTime()).toBe(seen.now.getTime());
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
