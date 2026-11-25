import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmissionsService } from './emissions.service';
import type { PrismaService } from '../prisma/prisma.service';
import { makeMasterkey, makeStandardUser, makeSuperAdmin } from '../../test/helpers';

/** GET /emissions/roll-up (inc26-group-tree, task 5.3, INC-2.6 §5.2). DB-free. */

const node = (id: string, parentId: string | null, nodeType: string, control = 'controlled') => ({ id, parentId, nodeType, control });
const record = (subsidiaryId: string, scope: number, tCo2e: number, category = scope === 1 ? 'Natural Gas' : scope === 2 ? 'Electricity' : 'Business Travel') => ({
  subsidiaryId, scope, category, reportingYear: 2026, reportingPeriod: 'annual', periodValue: 'Annual',
  calculation: { tCo2e, factorId: 'f-1' },
});
const t = (scope1: number, scope2 = 0) => ({ scope1, scope2, total: scope1 + scope2 });

// The spec's example: holding H 5 t, company A under it 10 t, child company B under A 3 t
// (and 4 t of Scope 3 that changes nothing); a sector group G holding company C 7 t; an
// associate X under the root.
const TREE = [
  node('H', null, 'holding'),
  node('A', 'H', 'company'),
  node('B', 'A', 'child_company'),
  node('G', 'H', 'sector_group'),
  node('C', 'G', 'company'),
  node('X', 'H', 'company', 'associate'),
];
const RECORDS = [record('H', 1, 5), record('A', 2, 10), record('B', 1, 3), record('B', 3, 4), record('C', 1, 2), record('C', 2, 5)];

function build() {
  const prisma = {
    subsidiary: { findMany: vi.fn() },
    activityRecord: { findMany: vi.fn() },
    factorRelease: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { prisma, service: new EmissionsService(prisma as unknown as PrismaService) };
}

describe('EmissionsService.rollUp', () => {
  let w: ReturnType<typeof build>;
  beforeEach(() => {
    w = build();
  });

  /** The tree and the records a caller reads: what the database would answer within `ids`. */
  function readable(ids: string[]) {
    w.prisma.subsidiary.findMany.mockResolvedValue(TREE.filter((n) => ids.includes(n.id)));
    w.prisma.activityRecord.findMany.mockResolvedValue(RECORDS.filter((r) => ids.includes(r.subsidiaryId)));
  }

  it('reads own plus the children for a masterkey: 5 / 10 / 3 → 18, and the sector group sums its company', async () => {
    readable(TREE.map((n) => n.id));
    const { rows } = await w.service.rollUp(makeMasterkey({ accessibleSubsidiaryIds: TREE.map((n) => n.id) }), { reportingYear: 2026 });
    const by = Object.fromEntries(rows.map((r) => [r.subsidiaryId, r]));
    expect(by.B).toMatchObject({ own: t(3), rollUp: t(3) });
    expect(by.A).toMatchObject({ own: t(0, 10), rollUp: t(3, 10) });
    expect(by.C).toMatchObject({ own: t(2, 5), rollUp: t(2, 5) });
    expect(by.G).toMatchObject({ own: null, rollUp: t(2, 5) });
    expect(by.X).toMatchObject({ own: null, rollUp: null, control: 'associate' });
    // The root agrees with the main total (Scope 1 + 2: 5 + 10 + 3 + 7), and Scope 3 changes nothing.
    expect(by.H).toMatchObject({ parentId: null, nodeType: 'holding', own: t(5), rollUp: t(10, 15) });
    expect(by.H.rollUp!.total).toBe(25);
  });

  it('reads the counted statuses of the year, within the record scope, for the accessible set only', async () => {
    readable(['A']);
    await w.service.rollUp(makeStandardUser({ accessibleSubsidiaryIds: ['A'], categoryGrants: { A: ['Electricity'] } }), { reportingYear: 2026 });
    const where = w.prisma.activityRecord.findMany.mock.calls[0][0].where;
    expect(where.subsidiaryId).toEqual({ in: ['A'] });
    expect(where.reportingYear).toBe(2026);
    expect(where.status).toEqual({ in: ['submitted', 'under_review', 'approved', 'locked'] });
    expect(where.AND).toHaveLength(1);
    expect(w.prisma.subsidiary.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['A'] } });
  });

  it("a super_admin granted a parent only: the parent reads its own figure, and nothing refers to the child", async () => {
    readable(['A']);
    const res = await w.service.rollUp(makeSuperAdmin({ accessibleSubsidiaryIds: ['A'] }), { reportingYear: 2026 });
    expect(res.rows).toEqual([
      { subsidiaryId: 'A', parentId: null, nodeType: 'company', control: 'controlled', own: t(0, 10), rollUp: t(0, 10) },
    ]);
    expect(JSON.stringify(res)).not.toMatch(/"B"|"H"/);
  });

  it('a super_admin granted both: A rolls up B, and B names A as its parent', async () => {
    readable(['A', 'B']);
    const { rows } = await w.service.rollUp(makeSuperAdmin({ accessibleSubsidiaryIds: ['A', 'B'] }), { reportingYear: 2026 });
    const by = Object.fromEntries(rows.map((r) => [r.subsidiaryId, r]));
    expect(by.A).toMatchObject({ parentId: null, rollUp: t(3, 10) });
    expect(by.B).toMatchObject({ parentId: 'A', rollUp: t(3) });
  });

  it('answers an empty set with no rows, reading nothing', async () => {
    const res = await w.service.rollUp(makeSuperAdmin({ accessibleSubsidiaryIds: [] }), { reportingYear: 2026 });
    expect(res).toEqual({ reportingYear: 2026, rows: [] });
    expect(w.prisma.subsidiary.findMany).not.toHaveBeenCalled();
    expect(w.prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('counts a record with no figure as nothing, as the main total does', async () => {
    w.prisma.subsidiary.findMany.mockResolvedValue([node('A', null, 'holding')]);
    w.prisma.activityRecord.findMany.mockResolvedValue([record('A', 2, 10), { ...record('A', 2, 0), calculation: null }]);
    const { rows } = await w.service.rollUp(makeMasterkey({ accessibleSubsidiaryIds: ['A'] }), { reportingYear: 2026 });
    expect(rows[0].own).toEqual(t(0, 10));
  });
});
