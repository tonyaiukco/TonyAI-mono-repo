import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AccountDisabledError } from '../auth/access-errors';
import { errorCodeOf, ResourceNotFoundError } from '../common/api-error';
import { SelfApprovalRefusedError, SelfReviewRefusedError } from './errors';
import {
  ACTIVE_SUPER_ADMIN_PROFILE,
  approversFor,
  assertRecordApprover,
  awaitingDecisionWhere,
  companiesWithActiveSuperAdmin,
  NotRecordApproverError,
  type DecisionKind,
  deciderFor,
} from './record-approver';
import { makeAuditor, makeMasterkey, makeStandardUser, makeSuperAdmin } from '../../test/helpers';
import type { RequestUser } from '../auth/auth.types';

/**
 * The approver rule's database side (inc26-roles-approval-chain, design
 * Decision 7; tasks 7.1, 7.2, 7.4). The pure rule (`recordApprover`,
 * `mayDecideRecord`) is the contract's; what is pinned here is what this
 * module READS to feed it — and, through a small evaluator of Prisma's where
 * objects with SQL's NULL semantics, what the filters it builds MATCH.
 */

// --- A tiny Prisma-where evaluator over fixture rows ------------------------

type Row = Record<string, unknown>;
/** Evaluate `where` against `row` the way Postgres would: a NULL never
 *  matches `in`/`notIn`, a relation filter needs the related row. */
function matches(row: Row | null | undefined, where: Record<string, unknown>): boolean {
  if (!row) return false;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Record<string, unknown>[]).every((w) => matches(row, w));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if ('in' in c) return value != null && (c.in as unknown[]).includes(value);
      if ('notIn' in c) return value != null && !(c.notIn as unknown[]).includes(value);
      // A to-one relation (`profile`, `invitation`).
      return matches(value as Row | null, c);
    }
    return value === cond;
  });
}

// --- Fixtures ---------------------------------------------------------------

interface Account {
  id: string;
  role: string;
  disabledAt?: Date | null;
  grants?: string[];
  /** null: never invited; otherwise the invitation's status. */
  invitation?: null | 'pending' | 'sent' | 'accepted' | 'revoked';
  organisationId?: string;
}

/** A db mock that answers the three reads from `accounts`, through the
 *  where each read builds — so a wrong where is a wrong answer. */
function dbOf(accounts: Account[]) {
  const profileRow = (a: Account) => ({
    id: a.id,
    role: a.role,
    disabledAt: a.disabledAt ?? null,
    organisationId: a.organisationId ?? 'org-1',
    invitation: a.invitation == null ? null : { status: a.invitation },
  });
  const accessRows = accounts.flatMap((a) =>
    (a.grants ?? []).map((subsidiaryId) => ({ subsidiaryId, profile: profileRow(a) })),
  );
  const db = {
    profile: {
      findUnique: vi.fn(async ({ where, select }: any) => {
        const a = accounts.find((x) => x.id === where.id);
        if (!a) return null;
        const only = select?.subsidiaryAccess?.where?.subsidiaryId;
        return {
          role: a.role,
          disabledAt: a.disabledAt ?? null,
          ...(select?.subsidiaryAccess
            ? { subsidiaryAccess: (a.grants ?? []).filter((s) => s === only).map((subsidiaryId) => ({ subsidiaryId })) }
            : {}),
        };
      }),
      findMany: vi.fn(async ({ where }: any) =>
        accounts
          .map(profileRow)
          .filter((p) => matches(p, where))
          .map((p) => ({ id: p.id, role: p.role, disabledAt: p.disabledAt })),
      ),
    },
    userSubsidiaryAccess: {
      findMany: vi.fn(async ({ where, distinct }: any) => {
        const hits = accessRows.filter((r) => matches(r, where)).map((r) => ({ subsidiaryId: r.subsidiaryId }));
        return distinct ? [...new Map(hits.map((h) => [h.subsidiaryId, h])).values()] : hits;
      }),
    },
  };
  return db;
}
type Db = ReturnType<typeof dbOf>;
const asTx = (db: Db) => db as never;

const MK = 'u-mk';
const MK2 = 'u-mk-2';
const SA = 'u-sa';
const SA2 = 'u-sa-2';
const STD = 'u-std';
const AUD = 'u-aud';

/** The seed's shape: company A staffed by two super_admins, company C by none. */
function org(extra: Account[] = []): Account[] {
  return [
    { id: MK, role: 'masterkey' },
    { id: MK2, role: 'masterkey' },
    { id: SA, role: 'super_admin', grants: ['sub-a'] },
    { id: SA2, role: 'super_admin', grants: ['sub-a'] },
    { id: STD, role: 'standard_user', grants: ['sub-a', 'sub-c'] },
    { id: AUD, role: 'auditor' },
    ...extra,
  ];
}

const mk = (over: Partial<RequestUser> = {}) => makeMasterkey({ id: MK, accessibleSubsidiaryIds: ['sub-a', 'sub-c'], ...over });
const sa = (over: Partial<RequestUser> = {}) => makeSuperAdmin({ id: SA, accessibleSubsidiaryIds: ['sub-a'], ...over });
const pending = (id: string, createdBy: string, subsidiaryId = 'sub-a', status = 'submitted') => ({
  id,
  createdBy,
  subsidiaryId,
  status,
});

// ---------------------------------------------------------------------------

describe('ACTIVE_SUPER_ADMIN_PROFILE / companiesWithActiveSuperAdmin — "an active super_admin" (ruling R3)', () => {
  it('is the role, not disabled, and an accepted invitation or none', () => {
    expect(ACTIVE_SUPER_ADMIN_PROFILE).toEqual({
      role: 'super_admin',
      disabledAt: null,
      OR: [{ invitation: null }, { invitation: { status: 'accepted' } }],
    });
  });

  it.each([
    ['never invited (seeded, provisioned)', null, true],
    ['an accepted invitation', 'accepted', true],
    ['an invitation still pending', 'pending', false],
    ['an invitation sent, not yet opened', 'sent', false],
    ['a revoked invitation', 'revoked', false],
  ] as const)('a super_admin with %s staffs its company: %s', async (_label, invitation, staffed) => {
    const db = dbOf([{ id: SA, role: 'super_admin', grants: ['sub-c'], invitation }]);
    expect(await companiesWithActiveSuperAdmin(asTx(db), ['sub-c'])).toEqual(new Set(staffed ? ['sub-c'] : []));
  });

  it('a disabled super_admin, or a granted account of another role, staffs nothing', async () => {
    const db = dbOf([
      { id: SA, role: 'super_admin', grants: ['sub-c'], disabledAt: new Date() },
      { id: STD, role: 'standard_user', grants: ['sub-c'] },
    ]);
    expect(await companiesWithActiveSuperAdmin(asTx(db), ['sub-c'])).toEqual(new Set());
  });

  it('asks once for every company, de-duplicated and distinct, and not at all for none', async () => {
    const db = dbOf(org());
    expect(await companiesWithActiveSuperAdmin(asTx(db), ['sub-a', 'sub-c', 'sub-a'])).toEqual(new Set(['sub-a']));
    expect(db.userSubsidiaryAccess.findMany).toHaveBeenCalledTimes(1);
    expect(db.userSubsidiaryAccess.findMany).toHaveBeenCalledWith({
      where: { subsidiaryId: { in: ['sub-a', 'sub-c'] }, profile: ACTIVE_SUPER_ADMIN_PROFILE },
      select: { subsidiaryId: true },
      distinct: ['subsidiaryId'],
    });
    await companiesWithActiveSuperAdmin(asTx(db), []);
    expect(db.userSubsidiaryAccess.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('approversFor — who decides each record of a page', () => {
  it('states super_admin, masterkey (fallback), masterkey (a super_admin\'s) and author, and null off the pending statuses', async () => {
    const db = dbOf(org());
    const map = await approversFor(asTx(db), [
      pending('std-a', STD, 'sub-a'),
      pending('std-c', STD, 'sub-c', 'under_review'),
      pending('sa-a', SA, 'sub-a'),
      pending('mk', MK, 'sub-a', 'under_review'),
      { ...pending('draft', STD), status: 'draft' },
      { ...pending('approved', STD), status: 'approved' },
      { ...pending('rejected', STD), status: 'rejected' },
      { ...pending('voided', STD), status: 'voided' },
      { ...pending('locked', STD), status: 'locked' },
    ]);
    expect(Object.fromEntries(map)).toEqual({
      'std-a': 'super_admin',
      'std-c': 'masterkey',
      'sa-a': 'masterkey',
      mk: 'author',
      draft: null,
      approved: null,
      rejected: null,
      voided: null,
      locked: null,
    });
  });

  it('reads the author\'s CURRENT role: since made a super_admin → masterkey; since made an auditor → super_admin', async () => {
    const db = dbOf(org([
      { id: 'u-promoted', role: 'super_admin', grants: ['sub-a'] },
      { id: 'u-auditor-now', role: 'auditor' },
    ]));
    const map = await approversFor(asTx(db), [pending('p', 'u-promoted'), pending('q', 'u-auditor-now')]);
    expect(map.get('p')).toBe('masterkey');
    expect(map.get('q')).toBe('super_admin');
  });

  it('routes a disabled author of any role, and a profile that is gone, by the company', async () => {
    const db = dbOf(org([
      { id: 'u-mk-off', role: 'masterkey', disabledAt: new Date() },
      { id: 'u-sa-off', role: 'super_admin', disabledAt: new Date(), grants: ['sub-a'] },
    ]));
    const map = await approversFor(asTx(db), [
      pending('mk-off-a', 'u-mk-off', 'sub-a'),
      pending('sa-off-c', 'u-sa-off', 'sub-c'),
      pending('gone-a', 'u-gone', 'sub-a'),
      pending('gone-c', 'u-gone', 'sub-c'),
    ]);
    expect(Object.fromEntries(map)).toEqual({
      'mk-off-a': 'super_admin',
      'sa-off-c': 'masterkey',
      'gone-a': 'super_admin',
      'gone-c': 'masterkey',
    });
  });

  it('falls back to the masterkey when the company\'s only super_admin has not accepted, or is disabled', async () => {
    for (const only of [
      { id: 'u-only', role: 'super_admin', grants: ['sub-x'], invitation: 'sent' as const },
      { id: 'u-only', role: 'super_admin', grants: ['sub-x'], disabledAt: new Date() },
    ]) {
      const db = dbOf([...org(), only]);
      expect((await approversFor(asTx(db), [pending('r', STD, 'sub-x')])).get('r')).toBe('masterkey');
    }
    // Accepted: the company is staffed, and the record is the super_admin's.
    const db = dbOf([...org(), { id: 'u-only', role: 'super_admin', grants: ['sub-x'], invitation: 'accepted' }]);
    expect((await approversFor(asTx(db), [pending('r', STD, 'sub-x')])).get('r')).toBe('super_admin');
  });

  it('batches: one author query and one company query for a page of 50, whatever its mix', async () => {
    const db = dbOf(org());
    const authors = [STD, SA, MK, SA2, 'u-gone'];
    const page = Array.from({ length: 50 }, (_, i) =>
      pending(`r-${i}`, authors[i % authors.length], i % 2 ? 'sub-a' : 'sub-c', i % 3 ? 'submitted' : 'under_review'),
    );
    const map = await approversFor(asTx(db), page);
    expect(map.size).toBe(50);
    expect(db.profile.findMany).toHaveBeenCalledTimes(1);
    expect(db.userSubsidiaryAccess.findMany).toHaveBeenCalledTimes(1);
    const authorQuery = db.profile.findMany.mock.calls[0][0];
    expect([...authorQuery.where.id.in].sort()).toEqual([...authors].sort());
    expect(authorQuery.select).toEqual({ id: true, role: true, disabledAt: true });
    expect([...db.userSubsidiaryAccess.findMany.mock.calls[0][0].where.subsidiaryId.in].sort()).toEqual(['sub-a', 'sub-c']);
  });

  it('asks nothing for a page with no pending record', async () => {
    const db = dbOf(org());
    const map = await approversFor(asTx(db), [{ ...pending('d', STD), status: 'draft' }]);
    expect(map.get('d')).toBeNull();
    expect(db.profile.findMany).not.toHaveBeenCalled();
    expect(db.userSubsidiaryAccess.findMany).not.toHaveBeenCalled();
  });
});

describe('assertRecordApprover — the decision\'s own re-read and its refusals, in order', () => {
  const KINDS: DecisionKind[] = ['review', 'reject', 'approve'];

  it.each(KINDS)('lets the record\'s approver %s: a super_admin, a standard user\'s record in its company', async (kind) => {
    const db = dbOf(org());
    await expect(assertRecordApprover(asTx(db), sa(), { createdBy: STD, subsidiaryId: 'sub-a' }, kind)).resolves.toBe('super_admin');
  });

  it.each(KINDS)('lets a masterkey %s a super_admin\'s record, and a standard user\'s in an unstaffed company', async (kind) => {
    const db = dbOf(org());
    await expect(assertRecordApprover(asTx(db), mk(), { createdBy: SA, subsidiaryId: 'sub-a' }, kind)).resolves.toBe('masterkey');
    await expect(assertRecordApprover(asTx(db), mk(), { createdBy: STD, subsidiaryId: 'sub-c' }, kind)).resolves.toBe('masterkey');
  });

  it.each(KINDS)('lets a masterkey %s their own record (ruling R1)', async (kind) => {
    const db = dbOf(org());
    await expect(assertRecordApprover(asTx(db), mk(), { createdBy: MK, subsidiaryId: 'sub-a' }, kind)).resolves.toBe('author');
  });

  it.each(KINDS)('refuses a masterkey who would %s a standard user\'s record in a staffed company: not_record_approver naming super_admin', async (kind) => {
    const db = dbOf(org());
    const refusal = await assertRecordApprover(asTx(db), mk(), { createdBy: STD, subsidiaryId: 'sub-a' }, kind).catch((e) => e);
    expect(refusal).toBeInstanceOf(NotRecordApproverError);
    expect(refusal.getStatus()).toBe(403);
    expect(errorCodeOf(refusal)).toBe('not_record_approver');
    expect(refusal.getResponse()).toMatchObject({ params: { approver: 'super_admin' } });
  });

  it.each(KINDS)('refuses a second masterkey who would %s another masterkey\'s record: naming its author', async (kind) => {
    const db = dbOf(org());
    const refusal = await assertRecordApprover(asTx(db), mk({ id: MK2 }), { createdBy: MK, subsidiaryId: 'sub-a' }, kind).catch((e) => e);
    expect(refusal).toBeInstanceOf(NotRecordApproverError);
    expect(refusal.getResponse()).toMatchObject({ params: { approver: 'author' } });
  });

  it.each(KINDS)('refuses a super_admin who would %s a colleague super_admin\'s record: naming masterkey', async (kind) => {
    const db = dbOf(org());
    const refusal = await assertRecordApprover(asTx(db), sa(), { createdBy: SA2, subsidiaryId: 'sub-a' }, kind).catch((e) => e);
    expect(refusal).toBeInstanceOf(NotRecordApproverError);
    expect(refusal.getResponse()).toMatchObject({ params: { approver: 'masterkey' } });
  });

  it('a super_admin is refused its own record: self_review_forbidden, self_approval_forbidden, and a return is not_record_approver naming masterkey', async () => {
    const db = dbOf(org());
    const own = { createdBy: SA, subsidiaryId: 'sub-a' };
    await expect(assertRecordApprover(asTx(db), sa(), own, 'review')).rejects.toBeInstanceOf(SelfReviewRefusedError);
    await expect(assertRecordApprover(asTx(db), sa(), own, 'approve')).rejects.toBeInstanceOf(SelfApprovalRefusedError);
    const ret = await assertRecordApprover(asTx(db), sa(), own, 'reject').catch((e) => e);
    expect(ret).toBeInstanceOf(NotRecordApproverError);
    expect(ret.getResponse()).toMatchObject({ params: { approver: 'masterkey' } });
  });

  it('a former author, now a super_admin of the company, is refused as the author, whatever role they held', async () => {
    const db = dbOf(org([{ id: 'u-moved', role: 'super_admin', grants: ['sub-a'] }]));
    const record = { createdBy: 'u-moved', subsidiaryId: 'sub-a' };
    await expect(assertRecordApprover(asTx(db), sa({ id: 'u-moved' }), record, 'approve')).rejects.toBeInstanceOf(SelfApprovalRefusedError);
    await expect(assertRecordApprover(asTx(db), sa({ id: 'u-moved' }), record, 'review')).rejects.toBeInstanceOf(SelfReviewRefusedError);
  });

  it('a former super_admin, now a masterkey, decides their own old record as its author', async () => {
    const db = dbOf(org([{ id: 'u-up', role: 'masterkey' }]));
    await expect(
      assertRecordApprover(asTx(db), mk({ id: 'u-up' }), { createdBy: 'u-up', subsidiaryId: 'sub-a' }, 'approve'),
    ).resolves.toBe('author');
  });

  describe('it re-reads the decider, so a change since authentication cannot be used', () => {
    it('a decider whose role was changed to standard_user or auditor is refused as forbidden (the role gate\'s answer)', async () => {
      for (const role of ['standard_user', 'auditor']) {
        const db = dbOf(org().map((a) => (a.id === SA ? { ...a, role } : a)));
        const refusal = await assertRecordApprover(asTx(db), sa(), { createdBy: STD, subsidiaryId: 'sub-a' }, 'approve').catch((e) => e);
        expect(refusal).toBeInstanceOf(ForbiddenException);
        expect(refusal).not.toBeInstanceOf(NotRecordApproverError);
        expect(refusal.message).toBe('Only a masterkey or a super_admin may decide records');
      }
    });

    it('a masterkey demoted to super_admin since authenticating decides only as a super_admin', async () => {
      // The token says masterkey; the database says super_admin of sub-a. A
      // super_admin's record is then not theirs to decide.
      const db = dbOf(org([{ id: 'u-demoted', role: 'super_admin', grants: ['sub-a'] }]));
      const refusal = await assertRecordApprover(asTx(db), mk({ id: 'u-demoted' }), { createdBy: SA, subsidiaryId: 'sub-a' }, 'approve').catch((e) => e);
      expect(refusal).toBeInstanceOf(NotRecordApproverError);
      expect(refusal.getResponse()).toMatchObject({ params: { approver: 'masterkey' } });
    });

    it('an author promoted to masterkey since authenticating self-decides on the role read in the transaction, not the token\'s', async () => {
      // The token still says super_admin; the database says masterkey. The
      // self check reads the re-read role (QA review: mutant M32), so the
      // record is the author's own to decide as a masterkey.
      const db = dbOf(org([{ id: 'u-promoted', role: 'masterkey' }]));
      await expect(
        assertRecordApprover(asTx(db), sa({ id: 'u-promoted' }), { createdBy: 'u-promoted', subsidiaryId: 'sub-a' }, 'approve'),
      ).resolves.toBe('author');
    });

    it('deciderFor answers the decider with the role re-read in the transaction, which the audit row then names (owner\'s review)', async () => {
      // The token says masterkey; the database says super_admin of sub-a, and a
      // standard user's record there is a super_admin's to decide.
      const db = dbOf(org([{ id: 'u-moved', role: 'super_admin', grants: ['sub-a'] }]));
      const decider = await deciderFor(asTx(db), mk({ id: 'u-moved' }), { createdBy: STD, subsidiaryId: 'sub-a' }, 'approve');
      expect(decider).toMatchObject({ id: 'u-moved', role: 'super_admin' });
      const same = await deciderFor(asTx(dbOf(org())), sa(), { createdBy: STD, subsidiaryId: 'sub-a' }, 'approve');
      expect(same.role).toBe('super_admin');
    });

    it('a super_admin whose grant for the company was withdrawn is answered as for an unknown record', async () => {
      const db = dbOf(org().map((a) => (a.id === SA ? { ...a, grants: ['sub-other'] } : a)));
      const refusal = await assertRecordApprover(asTx(db), sa(), { createdBy: STD, subsidiaryId: 'sub-a' }, 'approve').catch((e) => e);
      expect(refusal).toBeInstanceOf(ResourceNotFoundError);
      expect(errorCodeOf(refusal)).toBe('record_not_found');
      // Asked for THIS company's grant only.
      expect(db.profile.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SA },
          select: expect.objectContaining({
            subsidiaryAccess: { where: { subsidiaryId: 'sub-a' }, select: { subsidiaryId: true } },
          }),
        }),
      );
    });

    it('a decider since disabled, or whose profile is gone, is refused as account_disabled', async () => {
      const disabled = dbOf(org().map((a) => (a.id === SA ? { ...a, disabledAt: new Date() } : a)));
      const refusal = await assertRecordApprover(asTx(disabled), sa(), { createdBy: STD, subsidiaryId: 'sub-a' }, 'approve').catch((e) => e);
      expect(refusal).toBeInstanceOf(AccountDisabledError);
      expect(errorCodeOf(refusal)).toBe('account_disabled');
      const gone = dbOf(org().filter((a) => a.id !== SA));
      await expect(assertRecordApprover(asTx(gone), sa(), { createdBy: STD, subsidiaryId: 'sub-a' }, 'approve')).rejects.toBeInstanceOf(AccountDisabledError);
    });

    it('a super_admin appointed (and accepted) since the record was submitted takes it from the masterkey', async () => {
      const before = dbOf(org());
      await expect(assertRecordApprover(asTx(before), mk(), { createdBy: STD, subsidiaryId: 'sub-c' }, 'approve')).resolves.toBe('masterkey');
      const after = dbOf(org([{ id: 'u-new', role: 'super_admin', grants: ['sub-c'], invitation: 'accepted' }]));
      await expect(assertRecordApprover(asTx(after), mk(), { createdBy: STD, subsidiaryId: 'sub-c' }, 'approve')).rejects.toBeInstanceOf(NotRecordApproverError);
    });

    it('a super_admin who took a record into review and then lost the grant leaves it to another super_admin', async () => {
      const db = dbOf(org().map((a) => (a.id === SA ? { ...a, grants: [] } : a)));
      await expect(assertRecordApprover(asTx(db), sa(), { createdBy: STD, subsidiaryId: 'sub-a' }, 'approve')).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(assertRecordApprover(asTx(db), sa({ id: SA2 }), { createdBy: STD, subsidiaryId: 'sub-a' }, 'approve')).resolves.toBe('super_admin');
    });

    it('reads the author\'s current role and disabled state: a masterkey author since disabled routes to the company', async () => {
      const db = dbOf(org().map((a) => (a.id === MK2 ? { ...a, disabledAt: new Date() } : a)));
      await expect(assertRecordApprover(asTx(db), sa(), { createdBy: MK2, subsidiaryId: 'sub-a' }, 'approve')).resolves.toBe('super_admin');
      // …and its fellow masterkey is then not the approver.
      await expect(assertRecordApprover(asTx(db), mk(), { createdBy: MK2, subsidiaryId: 'sub-a' }, 'approve')).rejects.toBeInstanceOf(NotRecordApproverError);
    });
  });

  describe('the refusal order, pairwise', () => {
    it('disabled before the role: a disabled account whose role no longer decides hears account_disabled', async () => {
      const db = dbOf(org().map((a) => (a.id === SA ? { ...a, role: 'auditor', disabledAt: new Date() } : a)));
      await expect(assertRecordApprover(asTx(db), sa(), { createdBy: STD, subsidiaryId: 'sub-a' }, 'approve')).rejects.toBeInstanceOf(AccountDisabledError);
    });

    it('the role before the grant: a demoted, ungranted decider hears forbidden, not not-found', async () => {
      const db = dbOf(org().map((a) => (a.id === SA ? { ...a, role: 'standard_user', grants: [] } : a)));
      const refusal = await assertRecordApprover(asTx(db), sa(), { createdBy: STD, subsidiaryId: 'sub-a' }, 'approve').catch((e) => e);
      expect(refusal).toBeInstanceOf(ForbiddenException);
      expect(refusal).not.toBeInstanceOf(ResourceNotFoundError);
    });

    it('the grant before self-approval: an author who lost the grant hears not-found', async () => {
      const db = dbOf(org().map((a) => (a.id === SA ? { ...a, grants: [] } : a)));
      await expect(assertRecordApprover(asTx(db), sa(), { createdBy: SA, subsidiaryId: 'sub-a' }, 'approve')).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it('self-approval before not_record_approver: a super_admin\'s own record (decided by a masterkey) answers self_approval_forbidden', async () => {
      const db = dbOf(org());
      const refusal = await assertRecordApprover(asTx(db), sa(), { createdBy: SA, subsidiaryId: 'sub-a' }, 'approve').catch((e) => e);
      expect(refusal).toBeInstanceOf(SelfApprovalRefusedError);
      expect(refusal).not.toBeInstanceOf(NotRecordApproverError);
    });

    it('self-review before not_record_approver, the same way', async () => {
      const db = dbOf(org());
      await expect(assertRecordApprover(asTx(db), sa(), { createdBy: SA, subsidiaryId: 'sub-a' }, 'review')).rejects.toBeInstanceOf(SelfReviewRefusedError);
    });
  });

  it('reads the decider, the author and the company in one round, the author only when there is one', async () => {
    const db = dbOf(org());
    await assertRecordApprover(asTx(db), sa(), { createdBy: STD, subsidiaryId: 'sub-a' }, 'approve');
    expect(db.profile.findUnique).toHaveBeenCalledTimes(2);
    expect(db.profile.findUnique).toHaveBeenCalledWith({ where: { id: STD }, select: { role: true, disabledAt: true } });
    expect(db.userSubsidiaryAccess.findMany).toHaveBeenCalledTimes(1);
    db.profile.findUnique.mockClear();
    await assertRecordApprover(asTx(db), mk(), { createdBy: null, subsidiaryId: 'sub-c' }, 'approve');
    expect(db.profile.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('awaitingDecisionWhere — the review queue\'s default view as a filter', () => {
  /** The organisation's pending records, as rows the evaluator can match. */
  const rows = [
    pending('std-a', STD, 'sub-a'),
    pending('own-sa', SA, 'sub-a'),
    pending('sa2-a', SA2, 'sub-a', 'under_review'),
    pending('own-mk', MK, 'sub-a'),
    pending('std-c', STD, 'sub-c'),
    pending('mk2', MK2, 'sub-c'),
    pending('aud-a', AUD, 'sub-a'),
    pending('gone-c', 'u-gone', 'sub-c'),
    { ...pending('draft-a', STD, 'sub-a'), status: 'draft' },
    { ...pending('approved-c', STD, 'sub-c'), status: 'approved' },
  ];
  const listed = (where: Record<string, unknown>) => rows.filter((r) => matches(r, where)).map((r) => r.id);

  it('a super_admin\'s default queue: the company\'s standard user record, not its own nor a colleague super_admin\'s', async () => {
    const db = dbOf(org());
    const where = await awaitingDecisionWhere(asTx(db), sa());
    expect(where).not.toBeNull();
    // `aud-a`: an author since made an auditor is routed like a standard user.
    expect(listed(where!)).toEqual(['std-a', 'aud-a']);
  });

  it('a masterkey\'s default queue: a super_admin\'s, its own, and a standard user\'s in an unstaffed company — not a staffed company\'s, nor another masterkey\'s', async () => {
    const db = dbOf(org());
    const where = await awaitingDecisionWhere(asTx(db), mk());
    expect(listed(where!)).toEqual(['own-sa', 'sa2-a', 'own-mk', 'std-c', 'gone-c']);
  });

  it('agrees with approversFor on every pending row, for both deciders', async () => {
    const db = dbOf(org());
    const approvers = await approversFor(asTx(db), rows);
    const mkWhere = (await awaitingDecisionWhere(asTx(db), mk()))!;
    const saWhere = (await awaitingDecisionWhere(asTx(db), sa()))!;
    for (const r of rows.filter((x) => x.status === 'submitted' || x.status === 'under_review')) {
      const approver = approvers.get(r.id);
      const mkDecides = approver === 'masterkey' ? r.createdBy !== MK : approver === 'author' && r.createdBy === MK;
      const saDecides = approver === 'super_admin' && r.createdBy !== SA && r.subsidiaryId === 'sub-a';
      expect(matches(r, mkWhere), `masterkey on ${r.id}`).toBe(mkDecides);
      expect(matches(r, saWhere), `super_admin on ${r.id}`).toBe(saDecides);
    }
  });

  it('a disabled masterkey\'s pending record goes to the company\'s super_admin', async () => {
    const db = dbOf(org().map((a) => (a.id === MK2 ? { ...a, disabledAt: new Date() } : a)));
    const record = pending('mk2-off-a', MK2, 'sub-a');
    expect(matches(record, (await awaitingDecisionWhere(asTx(db), sa()))!)).toBe(true);
    expect(matches(record, (await awaitingDecisionWhere(asTx(db), mk()))!)).toBe(false);
  });

  it('reads the organisation\'s active deciders, keyed by the caller\'s organisation, and the caller\'s companies\' staffing', async () => {
    const db = dbOf(org([{ id: 'u-other-org-mk', role: 'masterkey', organisationId: 'org-2' }]));
    await awaitingDecisionWhere(asTx(db), mk());
    expect(db.profile.findMany).toHaveBeenCalledWith({
      where: { organisationId: 'org-1', disabledAt: null, role: { in: ['masterkey', 'super_admin'] } },
      select: { id: true, role: true },
    });
    expect([...db.userSubsidiaryAccess.findMany.mock.calls[0][0].where.subsidiaryId.in].sort()).toEqual(['sub-a', 'sub-c']);
  });

  it.each([
    ['a standard user', makeStandardUser()],
    ['an auditor', makeAuditor()],
    ['an organisation-less masterkey', makeMasterkey({ organisationId: null as never })],
  ] as const)('is null for %s, who decides nothing — and asks nothing', async (_label, user) => {
    const db = dbOf(org());
    expect(await awaitingDecisionWhere(asTx(db), user)).toBeNull();
    expect(db.profile.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// inc26-central-reporter-onboarding (task 4.7, design D7): a record entered
// under a central reporter grant is decided for its OWNING company — the
// record's company — by the routing that exists; the reporting entity is not
// an input to it.
// ---------------------------------------------------------------------------

describe("a central reporter's record is decided for its owning company (D7)", () => {
  const REP = 'u-reporter'; // a standard user: main company sub-r, a grant for sub-a and sub-c
  const SAR = 'u-sa-r'; // the reporting company's super_admin, not granted sub-a
  const reporterOrg = (extra: Account[] = []) => org([
    { id: REP, role: 'standard_user', grants: ['sub-r', 'sub-a', 'sub-c'] },
    { id: SAR, role: 'super_admin', grants: ['sub-r'] },
    ...extra,
  ]);
  const reported = (id: string, subsidiaryId: string, status = 'submitted') => ({ ...pending(id, REP, subsidiaryId, status), reportedBySubsidiaryId: 'sub-r' });

  it("routes to the owning company's super_admin, else the masterkey — never to the reporting company's", async () => {
    const map = await approversFor(asTx(dbOf(reporterOrg())), [reported('owned-a', 'sub-a'), reported('owned-c', 'sub-c')]);
    expect(Object.fromEntries(map)).toEqual({ 'owned-a': 'super_admin', 'owned-c': 'masterkey' });
    const db = dbOf(reporterOrg());
    await expect(assertRecordApprover(asTx(db), sa(), { createdBy: REP, subsidiaryId: 'sub-a' }, 'approve')).resolves.toBe('super_admin');
    await expect(assertRecordApprover(asTx(db), mk(), { createdBy: REP, subsidiaryId: 'sub-c' }, 'approve')).resolves.toBe('masterkey');
  });

  it('a reporter made a super_admin after submitting is decided by a masterkey', async () => {
    const db = dbOf(org([{ id: REP, role: 'super_admin', grants: ['sub-r'] }, { id: SAR, role: 'super_admin', grants: ['sub-r'] }]));
    expect((await approversFor(asTx(db), [reported('p', 'sub-a')])).get('p')).toBe('masterkey');
    await expect(assertRecordApprover(asTx(db), mk(), { createdBy: REP, subsidiaryId: 'sub-a' }, 'approve')).resolves.toBe('masterkey');
  });

  it("a disabled reporter's record is taken into review and returned by the owning company's super_admin", async () => {
    const db = dbOf(org([{ id: REP, role: 'standard_user', disabledAt: new Date(), grants: ['sub-r', 'sub-a'] }]));
    expect((await approversFor(asTx(db), [reported('p', 'sub-a')])).get('p')).toBe('super_admin');
    for (const kind of ['review', 'reject'] as const) {
      await expect(assertRecordApprover(asTx(db), sa(), { createdBy: REP, subsidiaryId: 'sub-a' }, kind)).resolves.toBe('super_admin');
    }
  });

  it('the reporting entity changes nothing: the same record with and without one is routed alike', async () => {
    const db = dbOf(reporterOrg());
    const withEntity = await approversFor(asTx(db), [reported('x', 'sub-a')]);
    const without = await approversFor(asTx(db), [pending('x', REP, 'sub-a')]);
    expect(withEntity.get('x')).toBe(without.get('x'));
  });
});
