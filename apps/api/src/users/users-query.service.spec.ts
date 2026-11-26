import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { makeAuditor, makeMasterkey, makeStandardUser, makeSuperAdmin } from '../../test/helpers';
import type { PrismaService } from '../prisma/prisma.service';
import { cursorBinding, decodeCursor, encodeCursor } from '../common/keyset-cursor';
import { toUserSummary, USERS_SORT, UsersQueryService } from './users-query.service';

describe('the users cursor (LP4-05 contract, the shared keyset helper)', () => {
  const binding = cursorBinding(USERS_SORT, {});

  it('round-trips the sort key and carries no address, name or tenant', () => {
    const key = [new Date('2026-10-10T10:00:00.123Z'), randomUUID()] as const;
    const raw = encodeCursor(USERS_SORT, binding, key);
    expect(decodeCursor(USERS_SORT, binding, raw)).toEqual([...key]);
    expect(JSON.parse(Buffer.from(raw, 'base64url').toString())).toEqual({
      v: 2, k: 'users', b: binding, s: [key[0].toISOString(), key[1]],
    });
  });

  it('refuses a version-1 cursor of the list before PR C', () => {
    const v1 = Buffer.from(JSON.stringify({ v: 1, k: 'users', t: '2026-10-10T10:00:00.000Z', i: randomUUID() })).toString('base64url');
    expect(() => decodeCursor(USERS_SORT, binding, v1)).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'validation_failed' }) }),
    );
  });
});

type Row = Parameters<typeof toUserSummary>[0];

const baseRow = (over: Partial<Row> = {}): Row => ({
  id: 'u', email: 'a@b.test', fullName: 'A', role: 'standard_user', language: 'tr', disabledAt: null,
  authSyncPendingSince: null, createdAt: new Date('2026-10-10T09:00:00.000Z'),
  subsidiaryAccess: [{ subsidiaryId: 's', categories: ['Electricity'], kind: 'assigned' }],
  invitation: null, ...over,
});

describe('toUserSummary', () => {
  const invitation = (status: 'pending' | 'sent' | 'accepted' | 'revoked') => ({
    status, language: 'en', attempts: 1, lastErrorStep: null, lastErrorCode: null, lastAttemptAt: null, sentAt: null, acceptedAt: null,
  });

  it('is disabled first, then invited until accepted, else active', () => {
    expect(toUserSummary(baseRow()).status).toBe('active');
    expect(toUserSummary(baseRow({ invitation: invitation('sent') })).status).toBe('invited');
    expect(toUserSummary(baseRow({ invitation: invitation('accepted') })).status).toBe('active');
    expect(toUserSummary(baseRow({ invitation: invitation('sent'), disabledAt: new Date() })).status).toBe('disabled');
  });

  it('flags a pending Auth step and reads an unsupported stored language as the default', () => {
    const s = toUserSummary(baseRow({ authSyncPendingSince: new Date(), language: 'de' }));
    expect(s).toMatchObject({
      authSyncPending: true, language: 'en', access: [{ subsidiaryId: 's', categories: ['Electricity'], kind: 'assigned' }], createdAt: '2026-10-10T09:00:00.000Z',
    });
    expect(s).not.toHaveProperty('subsidiaryIds');
  });

  it('a standard user\'s categories are returned sorted and unique, unknown stored names dropped', () => {
    const s = toUserSummary(baseRow({
      subsidiaryAccess: [{ subsidiaryId: 's', categories: ['Natural Gas', 'Electricity', 'Natural Gas', 'Steam'], kind: 'assigned' }],
    }));
    expect(s.access).toEqual([{ subsidiaryId: 's', categories: ['Electricity', 'Natural Gas'], kind: 'assigned' }]);
  });

  it('a super_admin\'s grants carry no categories, whatever is stored', () => {
    const s = toUserSummary(baseRow({ role: 'super_admin', subsidiaryAccess: [{ subsidiaryId: 's', categories: ['Electricity'], kind: 'assigned' }] }));
    expect(s.access).toEqual([{ subsidiaryId: 's', categories: [], kind: 'assigned' }]);
  });

  it('a scoped reader sees only the grants inside its companies; an unscoped one all of them', () => {
    const row = baseRow({ subsidiaryAccess: [{ subsidiaryId: 'a', categories: [], kind: 'assigned' }, { subsidiaryId: 'c', categories: ['Fuel'], kind: 'assigned' }] });
    expect(toUserSummary(row, new Set(['a'])).access).toEqual([{ subsidiaryId: 'a', categories: [], kind: 'assigned' }]);
    expect(toUserSummary(row, null).access.map((g) => g.subsidiaryId)).toEqual(['a', 'c']);
  });
});

// ---------------------------------------------------------------------------
// The list and the read against an in-memory organisation: the `where` the
// service builds is evaluated on plain rows (the shapes it uses: equality,
// `in`, `lt`, `OR`, `AND`, `some`/`none` on grants), so a scenario reads as
// the database would answer it. The SQL itself is proven in
// test/int/users.int.spec.ts.
// ---------------------------------------------------------------------------

const ORG = 'org-1';
const A = 'sub-1'; // makeSuperAdmin is granted sub-1 and sub-2; scenarios use sub-1 as "A"
const C = 'sub-3';
const B = 'sub-4'; // a company the super_admin granted A is not granted

/** Account ids (uuids: the cursor carries one). */
const ID = {
  'su-ac': '01010101-0000-4000-8000-000000000001',
  'su-c': '02020202-0000-4000-8000-000000000002',
  'su-none': '03030303-0000-4000-8000-000000000003',
  'mk': '04040404-0000-4000-8000-000000000004',
  'aud': '05050505-0000-4000-8000-000000000005',
  'sa-other': '06060606-0000-4000-8000-000000000006',
  'foreign-su': '07070707-0000-4000-8000-000000000007',
} as const;
const name = (id: string) => (Object.entries(ID).find(([, v]) => v === id) ?? [id])[0];

type Where = Record<string, unknown>;

function matches(row: Row & { organisationId: string }, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (key === 'subsidiaryAccess') {
      const c = cond as { none?: Where; some?: { subsidiaryId: { in: string[] } } };
      if (c.none) {
        expect(c.none).toEqual({});
        return row.subsidiaryAccess.length === 0;
      }
      return row.subsidiaryAccess.some((g) => c.some!.subsidiaryId.in.includes(g.subsidiaryId));
    }
    const value = (row as unknown as Record<string, unknown>)[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const op = cond as { in?: unknown[]; lt?: unknown };
      if (op.in) return op.in.includes(value);
      if (op.lt !== undefined) return (value as Date | string) < (op.lt as Date | string);
      throw new Error(`unsupported condition on ${key}: ${JSON.stringify(cond)}`);
    }
    return cond instanceof Date ? (value as Date).getTime() === cond.getTime() : value === cond;
  });
}

let seq = 0;
function member(
  key: keyof typeof ID,
  role: Row['role'],
  grants: Record<string, string[]> = {},
  organisationId = ORG,
  kinds: Record<string, 'assigned' | 'central_reporter'> = {},
) {
  seq += 1;
  return {
    ...baseRow({
      id: ID[key],
      role,
      email: `${key}@tonyai.test`,
      // Distinct, descending in declaration order — the list is newest first.
      createdAt: new Date(Date.UTC(2026, 9, 10, 9, 0, 0, 1000 - seq)),
      subsidiaryAccess: Object.entries(grants).map(([subsidiaryId, categories]) => ({ subsidiaryId, categories, kind: kinds[subsidiaryId] ?? 'assigned' })),
    }),
    organisationId,
  };
}

function directory(rows: ReturnType<typeof member>[]) {
  const sorted = [...rows].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : -1));
  const findMany = vi.fn(async ({ where, take }: { where: Where; take: number }) => sorted.filter((r) => matches(r, where)).slice(0, take));
  const findFirst = vi.fn(async ({ where }: { where: Where }) => sorted.find((r) => matches(r, where)) ?? null);
  const service = new UsersQueryService({ profile: { findMany, findFirst } } as unknown as PrismaService);
  return { service, findMany, findFirst };
}

/** The scenario "A super_admin's list" (spec access-roles). */
function scenario() {
  return directory([
    member('su-ac', 'standard_user', { [A]: ['Electricity'], [C]: ['Fuel'] }),
    member('su-c', 'standard_user', { [C]: [] }),
    member('su-none', 'standard_user'),
    member('mk', 'masterkey'),
    member('aud', 'auditor'),
    member('sa-other', 'super_admin', { [A]: [] }),
    member('foreign-su', 'standard_user', {}, 'org-2'),
  ]);
}

/** A super_admin granted only A. */
const superAdminOfA = () => makeSuperAdmin({ accessibleSubsidiaryIds: [A] });

describe('UsersQueryService — central reporter rows (inc26-central-reporter-onboarding, task 3.1)', () => {
  // A standard user whose main company is C (outside the super_admin's) with
  // a grant for A and B; a carried-over account with A and C; a masterkey
  // carrying a stray grant row with every category.
  const reporters = () => directory([
    member('su-ac', 'standard_user', { [C]: ['Water'], [A]: ['Mobile Combustion'], [B]: ['Mobile Combustion'] }, ORG, { [A]: 'central_reporter', [B]: 'central_reporter' }),
    member('su-c', 'standard_user', { [A]: ['Electricity'], [C]: ['Fuel'] }),
    member('mk', 'masterkey', { [A]: ['Electricity', 'Fuel'] }, ORG, { [A]: 'central_reporter' }),
  ]);

  it("a super_admin granted A sees a reporter's grant row for A alone — never its main company nor its other grant company", async () => {
    const { service } = reporters();
    const page = await service.list(superAdminOfA(), {});
    const reporter = page.items.find((u) => name(u.id) === 'su-ac')!;
    expect(reporter.access).toEqual([{ subsidiaryId: A, categories: ['Mobile Combustion'], kind: 'central_reporter' }]);
    expect((await service.summary(superAdminOfA(), ID['su-ac'])).access).toEqual(reporter.access);
  });

  it('a masterkey sees every row with its kind: the main company, the grant, a carried-over account, a stray grant', async () => {
    const { service } = reporters();
    const page = await service.list(makeMasterkey({ organisationId: ORG }), {});
    const access = (key: string) => page.items.find((u) => name(u.id) === key)!.access;
    expect(access('su-ac').map((g) => [g.subsidiaryId, g.kind]).sort((x, y) => x[0]!.localeCompare(y[0]!))).toEqual(
      [[A, 'central_reporter'], [B, 'central_reporter'], [C, 'assigned']].sort((x, y) => x[0]!.localeCompare(y[0]!)),
    );
    expect(access('su-c').map((g) => g.kind)).toEqual(['assigned', 'assigned']);
    // A stray row on an organisation-wide role: its kind as stored, no categories.
    expect(access('mk')).toEqual([{ subsidiaryId: A, categories: [], kind: 'central_reporter' }]);
  });

  it('reads an unknown stored kind as assigned', () => {
    const row = baseRow({ subsidiaryAccess: [{ subsidiaryId: 'a', categories: [], kind: 'owner' }] });
    expect(toUserSummary(row).access[0]!.kind).toBe('assigned');
  });
});

describe('UsersQueryService.list — the accounts its reader administers (task 6.6)', () => {
  it('a super_admin granted A: the standard user granted A and C (shown with A alone) and the one with no grant — nobody else', async () => {
    const { service } = scenario();
    const page = await service.list(superAdminOfA(), {});
    expect(page.items.map((u) => name(u.id))).toEqual(['su-ac', 'su-none']);
    expect(page.items[0].access).toEqual([{ subsidiaryId: A, categories: ['Electricity'], kind: 'assigned' }]);
    expect(page.items[1].access).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('a masterkey lists every account of its organisation with every grant, and nothing of another', async () => {
    const { service } = scenario();
    const page = await service.list(makeMasterkey({ organisationId: ORG }), {});
    expect(page.items.map((u) => name(u.id))).toEqual(['su-ac', 'su-c', 'su-none', 'mk', 'aud', 'sa-other']);
    expect(page.items[0].access.map((g) => g.subsidiaryId)).toEqual([A, C]);
  });

  it.each([
    ['standard_user', makeStandardUser()],
    ['auditor', makeAuditor()],
  ] as const)('a %s is refused as forbidden before any query', async (_role, reader) => {
    const { service, findMany } = scenario();
    await expect(service.list(reader, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('a reader with no organisation is refused', async () => {
    const { service } = scenario();
    await expect(service.list(makeMasterkey({ organisationId: null }), {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a super_admin with no grant lists only the standard users with no grant', async () => {
    const { service } = scenario();
    const page = await service.list(makeSuperAdmin({ accessibleSubsidiaryIds: [] }), {});
    expect(page.items.map((u) => name(u.id))).toEqual(['su-none']);
  });

  it('paging counts only the visible rows: a page of one, then the next, then the end', async () => {
    const { service, findMany } = scenario();
    const reader = superAdminOfA();
    const first = await service.list(reader, { limit: 1 });
    expect(first.items.map((u) => name(u.id))).toEqual(['su-ac']);
    expect(first.nextCursor).not.toBeNull();
    // The extra row that proves "more" is a visible one, not the hidden su-c between them.
    expect(findMany.mock.calls[0][0].take).toBe(2);
    const second = await service.list(reader, { limit: 1, cursor: first.nextCursor! });
    expect(second.items.map((u) => name(u.id))).toEqual(['su-none']);
    expect(second.nextCursor).toBeNull();
  });

  it('a page as large as the visible rows has no next cursor, though hidden rows follow', async () => {
    const { service } = scenario();
    const page = await service.list(superAdminOfA(), { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });
});

describe('UsersQueryService.summary — one account, as the reader\'s view shows it', () => {
  it('a super_admin reads a standard user granted A and C with A alone (the response after an access change)', async () => {
    const { service } = scenario();
    const s = await service.summary(superAdminOfA(), ID['su-ac']);
    expect(s.access).toEqual([{ subsidiaryId: A, categories: ['Electricity'], kind: 'assigned' }]);
  });

  it('a super_admin reads any standard user of its organisation, with no grant outside its companies', async () => {
    const { service } = scenario();
    const s = await service.summary(superAdminOfA(), ID['su-c']);
    expect(s.access).toEqual([]);
  });

  it.each(['mk', 'aud', 'sa-other', 'foreign-su'] as const)('a super_admin reading %s answers user_not_found', async (key) => {
    const { service } = scenario();
    await expect(service.summary(superAdminOfA(), ID[key])).rejects.toMatchObject({ response: { code: 'user_not_found' } });
  });

  it('a masterkey reads any account of its organisation with every grant; another organisation\'s is user_not_found', async () => {
    const { service } = scenario();
    expect((await service.summary(makeMasterkey(), ID['su-ac'])).access.map((g) => g.subsidiaryId)).toEqual([A, C]);
    expect((await service.summary(makeMasterkey(), ID['sa-other'])).access).toEqual([{ subsidiaryId: A, categories: [], kind: 'assigned' }]);
    await expect(service.summary(makeMasterkey(), ID['foreign-su'])).rejects.toMatchObject({ response: { code: 'user_not_found' } });
  });

  it.each([
    ['standard_user', makeStandardUser()],
    ['auditor', makeAuditor()],
  ] as const)('a %s is refused as forbidden', async (_role, reader) => {
    const { service, findFirst } = scenario();
    await expect(service.summary(reader, ID['su-ac'])).rejects.toBeInstanceOf(ForbiddenException);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
