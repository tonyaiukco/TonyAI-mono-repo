import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@tonyai/db';
import { allowedChildTypes, type NodeType } from '@tonyai/shared-types';
import { AuditService } from '../../src/audit/audit.service';
import { AccessAdminService } from '../../src/auth/access-admin.service';
import type { RequestUser } from '../../src/auth/auth.types';
import { CalculationsService } from '../../src/calculations/calculations.service';
import { EmissionsService } from '../../src/emissions/emissions.service';
import { InventoryBoundariesService } from '../../src/inventory-boundary/inventory-boundaries.service';
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
  recordInput,
  settledOrBlocked,
  withRollback,
  type Tenant,
} from './db';

/**
 * The group tree on the real database (inc26-group-tree, tasks 2.5, 2.6, 3.3,
 * 4.3, 4.5, 5.3): the migration's carry-over, triggers TA018–TA022 for the
 * runtime role and the owner, the races they close at READ COMMITTED on two
 * connections, and the API answering a refusal reached through a race with
 * its own code.
 */

let owner: PrismaService;
let runtime: PrismaService;
let other: PrismaService;
let tenant: Tenant;

beforeAll(() => {
  owner = connectOwner(2);
  runtime = connect();
  other = connect();
});

afterAll(async () => {
  await owner.$disconnect();
  await runtime.$disconnect();
  await other.$disconnect();
});

beforeEach(async () => {
  tenant = await createTenant();
});

afterEach(async () => {
  await tenant?.cleanup();
});

/** The SQLSTATE a write was refused with (a trigger's, a CHECK's, a key's). */
function sqlstate(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2010') return String((e.meta as { code?: unknown } | undefined)?.code ?? '');
    if (e.code === 'P2003') return '23503';
    return e.code;
  }
  if (e instanceof Prisma.PrismaClientUnknownRequestError) {
    return /PostgresError \{ code: "([0-9A-Z]{5})"/.exec(e.message)?.[1] ?? null;
  }
  return null;
}
async function refused(write: Promise<unknown>): Promise<{ state: string | null; message: string }> {
  try {
    await write;
  } catch (e) {
    return { state: sqlstate(e), message: (e as Error).message };
  }
  throw new Error('expected the database to refuse this write');
}

/** A node of the tenant's organisation, written by the owner. */
async function node(
  data: { nodeType: 'sub_holding' | 'sector_group' | 'company' | 'child_company'; parentId?: string; control?: 'controlled' | 'associate'; name?: string },
  client: PrismaService = owner,
): Promise<string> {
  const row = await client.subsidiary.create({
    data: {
      organisationId: tenant.organisationId,
      legalName: data.name ?? `Int-test ${data.nodeType}`,
      geographyCode: 'UK',
      nodeType: data.nodeType,
      parentId: data.parentId ?? tenant.subsidiaryId,
      control: data.control ?? 'controlled',
    },
    select: { id: true },
  });
  return row.id;
}

describe('the carry-over (design D3, task 2.5) — the migration\'s own SQL', () => {
  /** Statements 3a–3c of the migration, as written. */
  const carryOver = (() => {
    const sql = readFileSync(
      resolve(__dirname, '../../../../packages/db/prisma/migrations/20261126120000_inc26_group_tree/migration.sql'),
      'utf8',
    );
    const block = sql.slice(sql.indexOf('-- 3a.'), sql.indexOf('-- 4. CHECKs'));
    return block
      .split(/;\s*\n/)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter((s) => s.length > 0 && !/^-+$/.test(s));
  })();

  it('writes nothing but subsidiaries and the audit log', () => {
    expect(carryOver).toHaveLength(3);
    for (const statement of carryOver) {
      const written = [...statement.matchAll(/(?:INSERT INTO|UPDATE)\s+"(\w+)"/g)].map((m) => m[1]);
      expect(written.every((t) => t === 'subsidiaries' || t === 'audit_log'), statement.slice(0, 80)).toBe(true);
    }
  });

  it('gives each organisation with companies one root, places the rest, and audits each node — on a copy of the three tables', async () => {
    const result = await withRollback(owner, async (tx) => {
      // The tables as they stood before the migration's checks and triggers:
      // copies with their defaults, in a schema of this transaction alone.
      await tx.$executeRawUnsafe('CREATE SCHEMA int_carry_over');
      for (const table of ['organisations', 'subsidiaries', 'audit_log']) {
        await tx.$executeRawUnsafe(`CREATE TABLE int_carry_over."${table}" (LIKE public."${table}" INCLUDING DEFAULTS)`);
      }
      await tx.$executeRawUnsafe('SET LOCAL search_path = int_carry_over, public');
      const orgs = {
        mirror: '0c000000-0000-4000-8000-000000000001',
        noMirror: '0c000000-0000-4000-8000-000000000002',
        empty: '0c000000-0000-4000-8000-000000000003',
      };
      for (const [id, name] of [
        [orgs.mirror, 'Örnek Gıda A.Ş.'],
        [orgs.noMirror, 'Int Carry Holding A.Ş.'],
        [orgs.empty, 'Int Carry Empty A.Ş.'],
      ]) {
        await tx.$executeRawUnsafe(
          `INSERT INTO organisations (id, legal_name, trading_name, country, geography_code, sector, updated_at)
           VALUES ($1::uuid, $2, 'Int', 'TR', 'TR', 'Food', now())`, id, name,
        );
      }
      const sub = async (id: string, org: string, name: string, createdAt: string) =>
        tx.$executeRawUnsafe(
          `INSERT INTO subsidiaries (id, organisation_id, legal_name, geography_code, updated_at, created_at)
           VALUES ($1::uuid, $2::uuid, $3, 'TR', now(), $4::timestamptz)`, id, org, name, createdAt,
        );
      await sub('0d000000-0000-4000-8000-000000000001', orgs.mirror, 'Örnek Gıda A.Ş.', '2026-01-01');
      await sub('0d000000-0000-4000-8000-000000000002', orgs.mirror, 'Örnek Lojistik', '2025-01-01');
      // A second mirror, younger: the oldest is promoted, this one placed.
      await sub('0d000000-0000-4000-8000-000000000003', orgs.mirror, 'Örnek Gıda A.Ş.', '2026-06-01');
      for (let i = 1; i <= 5; i += 1) {
        await sub(`0e000000-0000-4000-8000-00000000000${i}`, orgs.noMirror, `Int Carry Company ${i}`, `2025-0${i}-01`);
      }

      for (const statement of carryOver) await tx.$executeRawUnsafe(statement);

      const nodes = await tx.$queryRawUnsafe<{ id: string; organisation_id: string; legal_name: string; node_type: string; parent_id: string | null; control: string }[]>(
        'SELECT id::text, organisation_id::text, legal_name, node_type::text, parent_id::text, control::text FROM subsidiaries ORDER BY organisation_id, created_at',
      );
      const audit = await tx.$queryRawUnsafe<{ action: string; entity: string; entity_id: string; user_id: string | null; role: string | null; organisation_id: string; diff: Record<string, unknown> }[]>(
        'SELECT action, entity, entity_id, user_id::text, role, organisation_id::text, diff FROM audit_log',
      );
      return { orgs, nodes, audit };
    });

    const { orgs, nodes, audit } = result;
    const of = (org: string) => nodes.filter((n) => n.organisation_id === org);
    // An organisation whose oldest company mirrors it: that company is the root.
    const mirrorRoot = of(orgs.mirror).filter((n) => n.parent_id === null);
    expect(mirrorRoot).toEqual([expect.objectContaining({ id: '0d000000-0000-4000-8000-000000000001', node_type: 'holding' })]);
    expect(of(orgs.mirror).filter((n) => n.parent_id !== null).map((n) => [n.legal_name, n.node_type, n.parent_id, n.control]).sort())
      .toEqual([
        ['Örnek Gıda A.Ş.', 'company', '0d000000-0000-4000-8000-000000000001', 'controlled'],
        ['Örnek Lojistik', 'company', '0d000000-0000-4000-8000-000000000001', 'controlled'],
      ]);
    // With no mirror: a root created as a default subsidiary is, the five under it.
    const created = of(orgs.noMirror).filter((n) => n.parent_id === null);
    expect(created).toEqual([expect.objectContaining({ legal_name: 'Int Carry Holding A.Ş.', node_type: 'holding' })]);
    expect(of(orgs.noMirror).filter((n) => n.parent_id === created[0].id)).toHaveLength(5);
    // No company: nothing.
    expect(of(orgs.empty)).toEqual([]);
    // Every pre-existing id kept.
    expect(nodes.filter((n) => n.organisation_id !== orgs.empty)).toHaveLength(9);

    // One audit row per created or changed node: no actor, the carry-over named, no company name.
    expect(audit).toHaveLength(9);
    for (const row of audit) {
      expect(row).toMatchObject({ entity: 'subsidiary', user_id: null, role: null });
      expect(row.diff).toMatchObject({ source: 'migration:inc26-group-tree', carryOver: true });
      expect(JSON.stringify(row.diff)).not.toMatch(/Örnek|Int Carry/);
    }
    expect(audit.filter((r) => r.action === 'create')).toEqual([
      expect.objectContaining({ entity_id: created[0].id, organisation_id: orgs.noMirror }),
    ]);
    expect(audit.find((r) => r.entity_id === '0d000000-0000-4000-8000-000000000001')?.diff)
      .toMatchObject({ nodeType: { before: null, after: 'holding' }, parentId: { before: null, after: null } });
  });
});

describe('the triggers (design D2, task 2.6)', () => {
  it('places a parentless company under the root, for the runtime role and for the owner (RD14)', async () => {
    for (const client of [runtime, owner]) {
      const row = await client.subsidiary.create({
        data: { organisationId: tenant.organisationId, legalName: 'Int-test previous image', geographyCode: 'UK' },
      });
      expect(row).toMatchObject({ parentId: tenant.subsidiaryId, nodeType: 'company' });
    }
  });

  it.each([['the runtime role', () => runtime], ['the owner', () => owner]])('refuses each shape rule for %s (TA018)', async (_who, client) => {
    const db = client();
    const company = await node({ nodeType: 'company' });
    const subHolding = await node({ nodeType: 'sub_holding' });
    const beneath = await node({ nodeType: 'sub_holding', parentId: subHolding });
    const cases: [string, Promise<unknown>, RegExp][] = [
      ['a second holding', db.subsidiary.create({ data: { organisationId: tenant.organisationId, legalName: 'x', geographyCode: 'UK', nodeType: 'holding' } }), /node_placement_invalid/],
      ['a child company under the holding', db.subsidiary.create({ data: { organisationId: tenant.organisationId, legalName: 'x', geographyCode: 'UK', nodeType: 'child_company', parentId: tenant.subsidiaryId } }), /node_placement_invalid/],
      ['a type change', db.subsidiary.update({ where: { id: company }, data: { nodeType: 'sub_holding' } }), /node_type_fixed/],
      ['a move under its own subtree', db.subsidiary.update({ where: { id: subHolding }, data: { parentId: beneath } }), /tree_cycle/],
      ['a sub-holding ticked associate', db.subsidiary.update({ where: { id: subHolding }, data: { control: 'associate' } }), /node_placement_invalid/],
    ];
    for (const [what, write, message] of cases) {
      const r = await refused(write);
      expect(r.state, what).toBe(db === runtime && what === 'a type change' ? '42501' : 'TA018');
      if (r.state === 'TA018') expect(r.message, what).toMatch(message);
    }
  });

  it('refuses a move over records, an associate tick over a grant, and closed nodes at the door (TA018–TA021)', async () => {
    const company = await node({ nodeType: 'company' });
    const child = await node({ nodeType: 'child_company', parentId: company });
    const sector = await node({ nodeType: 'sector_group' });
    const associate = await node({ nodeType: 'company', control: 'associate' });
    await runtime.activityRecord.create({ data: recordInput(tenant, { subsidiaryId: child }) });
    expect(await refused(runtime.subsidiary.update({ where: { id: company }, data: { parentId: sector } })))
      .toMatchObject({ state: 'TA018', message: expect.stringMatching(/node_move_blocked/) });
    expect(await refused(runtime.subsidiary.update({ where: { id: tenant.subsidiaryId }, data: { parentId: company } })))
      .toMatchObject({ state: 'TA018' });
    await owner.userSubsidiaryAccess.create({ data: { userId: tenant.users.superAdmin.id, subsidiaryId: company, organisationId: tenant.organisationId } });
    const blocked = await refused(runtime.subsidiary.update({ where: { id: company }, data: { control: 'associate' } }));
    expect(blocked).toMatchObject({ state: 'TA018', message: expect.stringMatching(/control_change_blocked/) });
    for (const id of [associate, sector]) {
      expect(await refused(runtime.activityRecord.create({ data: recordInput(tenant, { subsidiaryId: id }) }))).toMatchObject({ state: 'TA019' });
      expect(await refused(runtime.userSubsidiaryAccess.create({ data: { userId: tenant.users.superAdmin.id, subsidiaryId: id, organisationId: tenant.organisationId } })))
        .toMatchObject({ state: 'TA020' });
    }
    expect(await refused(runtime.location.create({ data: { subsidiaryId: sector, name: 'x', geographyCode: 'UK' } }))).toMatchObject({ state: 'TA021' });
    // A facility of an associate stays valid (§2.1); only records are closed.
    await runtime.location.create({ data: { subsidiaryId: associate, name: 'Int-test associate site', geographyCode: 'UK' } });
    // The share percent is a percentage (a CHECK).
    expect(await refused(runtime.subsidiary.update({ where: { id: company }, data: { sharePercent: 150 } }))).toMatchObject({ state: '23514' });
  });

  it('refuses a parent of another organisation by the same-organisation key', async () => {
    const foreign = await createTenant();
    try {
      expect(await refused(runtime.subsidiary.create({
        data: { organisationId: tenant.organisationId, legalName: 'x', geographyCode: 'UK', parentId: foreign.subsidiaryId },
      }))).toMatchObject({ state: 'TA018' });
    } finally {
      await foreign.cleanup();
    }
  });
});

describe('the triggers, every shape (WP7 QA review)', () => {
  const CHILD_TYPES = ['sub_holding', 'sector_group', 'company', 'child_company'] as const;

  it('admits exactly the placement matrix of allowedChildTypes, and nothing under an associate (TA018)', async () => {
    const parents: [string, NodeType, string][] = [['the holding', 'holding', tenant.subsidiaryId]];
    const subHolding = await node({ nodeType: 'sub_holding' });
    const sector = await node({ nodeType: 'sector_group' });
    const company = await node({ nodeType: 'company' });
    const child = await node({ nodeType: 'child_company', parentId: company });
    const associate = await node({ nodeType: 'company', control: 'associate' });
    parents.push(['a sub-holding', 'sub_holding', subHolding], ['a sector group', 'sector_group', sector], ['a company', 'company', company], ['a child company', 'child_company', child]);
    let admitted = 0;
    for (const [what, parentType, parentId] of parents) {
      for (const childType of CHILD_TYPES) {
        const write = runtime.subsidiary.create({
          data: { organisationId: tenant.organisationId, legalName: `Int-test ${childType} under ${parentType}`, geographyCode: 'UK', nodeType: childType, parentId },
        });
        if (allowedChildTypes(parentType).includes(childType)) {
          await write;
          admitted++;
        } else {
          expect(await refused(write), `${childType} under ${what}`).toMatchObject({ state: 'TA018', message: expect.stringMatching(/node_placement_invalid/) });
        }
      }
    }
    // holding 3, sub-holding 3, sector group 1, company 1, child company 1.
    expect(admitted).toBe(9);
    for (const childType of CHILD_TYPES) {
      expect(await refused(runtime.subsidiary.create({
        data: { organisationId: tenant.organisationId, legalName: 'x', geographyCode: 'UK', nodeType: childType, parentId: associate },
      })), `${childType} under an associate`).toMatchObject({ state: 'TA018', message: expect.stringMatching(/node_placement_invalid/) });
    }
  });

  it('refuses a cleared parent, a grandchild cycle, a move over a grandchild\'s record and a tick over a child (TA018)', async () => {
    const a = await node({ nodeType: 'sub_holding', name: 'Int-test A' });
    const b = await node({ nodeType: 'sub_holding', parentId: a, name: 'Int-test B' });
    const c = await node({ nodeType: 'company', parentId: b, name: 'Int-test C' });
    const grandchild = await node({ nodeType: 'child_company', parentId: c });
    const elsewhere = await node({ nodeType: 'sub_holding', name: 'Int-test elsewhere' });
    expect(await refused(runtime.subsidiary.update({ where: { id: c }, data: { parentId: null } })))
      .toMatchObject({ state: 'TA018', message: expect.stringMatching(/node_placement_invalid/) });
    expect(await refused(runtime.subsidiary.update({ where: { id: a }, data: { parentId: c } })))
      .toMatchObject({ state: 'TA018' });
    const subHoldingBeneath = await node({ nodeType: 'sub_holding', parentId: b });
    expect(await refused(runtime.subsidiary.update({ where: { id: a }, data: { parentId: subHoldingBeneath } })))
      .toMatchObject({ state: 'TA018', message: expect.stringMatching(/tree_cycle/) });
    expect(await refused(runtime.subsidiary.update({ where: { id: c }, data: { control: 'associate' } })))
      .toMatchObject({ state: 'TA018', message: expect.stringMatching(/control_change_blocked/) });
    await runtime.activityRecord.create({ data: recordInput(tenant, { subsidiaryId: grandchild }) });
    expect(await refused(runtime.subsidiary.update({ where: { id: a }, data: { parentId: elsewhere } })))
      .toMatchObject({ state: 'TA018', message: expect.stringMatching(/node_move_blocked/) });
  });

  it('refuses an owner moving a root into an organisation that has one (TA018, WP7 review)', async () => {
    const foreign = await createTenant();
    try {
      // The other organisation's root, moved by the owner session (TA004 lets it).
      const r = await refused(owner.subsidiary.update({ where: { id: foreign.subsidiaryId }, data: { organisationId: tenant.organisationId } }));
      expect(r.state).not.toBeNull();
      expect(await owner.subsidiary.count({ where: { organisationId: tenant.organisationId, parentId: null } })).toBe(1);
    } finally {
      await foreign.cleanup();
    }
  });

  it('refuses a boundary declaration of an associate or a sector group, for the runtime role and the owner (TA022)', async () => {
    const associate = await node({ nodeType: 'company', control: 'associate' });
    const sector = await node({ nodeType: 'sector_group' });
    const site = await owner.location.create({ data: { subsidiaryId: tenant.otherSubsidiaryId, name: 'Int-test site', geographyCode: 'UK' } });
    const open = await createBoundary(owner, { ...tenant, subsidiaryId: tenant.otherSubsidiaryId }, { locationId: site.id, version: 31 });
    try {
      for (const db of [runtime, owner]) {
        for (const subsidiaryId of [associate, sector]) {
          expect(await refused(db.inventoryBoundarySubsidiary.create({
            data: { boundaryId: open.boundaryId, organisationId: tenant.organisationId, subsidiaryId, firstMonth: 1, lastMonth: 12 },
          }))).toMatchObject({ state: 'TA022', message: expect.stringMatching(/^[\s\S]*boundary_subsidiary_not_reportable/) });
        }
      }
    } finally {
      await owner.inventoryBoundary.delete({ where: { id: open.boundaryId } });
    }
  });
});

describe('the races, at READ COMMITTED on two connections (task 2.6)', () => {
  /** `write` in a transaction held open after it ran, until `release`. */
  function heldTransaction(client: PrismaService, write: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    const done = deferred();
    const gate = deferred();
    const tx = client.$transaction(async (t) => {
      await write(t);
      done.resolve();
      await gate.promise;
    }, { timeout: 20_000 });
    tx.catch(() => undefined);
    return { written: done.promise, release: () => gate.resolve(), committed: tx };
  }

  it('two moves that would close a cycle together: one is stored, and the tree has none', async () => {
    const a = await node({ nodeType: 'sub_holding', name: 'Int-test A' });
    const b = await node({ nodeType: 'sub_holding', name: 'Int-test B' });
    const first = heldTransaction(runtime, (tx) => tx.subsidiary.update({ where: { id: a }, data: { parentId: b } }));
    await first.written;
    const secondPid = await backendPid(other); // read while idle: `second` then holds the one pooled connection
    const second = other.subsidiary.update({ where: { id: b }, data: { parentId: a } });
    second.catch(() => undefined);
    expect(await settledOrBlocked(second, secondPid, owner)).toBe('blocked');
    first.release();
    await first.committed;
    expect(await refused(second)).toMatchObject({ state: 'TA018', message: expect.stringMatching(/tree_cycle/) });
    const rows = await owner.subsidiary.findMany({ where: { id: { in: [a, b] } }, select: { id: true, parentId: true } });
    expect(rows.find((r) => r.id === a)?.parentId).toBe(b);
    expect(rows.find((r) => r.id === b)?.parentId).toBe(tenant.subsidiaryId);
  });

  it('a tick and a record at the same moment: exactly one is stored, whichever comes first', async () => {
    // The tick first: the record waits on the company's row, then is refused.
    const c1 = await node({ nodeType: 'company', name: 'Int-test tick first' });
    const tick = heldTransaction(runtime, (tx) => tx.subsidiary.update({ where: { id: c1 }, data: { control: 'associate' } }));
    await tick.written;
    const recordPid = await backendPid(other); // read while idle: `record` then holds the one pooled connection
    const record = other.activityRecord.create({ data: recordInput(tenant, { subsidiaryId: c1 }) });
    record.catch(() => undefined);
    expect(await settledOrBlocked(record, recordPid, owner)).toBe('blocked');
    tick.release();
    await tick.committed;
    expect(await refused(record)).toMatchObject({ state: 'TA019' });
    expect(await owner.activityRecord.count({ where: { subsidiaryId: c1 } })).toBe(0);

    // The record first: the tick waits, then sees it and is refused.
    const c2 = await node({ nodeType: 'company', name: 'Int-test record first' });
    const insert = heldTransaction(runtime, (tx) => tx.activityRecord.create({ data: recordInput(tenant, { subsidiaryId: c2 }) }));
    await insert.written;
    const tick2Pid = await backendPid(other); // read while idle: `tick2` then holds the one pooled connection
    const tick2 = other.subsidiary.update({ where: { id: c2 }, data: { control: 'associate' } });
    tick2.catch(() => undefined);
    expect(await settledOrBlocked(tick2, tick2Pid, owner)).toBe('blocked');
    insert.release();
    await insert.committed;
    expect(await refused(tick2)).toMatchObject({ state: 'TA018', message: expect.stringMatching(/control_change_blocked/) });
    expect((await owner.subsidiary.findUniqueOrThrow({ where: { id: c2 } })).control).toBe('controlled');
  });

  it('a record beneath a node racing that node\'s move: the move is refused, or the record waits for it', async () => {
    const sector = await node({ nodeType: 'sector_group' });
    // The record first: the move locks the subtree, waits, then counts it.
    const p1 = await node({ nodeType: 'company', name: 'Int-test parent 1' });
    const k1 = await node({ nodeType: 'child_company', parentId: p1 });
    const insert = heldTransaction(runtime, (tx) => tx.activityRecord.create({ data: recordInput(tenant, { subsidiaryId: k1 }) }));
    await insert.written;
    const movePid = await backendPid(other); // read while idle: `move` then holds the one pooled connection
    const move = other.subsidiary.update({ where: { id: p1 }, data: { parentId: sector } });
    move.catch(() => undefined);
    expect(await settledOrBlocked(move, movePid, owner)).toBe('blocked');
    insert.release();
    await insert.committed;
    expect(await refused(move)).toMatchObject({ state: 'TA018', message: expect.stringMatching(/node_move_blocked/) });

    // The move first: the record waits on the child's row, then is stored beneath the moved node.
    const p2 = await node({ nodeType: 'company', name: 'Int-test parent 2' });
    const k2 = await node({ nodeType: 'child_company', parentId: p2 });
    const moving = heldTransaction(runtime, (tx) => tx.subsidiary.update({ where: { id: p2 }, data: { parentId: sector } }));
    await moving.written;
    const latePid = await backendPid(other); // read while idle: `late` then holds the one pooled connection
    const late = other.activityRecord.create({ data: recordInput(tenant, { subsidiaryId: k2 }) });
    late.catch(() => undefined);
    expect(await settledOrBlocked(late, latePid, owner)).toBe('blocked');
    moving.release();
    await moving.committed;
    await expect(late).resolves.toMatchObject({ subsidiaryId: k2 });
    expect((await owner.subsidiary.findUniqueOrThrow({ where: { id: p2 } })).parentId).toBe(sector);
  });

  it("the newest version's delete and a tick of a company the version before declares, at once: one is refused, whichever comes first (owner's third review, P1)", async () => {
    /** A frozen V1 declaring `company`, an open V2 leaving it out, in `year`. */
    const setUp = async (year: number) => {
      const company = await node({ nodeType: 'company', name: `Int-test declared ${year}` });
      const site = await owner.location.create({ data: { subsidiaryId: company, name: 'Int-test site', geographyCode: 'UK' } });
      const other = await node({ nodeType: 'company', name: `Int-test other ${year}` });
      const otherSite = await owner.location.create({ data: { subsidiaryId: other, name: 'Int-test other site', geographyCode: 'UK' } });
      await createBoundary(owner, { ...tenant, subsidiaryId: company }, { locationId: site.id, reportingYear: year, version: 1, frozen: true });
      const v2 = await createBoundary(owner, { ...tenant, subsidiaryId: other }, { locationId: otherSite.id, reportingYear: year, version: 2 });
      return { company, v2: v2.boundaryId };
    };

    // The delete first, held open: the tick waits for it, then meets V1 current.
    const a = await setUp(2026);
    const deleting = heldTransaction(runtime, (tx) => tx.inventoryBoundary.delete({ where: { id: a.v2 } }));
    await deleting.written;
    const tickPid = await backendPid(other); // read while idle: `tick` then holds the one pooled connection
    const tick = other.subsidiary.update({ where: { id: a.company }, data: { control: 'associate' } });
    tick.catch(() => undefined);
    expect(await settledOrBlocked(tick, tickPid, owner)).toBe('blocked');
    deleting.release();
    await deleting.committed;
    expect(await refused(tick)).toMatchObject({ state: 'TA018', message: expect.stringMatching(/control_change_blocked/) });

    // The tick first, held open: the delete waits for it, then is refused.
    const b = await setUp(2029);
    const ticking = heldTransaction(runtime, (tx) => tx.subsidiary.update({ where: { id: b.company }, data: { control: 'associate' } }));
    await ticking.written;
    const deletePid = await backendPid(other); // read while idle: `remove` then holds the one pooled connection
    const remove = other.inventoryBoundary.delete({ where: { id: b.v2 } });
    remove.catch(() => undefined);
    expect(await settledOrBlocked(remove, deletePid, owner)).toBe('blocked');
    ticking.release();
    await ticking.committed;
    expect(await refused(remove)).toMatchObject({ state: 'TA022', message: expect.stringMatching(/boundary_subsidiary_not_reportable/) });
    expect(await owner.inventoryBoundary.count({ where: { id: b.v2 } })).toBe(1);
  });
});

describe('the API over the database', () => {
  const services = (client: PrismaService) => {
    const audit = new AuditService(client);
    const calculations = { coverage: async () => ({ entries: [{ geographyCode: 'UK', reportingYear: 2026, statuses: ['authoritative'] }] }) } as unknown as CalculationsService;
    const locations = new LocationsService(client, audit, calculations);
    return {
      subsidiaries: new SubsidiariesService(client, audit, locations, new AccessAdminService(client, audit), calculations),
      access: new AccessAdminService(client, audit),
      locations,
      boundaries: new InventoryBoundariesService(client, audit),
      emissions: new EmissionsService(client),
    };
  };
  const masterkey = (...more: string[]): RequestUser => ({
    ...tenant.users.masterkey,
    accessibleSubsidiaryIds: [...tenant.users.masterkey.accessibleSubsidiaryIds, ...more],
  });

  it('waits for a concurrent move holding the tree lock, then answers the cycle it closed with tree_cycle (3.3)', async () => {
    const a = await node({ nodeType: 'sub_holding', name: 'Int-test A' });
    const b = await node({ nodeType: 'sub_holding', name: 'Int-test B' });
    // Another writer moves B under A and holds its transaction open: TA018
    // took the organisation's tree lock. The API takes that lock before its
    // own checks (WP7 review), so it waits, then reads the committed move —
    // a cycle no longer reaches the database unseen.
    const gate = deferred();
    const written = deferred();
    const first = owner.$transaction(async (tx) => {
      await tx.subsidiary.update({ where: { id: b }, data: { parentId: a } });
      written.resolve();
      await gate.promise;
    }, { timeout: 20_000 });
    first.catch(() => undefined);
    await written.promise;
    const movingPid = await backendPid(other); // read while idle: `moving` then holds the one pooled connection
    const moving = services(other).subsidiaries.update(masterkey(a, b), a, { parentId: b });
    moving.catch(() => undefined);
    expect(await settledOrBlocked(moving, movingPid, owner)).toBe('blocked');
    gate.resolve();
    await first;
    await expect(moving).rejects.toMatchObject({ response: expect.objectContaining({ code: 'tree_cycle' }) });
  });

  it('refuses a grant on an associate or a sector group, and leaves a carried-over account untouched (4.3)', async () => {
    const associate = await node({ nodeType: 'company', control: 'associate' });
    const sector = await node({ nodeType: 'sector_group' });
    const before = await owner.userSubsidiaryAccess.findMany({ where: { userId: tenant.users.superAdmin.id }, orderBy: { subsidiaryId: 'asc' } });
    expect(before).toHaveLength(1);
    for (const id of [associate, sector]) {
      await expect(
        services(runtime).access.replaceSubsidiaryAccess(masterkey(associate, sector), tenant.users.superAdmin.id, [
          { subsidiaryId: tenant.subsidiaryId, categories: [] },
          { subsidiaryId: id, categories: [] },
        ]),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'subsidiary_not_assignable' }) });
    }
    expect(await owner.userSubsidiaryAccess.findMany({ where: { userId: tenant.users.superAdmin.id }, orderBy: { subsidiaryId: 'asc' } }))
      .toEqual(before);
  });

  it("lets a super_admin read the open version it declares nothing in — holding nothing of another company (4.5)", async () => {
    const site = await owner.location.create({ data: { subsidiaryId: tenant.otherSubsidiaryId, name: 'Int-test other site', geographyCode: 'UK' } });
    const open = await createBoundary(owner, { ...tenant, subsidiaryId: tenant.otherSubsidiaryId }, { locationId: site.id, version: 30 });
    try {
      const superAdmin = { ...tenant.users.superAdmin, accessibleSubsidiaryIds: [tenant.subsidiaryId] };
      const read = await services(runtime).boundaries.get(superAdmin, open.boundaryId);
      expect(read.view).toBe('granted_subsidiaries');
      expect(read.boundary.subsidiaryIds).toEqual([]);
      expect(JSON.stringify(read)).not.toContain(tenant.otherSubsidiaryId);
      expect(JSON.stringify(read)).not.toContain(site.id);
      const listed = await services(runtime).boundaries.list(superAdmin, { reportingYear: 2026 });
      expect(listed.map((v) => v.id)).toContain(open.boundaryId);
    } finally {
      await owner.inventoryBoundary.delete({ where: { id: open.boundaryId } });
    }
  });

  it("keeps a year's current boundary free of associates: a tick past the newest version, a delete that would bring an older one back refused; a copy of it leaves the associate out (owner reviews of WP7)", async () => {
    const company = await node({ nodeType: 'company', name: 'Int-test later associate' });
    const site = await owner.location.create({ data: { subsidiaryId: company, name: 'Int-test site', geographyCode: 'UK' } });
    const other = await node({ nodeType: 'company', name: 'Int-test other company' });
    const otherSite = await owner.location.create({ data: { subsidiaryId: other, name: 'Int-test other site', geographyCode: 'UK' } });
    const user = masterkey(company, other);
    // V1 (frozen) declares the company; V2 (open, newest) leaves it out.
    const v1 = await createBoundary(owner, { ...tenant, subsidiaryId: company }, { locationId: site.id, reportingYear: 2026, version: 32, frozen: true });
    const v2 = await createBoundary(owner, { ...tenant, subsidiaryId: other }, { locationId: otherSite.id, reportingYear: 2026, version: 33 });
    // The newest version leaves it out: the tick goes through (the spec's scenario).
    await expect(services(runtime).subsidiaries.update(user, company, { control: 'associate' })).resolves.toMatchObject({ control: 'associate' });
    // Deleting V2 would make V1 — declaring an associate — current again: refused
    // by the API and, for any writer, by the database (TA022).
    await expect(services(runtime).boundaries.remove(user, v2.boundaryId))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'boundary_subsidiary_not_reportable' }) });
    expect(await refused(owner.inventoryBoundary.delete({ where: { id: v2.boundaryId } })))
      .toMatchObject({ state: 'TA022', message: expect.stringMatching(/boundary_subsidiary_not_reportable/) });
    expect(await owner.inventoryBoundary.count({ where: { id: v2.boundaryId } })).toBe(1);
    // A version declaring it as the newest: the tick is refused, by the API and TA018.
    const third = await node({ nodeType: 'company', name: 'Int-test declared in the newest' });
    const thirdSite = await owner.location.create({ data: { subsidiaryId: third, name: 'Int-test third site', geographyCode: 'UK' } });
    await owner.inventoryBoundarySubsidiary.create({ data: { boundaryId: v2.boundaryId, organisationId: tenant.organisationId, subsidiaryId: third, firstMonth: 1, lastMonth: 12 } });
    void thirdSite;
    await expect(services(runtime).subsidiaries.update(masterkey(third), third, { control: 'associate' }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'control_change_blocked' }) });
    for (const db of [runtime, owner]) {
      expect(await refused(db.subsidiary.update({ where: { id: third }, data: { control: 'associate' } })))
        .toMatchObject({ state: 'TA018', message: expect.stringMatching(/control_change_blocked/) });
    }
    // A copy of V1 leaves the associate out, and its audit row names it.
    const copy = await services(runtime).boundaries.create(user, { reportingYear: 2027, copyOf: v1.boundaryId });
    expect(await owner.inventoryBoundarySubsidiary.count({ where: { boundaryId: copy.id } })).toBe(0);
    const audit = await owner.auditLog.findFirstOrThrow({ where: { entity: 'inventory_boundary', entityId: copy.id, action: 'create' } });
    expect(audit.diff).toMatchObject({ copyOf: v1.boundaryId, leftOutClosedSubsidiaries: [company] });
    // V1 itself is unchanged.
    expect(await owner.inventoryBoundarySubsidiary.count({ where: { boundaryId: v1.boundaryId, subsidiaryId: company } })).toBe(1);
  });

  it('a confirm refuses a version still declaring a company made an associate outside the rules (a replica-mode write)', async () => {
    const company = await node({ nodeType: 'company', name: 'Int-test legacy associate' });
    const site = await owner.location.create({ data: { subsidiaryId: company, name: 'Int-test site', geographyCode: 'UK' } });
    const open = await createBoundary(owner, { ...tenant, subsidiaryId: company }, { locationId: site.id, reportingYear: 2028, version: 1 });
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.subsidiary.update({ where: { id: company }, data: { control: 'associate' } });
    });
    await expect(services(runtime).boundaries.confirm(masterkey(company), open.boundaryId))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'boundary_subsidiary_not_reportable' }) });
    expect((await owner.inventoryBoundary.findUniqueOrThrow({ where: { id: open.boundaryId } })).frozenAt).toBeNull();
  });

  it('a company with a facility is deleted by no writer, nor right after its facilities in one transaction; a facility stays with its company (TA023, TA021; owner review of WP7, P1)', async () => {
    const company = await node({ nodeType: 'company', name: 'Int-test company with a facility' });
    const elsewhere = await node({ nodeType: 'company', name: 'Int-test elsewhere' });
    const site = await owner.location.create({ data: { subsidiaryId: company, name: 'Int-test site', geographyCode: 'UK' } });
    for (const db of [runtime, owner]) {
      expect(await refused(db.subsidiary.delete({ where: { id: company } })))
        .toMatchObject({ state: 'TA023', message: expect.stringMatching(/subsidiary_in_use/) });
    }
    // The previous API image's path: its facilities, then the company, in one transaction.
    expect(await refused(runtime.$transaction(async (tx) => {
      await tx.location.deleteMany({ where: { subsidiaryId: company } });
      await tx.subsidiary.delete({ where: { id: company } });
    }))).toMatchObject({ state: 'TA023' });
    expect(await owner.location.count({ where: { id: site.id } })).toBe(1);
    // Moved to another company, the facility would empty this one for a delete.
    expect(await refused(runtime.location.update({ where: { id: site.id }, data: { subsidiaryId: elsewhere } })))
      .toMatchObject({ state: 'TA021', message: expect.stringMatching(/stays with its company/) });
    // The facility deleted on its own, the company in a later transaction: allowed.
    await runtime.location.delete({ where: { id: site.id } });
    await runtime.subsidiary.delete({ where: { id: company } });
    expect(await owner.subsidiary.count({ where: { id: company } })).toBe(0);
  });

  it('an organisation offboarded with a company and its facility is removed whole (a cascade passes TA023)', async () => {
    const foreign = await createTenant();
    let cleaned = false;
    try {
      const company = await owner.subsidiary.create({
        data: { organisationId: foreign.organisationId, legalName: 'Int-test offboarded company', geographyCode: 'UK' },
      });
      await owner.location.create({ data: { subsidiaryId: company.id, name: 'Int-test offboarded site', geographyCode: 'UK' } });
      await foreign.cleanup();
      cleaned = true;
      expect(await owner.subsidiary.count({ where: { organisationId: foreign.organisationId } })).toBe(0);
    } finally {
      if (!cleaned) await foreign.cleanup();
    }
  });

  it("a company moved to another organisation meanwhile is unknown to its former organisation's update and delete (owner's fourth review, P2)", async () => {
    const company = await node({ nodeType: 'company', name: 'Int-test transferred' });
    const site = await owner.location.create({ data: { subsidiaryId: company, name: 'Int-test transferred site', geographyCode: 'UK' } });
    // The masterkey's request read it in A; an operator moves it to B before the write.
    const user = masterkey(company);
    const foreign = await createTenant();
    try {
      await owner.subsidiary.update({ where: { id: company }, data: { organisationId: foreign.organisationId, parentId: foreign.subsidiaryId } });
      await expect(services(runtime).subsidiaries.update(user, company, { legalName: 'Written from A' }))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'subsidiary_not_found' }) });
      await expect(services(runtime).subsidiaries.remove(user, company))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'subsidiary_not_found' }) });
      // Its facilities too: no new one, no change, nothing removed (owner's fifth review, P2).
      await expect(services(runtime).locations.create(user, { subsidiaryId: company, name: 'Written from A', geographyCode: 'UK' }))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'subsidiary_not_found' }) });
      await expect(services(runtime).locations.update(user, site.id, { locationType: 'warehouse' }))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'location_not_found' }) });
      await expect(services(runtime).locations.remove(user, site.id))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'subsidiary_not_found' }) });
      expect(await owner.location.findMany({ where: { subsidiaryId: company }, select: { id: true, locationType: true } }))
        .toEqual([{ id: site.id, locationType: null }]);
      // Nor read: A's roll-up and its exclusions note say nothing of it (owner's fifth review, P2).
      const associate = await node({ nodeType: 'company', control: 'associate', name: 'Int-test transferred associate' });
      await owner.subsidiary.update({ where: { id: associate }, data: { organisationId: foreign.organisationId, parentId: foreign.subsidiaryId } });
      const stale = masterkey(company, associate);
      const roll = await services(runtime).emissions.rollUp(stale, { reportingYear: 2026 });
      expect(roll.rows.map((r) => r.subsidiaryId)).not.toContain(company);
      expect(roll.rows.map((r) => r.subsidiaryId)).not.toContain(associate);
      expect(roll.rows.map((r) => r.subsidiaryId)).toContain(tenant.subsidiaryId);
      expect(await services(runtime).subsidiaries.boundaryExclusions(stale)).toEqual([]);
      // Nor the company screen's list and detail (owner's sixth review, P2).
      expect((await services(runtime).subsidiaries.list(stale)).map((s) => s.id)).not.toContain(company);
      await expect(services(runtime).subsidiaries.get(stale, company))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'subsidiary_not_found' }) });
      expect(await owner.subsidiary.findUniqueOrThrow({ where: { id: company } }))
        .toMatchObject({ organisationId: foreign.organisationId, legalName: 'Int-test transferred' });
    } finally {
      await foreign.cleanup();
    }
  });

  it('a tick waits for a move of its ancestor and both settle — no deadlock (WP7 review)', async () => {
    const a = await node({ nodeType: 'sub_holding', name: 'Int-test A' });
    const target = await node({ nodeType: 'sub_holding', name: 'Int-test target' });
    const x = await node({ nodeType: 'company', parentId: a, name: 'Int-test X' });
    const user = masterkey(a, target, x);
    // The move holds the tree lock and its node, after the API's checks.
    const hold = holdBefore(runtime, 'Subsidiary', 'update');
    const moving = services(hold.client).subsidiaries.update(user, a, { parentId: target });
    moving.catch(() => undefined);
    await hold.reached();
    const tickingPid = await backendPid(other); // read while idle: `ticking` then holds the one pooled connection
    const ticking = services(other).subsidiaries.update(user, x, { control: 'associate' });
    ticking.catch(() => undefined);
    expect(await settledOrBlocked(ticking, tickingPid, owner)).toBe('blocked');
    hold.release();
    await expect(moving).resolves.toMatchObject({ parentId: target });
    await expect(ticking).resolves.toMatchObject({ control: 'associate' });
  });

  it("reads the root's roll-up equal to the year's main total (5.3)", async () => {
    const company = await node({ nodeType: 'company' });
    const child = await node({ nodeType: 'child_company', parentId: company });
    for (const [subsidiaryId, tCo2e, periodValue] of [
      [tenant.subsidiaryId, 5, 'January'], [company, 10, 'February'], [child, 3, 'March'],
    ] as const) {
      await owner.activityRecord.create({
        data: recordInput(tenant, { subsidiaryId, periodValue, calculation: { tCo2e, factorId: 'int-test-placeholder' }, status: 'draft' }),
      });
    }
    await owner.activityRecord.updateMany({ where: { subsidiaryId: { in: [tenant.subsidiaryId, company, child] } }, data: { status: 'submitted' } });
    const user = masterkey(company, child);
    const [roll, summary] = await Promise.all([
      services(runtime).emissions.rollUp(user, { reportingYear: 2026 }),
      services(runtime).emissions.summary(user, { year: 2026 }),
    ]);
    const root = roll.rows.find((r) => r.subsidiaryId === tenant.subsidiaryId);
    expect(root?.rollUp?.total).toBeCloseTo(18, 9);
    expect(root?.rollUp?.total).toBeCloseTo(summary.totals.total, 9);
    expect(roll.rows.find((r) => r.subsidiaryId === company)?.rollUp?.total).toBeCloseTo(13, 9);
  });
});
