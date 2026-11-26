import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, UserRole } from '@tonyai/db';
import type { Category, UserAccessGrantDTO } from '@tonyai/shared-types';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { AccessAdminService, conflictsVisibleTo, tenantAdminLockKey } from './access-admin.service';
import type { RequestUser } from './auth.types';

// DB-free: the refusals that must happen before any query, and — on an
// in-memory organisation below — the rules of design Decision 9 (who
// administers whom, scope, one company, categories, audit). The database half
// (organisation bounds, the per-organisation lock, audit atomicity) is proven
// on PostgreSQL in test/int/access-admin.int.spec.ts.

const ORG = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';

function setup() {
  const prisma = { $transaction: vi.fn() };
  const service = new AccessAdminService(prisma as unknown as PrismaService, {} as AuditService);
  return { prisma, service };
}

const user = (role: RequestUser['role'], organisationId: string | null = ORG): RequestUser => ({
  id: 'actor',
  email: 'actor@tonyai.test',
  fullName: 'Actor',
  role,
  organisationId,
  accessibleSubsidiaryIds: [],
});

/** A masterkey invites an auditor (no grants) — the plain invitation of the refusal-bound cases. */
const INVITE = { email: 'new@tonyai.test', fullName: 'New', role: UserRole.auditor, language: 'en' as const, access: [] as UserAccessGrantDTO[] };
const RETIRED_ROLES = ['consultant', 'data_entry', 'executive_viewer'] as const;

describe('AccessAdminService — refusals before the database is touched', () => {
  it.each(['standard_user', 'auditor'] as const)('a %s invites, re-sends, sets access or roles, disables or enables nothing', async (role) => {
    const { prisma, service } = setup();
    await expect(service.inviteMember(user(role), { ...INVITE, role: UserRole.standard_user })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.reopenInvitation(user(role), 'p')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.replaceSubsidiaryAccess(user(role), 'p', [])).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.setRole(user(role), 'p', UserRole.auditor)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.disableMember(user(role), 'p')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.enableMember(user(role), 'p')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a super_admin changes no role and disables or enables nobody (Decision 9: "no")', async () => {
    const { prisma, service } = setup();
    await expect(service.setRole(user('super_admin'), 'p', UserRole.auditor)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.setRole(user('super_admin'), 'p', UserRole.standard_user)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.disableMember(user('super_admin'), 'p')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.enableMember(user('super_admin'), 'p')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['masterkey', 'standard_user'],
    ['masterkey', 'masterkey'],
    ['super_admin', 'auditor'],
    ['super_admin', 'super_admin'],
    ['super_admin', 'masterkey'],
  ] as const)('a %s may not invite a %s: forbidden, nothing written', async (actorRole, role) => {
    const { prisma, service } = setup();
    await expect(service.inviteMember(user(actorRole), { ...INVITE, role })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['masterkey', 'super_admin'] as const)('nobody is made a masterkey by a role change — a %s asking is forbidden, nothing written', async (actorRole) => {
    const { prisma, service } = setup();
    await expect(service.setRole(user(actorRole), 'p', UserRole.masterkey)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('nobody disables their own account or changes their own role (so the actor always stays an active masterkey) — in any spelling of the id', async () => {
    const { prisma, service } = setup();
    await expect(service.disableMember(user('masterkey'), 'actor')).rejects.toMatchObject({ response: { code: 'own_account_forbidden' } });
    await expect(service.disableMember(user('masterkey'), 'ACTOR')).rejects.toMatchObject({ response: { code: 'own_account_forbidden' } });
    await expect(service.setRole(user('masterkey'), 'actor', UserRole.auditor)).rejects.toMatchObject({ response: { code: 'own_account_forbidden' } });
    await expect(service.setRole(user('masterkey'), 'ACTOR', UserRole.super_admin)).rejects.toMatchObject({ response: { code: 'own_account_forbidden' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a masterkey with no organisation administers nothing — there is no platform-wide administrator', async () => {
    const { prisma, service } = setup();
    await expect(service.replaceSubsidiaryAccess(user('masterkey', null), 'p', [])).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.setRole(user('masterkey', null), 'p', UserRole.auditor)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.inviteMember(user('masterkey', null), INVITE)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.disableMember(user('masterkey', null), 'p')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(RETIRED_ROLES)('the retired role %s is invalid in an invitation and a role change, nothing written', async (role) => {
    const { prisma, service } = setup();
    await expect(service.inviteMember(user('masterkey'), { ...INVITE, role: role as UserRole })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.setRole(user('masterkey'), 'p', role as UserRole)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('an unknown role or language is refused', async () => {
    const { prisma, service } = setup();
    await expect(service.setRole(user('masterkey'), 'p', 'platform_admin' as UserRole)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.inviteMember(user('masterkey'), { ...INVITE, role: 'platform_admin' as UserRole })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.inviteMember(user('masterkey'), { ...INVITE, language: 'de' as 'en' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('an invitation\'s access is checked before the database: grants for an auditor and categories for a super_admin are access_role_mismatch', async () => {
    const { prisma, service } = setup();
    await expect(service.inviteMember(user('masterkey'), { ...INVITE, role: UserRole.auditor, access: [{ subsidiaryId: SUB, categories: [] }] })).rejects.toMatchObject({
      response: { code: 'access_role_mismatch' },
    });
    await expect(service.inviteMember(user('masterkey'), {
      ...INVITE, role: UserRole.super_admin, access: [{ subsidiaryId: SUB, categories: ['Electricity'] }],
    })).rejects.toMatchObject({ response: { code: 'access_role_mismatch' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('an unknown category or a company named twice is invalid (400) before the database', async () => {
    const { prisma, service } = setup();
    await expect(service.inviteMember(user('super_admin'), {
      ...INVITE, role: UserRole.standard_user, access: [{ subsidiaryId: SUB, categories: ['Steam' as Category] }],
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.inviteMember(user('masterkey'), {
      ...INVITE, role: UserRole.super_admin, access: [{ subsidiaryId: SUB, categories: [] }, { subsidiaryId: SUB.toUpperCase(), categories: [] }],
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('tenantAdminLockKey', () => {
  it('is stable for an organisation and differs between organisations', () => {
    expect(tenantAdminLockKey(ORG)).toBe(tenantAdminLockKey(ORG));
    // Any spelling of one organisation's id reaches the same lock (the operator CLI, the API).
    const lettered = 'abcdef12-3456-4789-8abc-def012345678';
    expect(tenantAdminLockKey(lettered.toUpperCase())).toBe(tenantAdminLockKey(lettered));
    expect(tenantAdminLockKey(ORG)).not.toBe(tenantAdminLockKey('22222222-2222-4222-8222-222222222222'));
    expect(Number.isInteger(tenantAdminLockKey(ORG))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// An in-memory organisation: the service's queries answered from plain rows,
// each transaction run on a copy that replaces the state only when it
// resolves — so "nothing written" is the state, the audit trail included,
// exactly as before the call.
// ---------------------------------------------------------------------------

const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const C = 'cccccccc-0000-4000-8000-00000000000c';
const X = 'eeeeeeee-0000-4000-8000-00000000000e'; // another organisation's company
const ASSOCIATE = 'dddddddd-0000-4000-8000-00000000000d'; // inc26-group-tree: an associate
const SECTOR_GROUP = 'ffffffff-0000-4000-8000-00000000000f'; // and a sector group

interface ProfileRow { id: string; email: string; role: string; organisationId: string; disabledAt: Date | null }
interface GrantRow { userId: string; subsidiaryId: string; organisationId: string; categories: string[]; kind?: string }
interface AuditRow { actorId: string; actorRole: string; action: string; entity: string; entityId: string | null; diff?: unknown }
interface State {
  profiles: ProfileRow[];
  grants: GrantRow[];
  invitations: { profileId: string; status: string; language: string; invitedBy: string | null }[];
  audits: AuditRow[];
}

const SUBSIDIARIES = [
  { id: A, organisationId: ORG, nodeType: 'company', control: 'controlled' },
  { id: B, organisationId: ORG, nodeType: 'company', control: 'controlled' },
  { id: C, organisationId: ORG, nodeType: 'company', control: 'controlled' },
  { id: X, organisationId: OTHER_ORG, nodeType: 'company', control: 'controlled' },
  // inc26-group-tree: nodes closed to data entry, which take no grant.
  { id: ASSOCIATE, organisationId: ORG, nodeType: 'company', control: 'associate' },
  { id: SECTOR_GROUP, organisationId: ORG, nodeType: 'sector_group', control: 'controlled' },
];

type Seed = {
  id: string;
  role: string;
  grants?: Record<string, readonly string[]>;
  /** inc26-central-reporter-onboarding: a company of a central reporter grant, with its categories. */
  reports?: Record<string, readonly string[]>;
  organisationId?: string;
  disabled?: boolean;
};

/** The people of the in-memory organisation; each test seeds those it needs. */
function world(seed: Seed[]) {
  let state: State = {
    profiles: seed.map((p) => ({
      id: p.id, email: `${p.id}@tonyai.test`, role: p.role, organisationId: p.organisationId ?? ORG, disabledAt: p.disabled ? new Date() : null,
    })),
    grants: seed.flatMap((p) => [
      ...Object.entries(p.grants ?? {}).map(([subsidiaryId, categories]) => ({
        userId: p.id, subsidiaryId, organisationId: p.organisationId ?? ORG, categories: [...categories], kind: 'assigned',
      })),
      ...Object.entries(p.reports ?? {}).map(([subsidiaryId, categories]) => ({
        userId: p.id, subsidiaryId, organisationId: p.organisationId ?? ORG, categories: [...categories], kind: 'central_reporter',
      })),
    ]),
    invitations: [],
    audits: [],
  };
  let draft: State = state;
  const transactions = { begun: 0, committed: 0 };

  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('SELECT now()')) return [{ now: new Date('2026-11-25T10:00:00.000Z') }];
      if (sql.includes('DELETE FROM user_subsidiary_access')) {
        const [userId, organisationId] = values as string[];
        const gone = draft.grants.filter((g) => g.userId === userId && g.organisationId === organisationId);
        draft.grants = draft.grants.filter((g) => !gone.includes(g));
        return gone.map((g) => ({ subsidiaryId: g.subsidiaryId, kind: g.kind ?? 'assigned', categories: [...g.categories] }));
      }
      throw new Error(`unexpected raw query: ${sql}`);
    }),
    auditLog: { aggregate: vi.fn(async () => ({ _count: 0, _min: { createdAt: null } })) },
    profile: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.email !== undefined) {
          const p = draft.profiles.find((q) => q.email === where.email);
          return p ? { id: p.id } : null;
        }
        const p = draft.profiles.find((q) => q.id === where.id);
        if (!p) return null;
        return {
          role: p.role,
          organisationId: p.organisationId,
          disabledAt: p.disabledAt,
          organisation: { offboardedAt: null },
          subsidiaryAccess: draft.grants
            .filter((g) => g.userId === p.id && g.organisationId === p.organisationId)
            .map((g) => ({ subsidiaryId: g.subsidiaryId })),
        };
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; organisationId: string } }) => {
        const p = draft.profiles.find((q) => q.id === where.id && q.organisationId === where.organisationId);
        return p ? { id: p.id, role: p.role, disabledAt: p.disabledAt } : null;
      }),
      create: vi.fn(async ({ data }: { data: ProfileRow }) => {
        draft.profiles.push({ ...data, disabledAt: null });
        return {};
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<ProfileRow> }) => {
        const p = draft.profiles.find((q) => q.id === where.id)!;
        if (data.role !== undefined) p.role = data.role;
        if ('disabledAt' in data) p.disabledAt = data.disabledAt ?? null;
        return {};
      }),
    },
    subsidiary: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; organisationId: string } }) =>
        SUBSIDIARIES.filter((s) => where.id.in.includes(s.id) && s.organisationId === where.organisationId)
          .map(({ nodeType, control }) => ({ nodeType, control }))),
    },
    userSubsidiaryAccess: {
      findMany: vi.fn(async ({ where }: {
        where: { userId: string | { not: string }; organisationId: string; subsidiaryId?: { in: string[] } };
      }) => {
        // The single-entry read (design D4): the other accounts' rows at some companies, with their holder's role.
        if (typeof where.userId === 'object') {
          const not = where.userId.not;
          return draft.grants
            .filter((g) => g.userId !== not && g.organisationId === where.organisationId && where.subsidiaryId!.in.includes(g.subsidiaryId))
            .map((g) => ({
              userId: g.userId, subsidiaryId: g.subsidiaryId, kind: g.kind ?? 'assigned', categories: [...g.categories],
              profile: { role: draft.profiles.find((q) => q.id === g.userId)?.role ?? null },
            }));
        }
        return draft.grants
          .filter((g) => g.userId === where.userId && g.organisationId === where.organisationId)
          .map((g) => ({ subsidiaryId: g.subsidiaryId, categories: [...g.categories], kind: g.kind ?? 'assigned' }));
      }),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string; organisationId: string; subsidiaryId: { in: string[] } } }) => {
        const before = draft.grants.length;
        draft.grants = draft.grants.filter(
          (g) => !(g.userId === where.userId && g.organisationId === where.organisationId && where.subsidiaryId.in.includes(g.subsidiaryId)),
        );
        return { count: before - draft.grants.length };
      }),
      createMany: vi.fn(async ({ data }: { data: GrantRow[] }) => {
        draft.grants.push(...data.map((g) => ({ ...g, categories: [...g.categories], kind: g.kind ?? 'assigned' })));
        return { count: data.length };
      }),
      update: vi.fn(async ({ where, data }: { where: { userId_subsidiaryId: { userId: string; subsidiaryId: string } }; data: { categories: string[]; kind?: string } }) => {
        const g = draft.grants.find((r) => r.userId === where.userId_subsidiaryId.userId && r.subsidiaryId === where.userId_subsidiaryId.subsidiaryId)!;
        g.categories = [...data.categories];
        if (data.kind !== undefined) g.kind = data.kind;
        return {};
      }),
    },
    invitation: {
      create: vi.fn(async ({ data }: { data: State['invitations'][number] }) => {
        draft.invitations.push({ ...data, status: 'pending' });
        return {};
      }),
      findUnique: vi.fn(async ({ where }: { where: { profileId: string } }) => draft.invitations.find((i) => i.profileId === where.profileId) ?? null),
      update: vi.fn(async ({ where, data }: { where: { profileId: string }; data: { status: string } }) => {
        draft.invitations.find((i) => i.profileId === where.profileId)!.status = data.status;
        return {};
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };

  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      transactions.begun += 1;
      draft = structuredClone(state);
      const result = await fn(tx);
      state = draft;
      transactions.committed += 1;
      return result;
    }),
  };
  const audit = {
    record: vi.fn(async (actor: RequestUser, entry: Omit<AuditRow, 'actorId' | 'actorRole'>, writer: unknown) => {
      expect(writer).toBe(tx); // in the same transaction as the change
      draft.audits.push({ actorId: actor.id, actorRole: actor.role, ...entry });
    }),
  };
  const service = new AccessAdminService(prisma as unknown as PrismaService, audit as unknown as AuditService);

  /** The caller as the guard authenticated it: a granted role's own grants, else every company. */
  const as = (id: string, over: Partial<RequestUser> = {}): RequestUser => {
    const p = state.profiles.find((q) => q.id === id)!;
    const own = state.grants.filter((g) => g.userId === id).map((g) => g.subsidiaryId);
    return {
      id, email: p.email, fullName: id, role: p.role as RequestUser['role'], organisationId: p.organisationId,
      accessibleSubsidiaryIds: p.role === 'super_admin' || p.role === 'standard_user' ? own : [A, B, C], ...over,
    };
  };
  /** A profile's rows now with their kinds: company → `kind:categories`. */
  const rowsOf = (id: string) => Object.fromEntries(
    state.grants.filter((g) => g.userId === id).sort((x, y) => x.subsidiaryId.localeCompare(y.subsidiaryId))
      .map((g) => [g.subsidiaryId, `${g.kind ?? 'assigned'}:${g.categories.join(',')}`]),
  );
  /** A profile's grants now: company → sorted-as-stored categories. */
  const grantsOf = (id: string) => Object.fromEntries(
    state.grants.filter((g) => g.userId === id).sort((x, y) => x.subsidiaryId.localeCompare(y.subsidiaryId)).map((g) => [g.subsidiaryId, g.categories]),
  );
  const roleOf = (id: string) => state.profiles.find((q) => q.id === id)?.role;
  /** Mutates the committed state — what another request did since authentication. */
  const meanwhile = (fn: (s: State) => void) => fn(state);
  return { service, prisma, audit, tx, as, grantsOf, rowsOf, roleOf, meanwhile, state: () => state, audits: () => state.audits, transactions };
}

/** The state, as a value: compare before and after a refusal. */
const snapshot = (w: ReturnType<typeof world>) => structuredClone(w.state());

const MK = 'mk-actor';
const MK2 = 'mk-other';
const SA = 'sa-actor'; // a super_admin granted A
const SAB = 'sa-ab-actor'; // a super_admin granted A and B
const SB = 'sa-b-actor'; // a super_admin granted B
const T = 'target';

describe('Decision 9 — invite', () => {
  const invite = (role: string, access: UserAccessGrantDTO[] = []) => ({ ...INVITE, role: role as UserRole, access });

  it('a masterkey invites a super_admin for A and B: the account, a grant each with no categories, and the invitation plus one audit row per grant', async () => {
    const w = world([{ id: MK, role: 'masterkey' }]);
    const { profileId } = await w.service.inviteMember(w.as(MK), invite('super_admin', [{ subsidiaryId: B, categories: [] }, { subsidiaryId: A, categories: [] }]));
    expect(w.roleOf(profileId)).toBe('super_admin');
    expect(w.grantsOf(profileId)).toEqual({ [A]: [], [B]: [] });
    expect(w.state().invitations).toEqual([expect.objectContaining({ profileId, invitedBy: MK })]);
    expect(w.audits().map((r) => [r.action, r.entity, r.entityId, r.diff])).toEqual([
      ['invite', 'invitation', profileId, { role: 'super_admin', language: 'en', subsidiaryIds: [A, B] }],
      ['create', 'subsidiary_access', profileId, { subsidiaryId: A }],
      ['create', 'subsidiary_access', profileId, { subsidiaryId: B }],
    ]);
    expect(JSON.stringify(w.audits())).not.toContain(INVITE.email);
  });

  it('a masterkey invites an auditor with no company: created, no grant', async () => {
    const w = world([{ id: MK, role: 'masterkey' }]);
    const { profileId } = await w.service.inviteMember(w.as(MK), invite('auditor'));
    expect(w.roleOf(profileId)).toBe('auditor');
    expect(w.grantsOf(profileId)).toEqual({});
  });

  it('a super_admin granted A and B invites a standard user for A: categories validated, stored sorted and unique, audited with the grant', async () => {
    const w = world([{ id: SAB, role: 'super_admin', grants: { [A]: [], [B]: [] } }]);
    const { profileId } = await w.service.inviteMember(
      w.as(SAB),
      invite('standard_user', [{ subsidiaryId: A, categories: ['Natural Gas', 'Electricity', 'Electricity'] }]),
    );
    expect(w.roleOf(profileId)).toBe('standard_user');
    expect(w.grantsOf(profileId)).toEqual({ [A]: ['Electricity', 'Natural Gas'] });
    expect(w.audits().map((r) => [r.action, r.entity, r.diff])).toEqual([
      ['invite', 'invitation', { role: 'standard_user', language: 'en', subsidiaryIds: [A] }],
      ['create', 'subsidiary_access', { subsidiaryId: A, categories: ['Electricity', 'Natural Gas'] }],
    ]);
  });

  it('a standard user invited with no category ticked is accepted, the grant stored with an empty list', async () => {
    const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }]);
    const { profileId } = await w.service.inviteMember(w.as(SA), invite('standard_user', [{ subsidiaryId: A, categories: [] }]));
    expect(w.grantsOf(profileId)).toEqual({ [A]: [] });
  });

  it('an invitation for two companies is refused with standard_user_single_company: no account, grant or invitation', async () => {
    const w = world([{ id: SAB, role: 'super_admin', grants: { [A]: [], [B]: [] } }]);
    const before = snapshot(w);
    await expect(w.service.inviteMember(w.as(SAB), invite('standard_user', [
      { subsidiaryId: A, categories: [] }, { subsidiaryId: B, categories: [] },
    ]))).rejects.toMatchObject({ status: 409, response: { code: 'standard_user_single_company' } });
    expect(w.state()).toEqual(before);
  });

  it('a super_admin granted only A naming C of the same organisation is refused as an unknown company, nothing written', async () => {
    const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }]);
    const before = snapshot(w);
    await expect(w.service.inviteMember(w.as(SA), invite('standard_user', [{ subsidiaryId: C, categories: [] }])))
      .rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
    expect(w.state()).toEqual(before);
  });

  it.each([MK, SA])('a company of another organisation answers as unknown (%s), nothing written', async (actor) => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: SA, role: 'super_admin', grants: { [A]: [] } }]);
    const before = snapshot(w);
    const role = actor === MK ? 'super_admin' : 'standard_user';
    await expect(w.service.inviteMember(w.as(actor), invite(role, [{ subsidiaryId: X, categories: [] }])))
      .rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
    expect(w.state()).toEqual(before);
  });

  it.each([
    ['an associate', ASSOCIATE],
    ['a sector group', SECTOR_GROUP],
  ])('an invitation naming %s is refused as not assignable, nothing written (inc26-group-tree)', async (_what, subsidiaryId) => {
    const w = world([{ id: MK, role: 'masterkey' }]);
    const before = snapshot(w);
    await expect(w.service.inviteMember(w.as(MK), invite('super_admin', [{ subsidiaryId: A, categories: [] }, { subsidiaryId, categories: [] }])))
      .rejects.toMatchObject({ response: { code: 'subsidiary_not_assignable', statusCode: 409 } });
    expect(w.state()).toEqual(before);
  });

  it.each([
    ['an associate', ASSOCIATE],
    ['a sector group', SECTOR_GROUP],
  ])('an access change granting %s is refused as not assignable, the grants unchanged', async (_what, subsidiaryId) => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'super_admin', grants: { [A]: [] } }]);
    const before = snapshot(w);
    await expect(w.service.replaceSubsidiaryAccess(w.as(MK), T, [{ subsidiaryId: A, categories: [] }, { subsidiaryId, categories: [] }]))
      .rejects.toMatchObject({ response: { code: 'subsidiary_not_assignable' } });
    expect(w.state()).toEqual(before);
  });

  it('a closed node of another organisation still answers as unknown, not as not assignable', async () => {
    const w = world([{ id: MK, role: 'masterkey' }]);
    await expect(w.service.inviteMember(w.as(MK), invite('super_admin', [{ subsidiaryId: X, categories: [] }, { subsidiaryId: ASSOCIATE, categories: [] }])))
      .rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
  });

  it('a super_admin whose grant for A was withdrawn after authentication cannot invite into A: unknown company, nothing written', async () => {
    const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }]);
    const actor = w.as(SA); // authenticated holding A
    w.meanwhile((s) => { s.grants = s.grants.filter((g) => g.userId !== SA); });
    const before = snapshot(w);
    await expect(w.service.inviteMember(actor, invite('standard_user', [{ subsidiaryId: A, categories: [] }])))
      .rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
    expect(w.state()).toEqual(before);
  });

  it.each([
    ['super_admin', 'standard_user', 'standard_user'],
    ['masterkey', 'auditor', 'auditor'],
    ['masterkey', 'super_admin', 'auditor'],
  ] as const)('a %s demoted to %s between authentication and the lock cannot invite a(n) %s: forbidden, nothing written', async (was, now, role) => {
    const w = world([{ id: 'x', role: was, grants: was === 'super_admin' ? { [A]: [] } : {} }]);
    const actor = w.as('x');
    w.meanwhile((s) => { s.profiles[0].role = now; });
    const before = snapshot(w);
    await expect(w.service.inviteMember(actor, invite(role, role === 'standard_user' ? [{ subsidiaryId: A, categories: [] }] : [])))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(w.state()).toEqual(before);
  });

  it('an actor disabled since authentication is signed out (account_disabled), nothing written', async () => {
    const w = world([{ id: MK, role: 'masterkey' }]);
    const actor = w.as(MK);
    w.meanwhile((s) => { s.profiles[0].disabledAt = new Date(); });
    const before = snapshot(w);
    await expect(w.service.inviteMember(actor, invite('auditor'))).rejects.toMatchObject({ status: 401, response: { code: 'account_disabled' } });
    expect(w.state()).toEqual(before);
  });
});

describe('Decision 9 — set role', () => {
  it('a masterkey changes another masterkey\'s role: allowed, audited', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: MK2, role: 'masterkey' }]);
    await w.service.setRole(w.as(MK), MK2, UserRole.auditor);
    expect(w.roleOf(MK2)).toBe('auditor');
    expect(w.audits()).toEqual([
      { actorId: MK, actorRole: 'masterkey', action: 'update', entity: 'profile', entityId: MK2, diff: { before: { role: 'masterkey' }, after: { role: 'auditor' } } },
    ]);
  });

  it('a masterkey promoting an auditor to masterkey is forbidden, the role unchanged and nothing written', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'auditor' }]);
    const before = snapshot(w);
    await expect(w.service.setRole(w.as(MK), T, UserRole.masterkey)).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.state()).toEqual(before);
    expect(w.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a standard user granted A with Electricity becomes a super_admin with no grant: the role change and the withdrawal of A audited', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'standard_user', grants: { [A]: ['Electricity'] } }]);
    await w.service.setRole(w.as(MK), T, UserRole.super_admin);
    expect(w.roleOf(T)).toBe('super_admin');
    expect(w.grantsOf(T)).toEqual({});
    expect(w.audits().map((r) => [r.action, r.entity, r.entityId, r.diff])).toEqual([
      ['update', 'profile', T, { before: { role: 'standard_user' }, after: { role: 'super_admin' } }],
      ['delete', 'subsidiary_access', T, { subsidiaryId: A, reason: 'role changed from standard_user to super_admin' }],
    ]);
    // Every grant of the account, whatever its company: the one statement the
    // audit rows are read from (the in-memory stub cannot evaluate its WHERE).
    const [strings, ...values] = w.tx.$queryRaw.mock.calls.find(([s]) => s.join('?').includes('DELETE'))!;
    expect(strings.join('?').replace(/\s+/g, ' ').trim()).toBe(
      'DELETE FROM user_subsidiary_access WHERE user_id = ?::uuid AND organisation_id = ?::uuid RETURNING subsidiary_id::text AS "subsidiaryId", kind, categories',
    );
    expect(values).toEqual([T, ORG]);
  });

  it('a super_admin granted A and B becomes an auditor: no grant left, two withdrawals audited', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'super_admin', grants: { [B]: [], [A]: [] } }]);
    await w.service.setRole(w.as(MK), T, UserRole.auditor);
    expect(w.roleOf(T)).toBe('auditor');
    expect(w.grantsOf(T)).toEqual({});
    const withdrawals = w.audits().filter((r) => r.action === 'delete');
    expect(withdrawals.map((r) => (r.diff as { subsidiaryId: string }).subsidiaryId)).toEqual([A, B]);
  });

  it('a super_admin becomes a standard user: the grants are dropped, not carried (they would read differently)', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'super_admin', grants: { [A]: [] } }]);
    await w.service.setRole(w.as(MK), T, UserRole.standard_user);
    expect(w.roleOf(T)).toBe('standard_user');
    expect(w.grantsOf(T)).toEqual({});
    expect(w.audits().filter((r) => r.action === 'delete')).toHaveLength(1);
  });

  it('an auditor becomes a super_admin: starts with no grant, only the role change audited', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'auditor' }]);
    await w.service.setRole(w.as(MK), T, UserRole.super_admin);
    expect(w.roleOf(T)).toBe('super_admin');
    expect(w.grantsOf(T)).toEqual({});
    expect(w.audits().map((r) => r.action)).toEqual(['update']);
  });

  it('the same role again writes nothing', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'super_admin', grants: { [A]: [] } }]);
    const before = snapshot(w);
    await w.service.setRole(w.as(MK), T, UserRole.super_admin);
    expect(w.state()).toEqual(before);
  });

  it('a profile of another organisation answers user_not_found, nothing written', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'auditor', organisationId: OTHER_ORG }]);
    const before = snapshot(w);
    await expect(w.service.setRole(w.as(MK), T, UserRole.super_admin)).rejects.toMatchObject({ response: { code: 'user_not_found' } });
    expect(w.tx.profile.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: T, organisationId: ORG } }));
    expect(w.state()).toEqual(before);
  });

  it('a masterkey demoted to super_admin between authentication and the lock changes no role, nothing written', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'auditor' }]);
    const actor = w.as(MK);
    w.meanwhile((s) => { s.profiles[0].role = 'super_admin'; });
    const before = snapshot(w);
    await expect(w.service.setRole(actor, T, UserRole.super_admin)).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.state()).toEqual(before);
  });
});

describe('Decision 9 — disable and enable', () => {
  it('a masterkey disables and re-enables another masterkey', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: MK2, role: 'masterkey' }]);
    await expect(w.service.disableMember(w.as(MK), MK2)).resolves.toEqual({ changed: true });
    await expect(w.service.enableMember(w.as(MK), MK2)).resolves.toEqual({ changed: true });
    expect(w.audits().map((r) => [r.action, r.entityId])).toEqual([['disable', MK2], ['enable', MK2]]);
  });

  it('a masterkey demoted to auditor between authentication and the lock disables nobody, nothing written', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'standard_user' }]);
    const actor = w.as(MK);
    w.meanwhile((s) => { s.profiles[0].role = 'auditor'; });
    const before = snapshot(w);
    await expect(w.service.disableMember(actor, T)).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.state()).toEqual(before);
  });
});

describe('Decision 9 — re-sending an invitation is inviting again', () => {
  function pending(w: ReturnType<typeof world>, profileId: string) {
    w.meanwhile((s) => { s.invitations.push({ profileId, status: 'revoked', language: 'en', invitedBy: null }); });
  }

  it('a super_admin re-sends a standard user\'s invitation; a masterkey may not (it does not invite standard users)', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: SA, role: 'super_admin', grants: { [A]: [] } }, { id: T, role: 'standard_user', grants: { [A]: [] } }]);
    pending(w, T);
    await expect(w.service.reopenInvitation(w.as(MK), T)).rejects.toBeInstanceOf(ForbiddenException);
    await w.service.reopenInvitation(w.as(SA), T);
    expect(w.state().invitations[0].status).toBe('pending');
  });

  it('a super_admin may not re-send a super_admin\'s or an auditor\'s invitation', async () => {
    const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }, { id: T, role: 'super_admin', grants: { [A]: [] } }, { id: 'aud', role: 'auditor' }]);
    pending(w, T);
    pending(w, 'aud');
    const before = snapshot(w);
    await expect(w.service.reopenInvitation(w.as(SA), T)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.service.reopenInvitation(w.as(SA), 'aud')).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.state()).toEqual(before);
  });

  it('a super_admin may not re-send the invitation of a standard user granted only outside its companies (user_not_found); one with no grant it may', async () => {
    const w = world([
      { id: SA, role: 'super_admin', grants: { [A]: [] } },
      { id: T, role: 'standard_user', grants: { [C]: [] } },
      { id: 'none', role: 'standard_user' },
    ]);
    pending(w, T);
    pending(w, 'none');
    const before = snapshot(w);
    await expect(w.service.reopenInvitation(w.as(SA), T)).rejects.toMatchObject({ response: { code: 'user_not_found' } });
    expect(w.state()).toEqual(before);
    await w.service.reopenInvitation(w.as(SA), 'none');
    expect(w.state().invitations.find((i) => i.profileId === 'none')?.status).toBe('pending');
  });
});

describe('Decision 9 — replace access', () => {
  const grant = (subsidiaryId: string, categories: string[] = []): UserAccessGrantDTO => ({ subsidiaryId, categories: categories as Category[] });

  it('a company ticked associate after the check: TA020 answers subsidiary_not_assignable, never a 500 (inc26-group-tree)', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'super_admin', grants: { [A]: [] } }]);
    w.tx.userSubsidiaryAccess.createMany.mockRejectedValueOnce(new Prisma.PrismaClientUnknownRequestError(
      'Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "TA020", message: "subsidiary_not_assignable: subsidiary x (a associate company) cannot be assigned to a user", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
      { clientVersion: 'test' },
    ));
    await expect(w.service.replaceSubsidiaryAccess(w.as(MK), T, [grant(A), grant(B)]))
      .rejects.toMatchObject({ status: 409, response: { code: 'subsidiary_not_assignable' } });
  });

  it('a masterkey adds C to a super_admin holding A and B: A, B and C held, one audit row for the added grant', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'super_admin', grants: { [A]: [], [B]: [] } }]);
    await w.service.replaceSubsidiaryAccess(w.as(MK), T, [grant(A), grant(B), grant(C)]);
    expect(w.grantsOf(T)).toEqual({ [A]: [], [B]: [], [C]: [] });
    expect(w.audits().map((r) => [r.action, r.entity, r.entityId, r.diff])).toEqual([['create', 'subsidiary_access', T, { subsidiaryId: C }]]);
  });

  it('a masterkey sending categories for a super_admin is refused with access_role_mismatch, no grant stored', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'super_admin', grants: { [A]: [] } }]);
    const before = snapshot(w);
    await expect(w.service.replaceSubsidiaryAccess(w.as(MK), T, [grant(A), grant(B, ['Electricity'])]))
      .rejects.toMatchObject({ status: 409, response: { code: 'access_role_mismatch' } });
    expect(w.state()).toEqual(before);
  });

  it('a masterkey may not set a standard user\'s company or categories (ruling R3): forbidden, nothing written', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'standard_user', grants: { [A]: ['Electricity'] } }]);
    const before = snapshot(w);
    await expect(w.service.replaceSubsidiaryAccess(w.as(MK), T, [grant(B, ['Fuel'])])).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.service.replaceSubsidiaryAccess(w.as(MK), T, [])).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.state()).toEqual(before);
  });

  it('a super_admin setting another super_admin\'s companies answers user_not_found (an account it does not administer), nothing written', async () => {
    const w = world([{ id: SAB, role: 'super_admin', grants: { [A]: [], [B]: [] } }, { id: T, role: 'super_admin', grants: { [A]: [] } }]);
    const before = snapshot(w);
    await expect(w.service.replaceSubsidiaryAccess(w.as(SAB), T, [grant(A), grant(B)])).rejects.toMatchObject({ response: { code: 'user_not_found' } });
    expect(w.state()).toEqual(before);
  });

  it.each(['auditor', 'masterkey'] as const)(
    'a super_admin acting on a(n) %s answers user_not_found, never revealing the role — with or without access asked; nothing written',
    async (role) => {
      const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }, { id: T, role }]);
      const before = snapshot(w);
      await expect(w.service.replaceSubsidiaryAccess(w.as(SA), T, [grant(A)])).rejects.toMatchObject({ response: { code: 'user_not_found' } });
      await expect(w.service.replaceSubsidiaryAccess(w.as(SA), T, [])).rejects.toMatchObject({ response: { code: 'user_not_found' } });
      expect(w.state()).toEqual(before);
    },
  );

  it.each([
    [MK, 'auditor'],
    [MK, 'masterkey'],
  ] as const)('%s granting a company to a(n) %s is access_role_mismatch, nothing stored; an empty list changes nothing', async (actor, role) => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: SA, role: 'super_admin', grants: { [A]: [] } }, { id: T, role }]);
    const before = snapshot(w);
    await expect(w.service.replaceSubsidiaryAccess(w.as(actor), T, [grant(A)])).rejects.toMatchObject({ response: { code: 'access_role_mismatch' } });
    await w.service.replaceSubsidiaryAccess(w.as(actor), T, []);
    expect(w.state()).toEqual(before);
  });

  it('a super_admin\'s empty replace on a standard user granted only outside its companies answers user_not_found, writing nothing (owner\'s review P1)', async () => {
    const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }, { id: T, role: 'standard_user', grants: { [C]: ['Fuel'] } }]);
    const before = snapshot(w);
    await expect(w.service.replaceSubsidiaryAccess(w.as(SA), T, [])).rejects.toMatchObject({ response: { code: 'user_not_found' } });
    expect(w.state()).toEqual(before);
  });

  it('a super_admin withdrawing its own last visible grant of a carried-over account is allowed (the grant was in scope)', async () => {
    const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }, { id: T, role: 'standard_user', grants: { [A]: ['Fuel'], [C]: ['Fuel'] } }]);
    await w.service.replaceSubsidiaryAccess(w.as(SA), T, []);
    expect(w.grantsOf(T)).toEqual({ [C]: ['Fuel'] });
  });

  it('categories changed from Electricity to Electricity and Fuel: one update row holding both lists, sorted', async () => {
    const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }, { id: T, role: 'standard_user', grants: { [A]: ['Electricity'] } }]);
    await w.service.replaceSubsidiaryAccess(w.as(SA), T, [grant(A, ['Fuel', 'Electricity'])]);
    expect(w.grantsOf(T)).toEqual({ [A]: ['Electricity', 'Fuel'] });
    expect(w.audits()).toEqual([{
      actorId: SA, actorRole: 'super_admin', action: 'update', entity: 'subsidiary_access', entityId: T,
      diff: { subsidiaryId: A, before: { categories: ['Electricity'] }, after: { categories: ['Electricity', 'Fuel'] } },
    }]);
  });

  it('saved unchanged — the same categories in another order, repeated — writes nothing and audits nothing', async () => {
    const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }, { id: T, role: 'standard_user', grants: { [A]: ['Electricity', 'Fuel'] } }]);
    const before = snapshot(w);
    await w.service.replaceSubsidiaryAccess(w.as(SA), T, [grant(A, ['Fuel', 'Electricity', 'Fuel'])]);
    expect(w.state()).toEqual(before);
    expect(w.tx.userSubsidiaryAccess.update).not.toHaveBeenCalled();
    expect(w.tx.userSubsidiaryAccess.createMany).not.toHaveBeenCalled();
    expect(w.tx.userSubsidiaryAccess.deleteMany).not.toHaveBeenCalled();
  });

  it('a masterkey saving a super_admin\'s companies unchanged audits nothing', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'super_admin', grants: { [A]: [], [B]: [] } }]);
    const before = snapshot(w);
    await w.service.replaceSubsidiaryAccess(w.as(MK), T, [grant(B), grant(A)]);
    expect(w.state()).toEqual(before);
  });

  it('an unknown category ("Steam") is invalid, the grants unchanged', async () => {
    const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }, { id: T, role: 'standard_user', grants: { [A]: ['Electricity'] } }]);
    const before = snapshot(w);
    await expect(w.service.replaceSubsidiaryAccess(w.as(SA), T, [grant(A, ['Electricity', 'Steam'])])).rejects.toBeInstanceOf(BadRequestException);
    expect(w.state()).toEqual(before);
  });

  it('a company named twice is invalid, the grants unchanged', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'super_admin', grants: { [A]: [] } }]);
    const before = snapshot(w);
    await expect(w.service.replaceSubsidiaryAccess(w.as(MK), T, [grant(B), grant(B.toUpperCase())])).rejects.toBeInstanceOf(BadRequestException);
    expect(w.state()).toEqual(before);
  });

  it('a standard user\'s grant with no category is stored with an empty list', async () => {
    const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }, { id: T, role: 'standard_user' }]);
    await w.service.replaceSubsidiaryAccess(w.as(SA), T, [grant(A)]);
    expect(w.grantsOf(T)).toEqual({ [A]: [] });
    expect(w.audits().map((r) => r.diff)).toEqual([{ subsidiaryId: A, categories: [] }]);
  });

  describe('a scoped replace is a diff inside the actor\'s grants', () => {
    const scoped = () => world([
      { id: SA, role: 'super_admin', grants: { [A]: [] } },
      { id: T, role: 'standard_user', grants: { [A]: ['Electricity'], [C]: ['Fuel'] } },
    ]);

    it('a target granted A and C, edited by an actor granted A, keeps C', async () => {
      const w = scoped();
      await w.service.replaceSubsidiaryAccess(w.as(SA), T, [grant(A, ['Natural Gas'])]);
      expect(w.grantsOf(T)).toEqual({ [A]: ['Natural Gas'], [C]: ['Fuel'] });
      expect(w.audits()).toHaveLength(1);
      expect(JSON.stringify(w.audits())).not.toContain(C);
    });

    it('A unticked: A withdrawn, C unchanged, one audit row for the withdrawal', async () => {
      const w = scoped();
      await w.service.replaceSubsidiaryAccess(w.as(SA), T, []);
      expect(w.grantsOf(T)).toEqual({ [C]: ['Fuel'] });
      expect(w.audits().map((r) => [r.action, r.entity, r.entityId, r.diff])).toEqual([['delete', 'subsidiary_access', T, { subsidiaryId: A }]]);
      expect(w.tx.userSubsidiaryAccess.deleteMany).toHaveBeenCalledWith({ where: { userId: T, organisationId: ORG, subsidiaryId: { in: [A] } } });
    });

    it('the actor naming C is refused as an unknown company, nothing changed', async () => {
      const w = scoped();
      const before = snapshot(w);
      await expect(w.service.replaceSubsidiaryAccess(w.as(SA), T, [grant(A, ['Electricity']), grant(C, ['Fuel'])]))
        .rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
      await expect(w.service.replaceSubsidiaryAccess(w.as(SA), T, [grant(C, ['Waste'])]))
        .rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
      expect(w.state()).toEqual(before);
    });

    it('a super_admin whose grant for A was withdrawn since authentication can neither name A nor withdraw it', async () => {
      const w = scoped();
      const actor = w.as(SA);
      w.meanwhile((s) => { s.grants = s.grants.filter((g) => g.userId !== SA); });
      const before = snapshot(w);
      await expect(w.service.replaceSubsidiaryAccess(actor, T, [grant(A, ['Waste'])])).rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
      // Nothing in scope any more: the account is one it does not administer.
      await expect(w.service.replaceSubsidiaryAccess(actor, T, [])).rejects.toMatchObject({ response: { code: 'user_not_found' } });
      expect(w.state()).toEqual(before);
    });

    it('a super_admin demoted to standard user since authentication sets nobody\'s access', async () => {
      const w = scoped();
      const actor = w.as(SA);
      w.meanwhile((s) => { s.profiles.find((p) => p.id === SA)!.role = 'standard_user'; });
      const before = snapshot(w);
      await expect(w.service.replaceSubsidiaryAccess(actor, T, [])).rejects.toBeInstanceOf(ForbiddenException);
      expect(w.state()).toEqual(before);
    });

    it('a target of another organisation answers user_not_found', async () => {
      const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }, { id: T, role: 'standard_user', organisationId: OTHER_ORG }]);
      await expect(w.service.replaceSubsidiaryAccess(w.as(SA), T, [grant(A)])).rejects.toMatchObject({ response: { code: 'user_not_found' } });
      expect(w.audits()).toEqual([]);
    });
  });

  describe('a standard user is assigned one company (ruling R6)', () => {
    it('a second company for an assigned user, added by a super_admin who cannot see the first: refused, A alone held', async () => {
      const w = world([{ id: SB, role: 'super_admin', grants: { [B]: [] } }, { id: T, role: 'standard_user', grants: { [A]: ['Electricity'] } }]);
      const before = snapshot(w);
      await expect(w.service.replaceSubsidiaryAccess(w.as(SB), T, [grant(B, ['Fuel'])]))
        .rejects.toMatchObject({ status: 409, response: { code: 'standard_user_single_company' } });
      expect(w.state()).toEqual(before);
      expect(w.grantsOf(T)).toEqual({ [A]: ['Electricity'] });
    });

    it('a second company added by a super_admin who sees both: refused, A alone held', async () => {
      const w = world([{ id: SAB, role: 'super_admin', grants: { [A]: [], [B]: [] } }, { id: T, role: 'standard_user', grants: { [A]: ['Electricity'] } }]);
      const before = snapshot(w);
      await expect(w.service.replaceSubsidiaryAccess(w.as(SAB), T, [grant(A, ['Electricity']), grant(B)]))
        .rejects.toMatchObject({ response: { code: 'standard_user_single_company' } });
      expect(w.state()).toEqual(before);
    });

    it('moving a user from A to B: B alone held, the withdrawal of A and the grant of B audited', async () => {
      const w = world([{ id: SAB, role: 'super_admin', grants: { [A]: [], [B]: [] } }, { id: T, role: 'standard_user', grants: { [A]: ['Electricity'] } }]);
      await w.service.replaceSubsidiaryAccess(w.as(SAB), T, [grant(B, ['Water'])]);
      expect(w.grantsOf(T)).toEqual({ [B]: ['Water'] });
      expect(w.audits().map((r) => [r.action, r.diff])).toEqual([
        ['delete', { subsidiaryId: A }],
        ['create', { subsidiaryId: B, categories: ['Water'] }],
      ]);
    });

    it('a carried-over account with A and C keeps both when a super_admin granted A changes A\'s categories', async () => {
      const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }, { id: T, role: 'standard_user', grants: { [A]: ['Electricity'], [C]: ['Fuel'] } }]);
      await w.service.replaceSubsidiaryAccess(w.as(SA), T, [grant(A, ['Waste'])]);
      expect(w.grantsOf(T)).toEqual({ [A]: ['Waste'], [C]: ['Fuel'] });
    });

    it('a carried-over account with A and C can be edited down by an actor who sees both', async () => {
      const w = world([{ id: 'sa-ac', role: 'super_admin', grants: { [A]: [], [C]: [] } }, { id: T, role: 'standard_user', grants: { [A]: [], [C]: [] } }]);
      await w.service.replaceSubsidiaryAccess(w.as('sa-ac'), T, [grant(C, ['Fuel'])]);
      expect(w.grantsOf(T)).toEqual({ [C]: ['Fuel'] });
    });

    it.each([
      ['granted B only', { [B]: [] }, [B]],
      ['granted A and B', { [A]: [], [B]: [] }, [A, B]],
    ] as const)('a carried-over account with A and C gets no third company from a super_admin %s: refused, grants unchanged', async (_label, actorGrants, sent) => {
      const w = world([{ id: 'sa-x', role: 'super_admin', grants: actorGrants }, { id: T, role: 'standard_user', grants: { [A]: [], [C]: [] } }]);
      const before = snapshot(w);
      await expect(w.service.replaceSubsidiaryAccess(w.as('sa-x'), T, sent.map((id) => grant(id))))
        .rejects.toMatchObject({ response: { code: 'standard_user_single_company' } });
      expect(w.state()).toEqual(before);
    });

    it('a super_admin target holds any number of companies', async () => {
      const w = world([{ id: MK, role: 'masterkey' }, { id: T, role: 'super_admin' }]);
      await w.service.replaceSubsidiaryAccess(w.as(MK), T, [grant(A), grant(B), grant(C)]);
      expect(Object.keys(w.grantsOf(T))).toEqual([A, B, C]);
      expect(w.audits()).toHaveLength(3);
    });
  });
});

/**
 * Self-service registration's write, DB-free: what is written, in one
 * transaction, and what the audit rows hold. The grants, the cooldown claim
 * and the unique index are proven on PostgreSQL in
 * test/int/registration.int.spec.ts.
 */
describe('AccessAdminService.registerOrganisation — self-service registration', () => {
  const INPUT = {
    email: '  Ada@Example.test ',
    fullName: ' Ada Yilmaz ',
    jobTitle: ' Sustainability Manager ',
    companyName: ' Example Holding ',
    language: 'tr' as const,
    consentVersion: 'placeholder-1',
  };

  function registrationSetup(options: { taken?: boolean; failAt?: 'organisation' | 'subsidiary' | 'profile' | 'invitation' | 'consent' | 'audit' } = {}) {
    const writes: { model: string; data: Record<string, unknown> }[] = [];
    const audits: Record<string, unknown>[] = [];
    let committed = false;
    const create = (model: string, result: object = {}) => vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (options.failAt === model) throw new Error(`${model} failed`);
      writes.push({ model, data });
      return result;
    });
    const tx = {
      profile: { findUnique: vi.fn(async () => (options.taken ? { id: 'someone' } : null)), create: create('profile') },
      organisation: { create: create('organisation', { id: ORG }) },
      subsidiary: { create: create('subsidiary', { id: SUB }) },
      invitation: { create: create('invitation') },
      consent: { create: create('consent') },
    };
    const prisma = {
      $transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => {
        const result = await run(tx);
        committed = true;
        return result;
      }),
    };
    const audit = {
      record: vi.fn(),
      recordSystem: vi.fn(async (entry: Record<string, unknown>, writer: unknown) => {
        if (options.failAt === 'audit') throw new Error('audit failed');
        expect(writer).toBe(tx); // in the same transaction as the rows
        audits.push(entry);
      }),
    };
    const service = new AccessAdminService(prisma as unknown as PrismaService, audit as unknown as AuditService);
    return { service, tx, prisma, audit, writes, audits, committed: () => committed };
  }

  it('writes the organisation, its default subsidiary, its first masterkey, the invitation and the consent in one transaction', async () => {
    const { service, tx, prisma, writes } = registrationSetup();
    const result = await service.registerOrganisation(INPUT);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.profile.findUnique).toHaveBeenCalledWith({ where: { email: 'ada@example.test' }, select: { id: true } });
    const byModel = Object.fromEntries(writes.map((w) => [w.model, w.data]));
    expect(byModel.organisation).toEqual({ legalName: 'Example Holding', country: 'TR', geographyCode: 'TR', reportingCurrency: 'TRY' });
    // K1: the company itself, as its one subsidiary — a facility can be added
    // at once; the root of its tree (inc26-group-tree): a controlled holding.
    expect(byModel.subsidiary).toEqual({
      organisationId: ORG,
      legalName: 'Example Holding',
      tradingName: null,
      sector: null,
      geographyCode: 'TR',
      reportingStatus: 'pending',
      includedScopes: [1, 2],
      trackingGranularity: 'subsidiary',
      nodeType: 'holding',
      control: 'controlled',
      parentId: null,
    });
    expect(byModel.profile).toEqual({
      id: result.profileId,
      email: 'ada@example.test',
      fullName: 'Ada Yilmaz',
      jobTitle: 'Sustainability Manager',
      role: UserRole.masterkey,
      language: 'tr',
      organisationId: ORG,
    });
    expect(byModel.invitation).toEqual({ profileId: result.profileId, language: 'tr', invitedBy: null });
    expect(byModel.consent).toEqual({ profileId: result.profileId, kind: 'kvkk_registration', textVersion: 'placeholder-1', language: 'tr' });
    expect(result.organisationId).toBe(ORG);
    expect(writes.map((w) => w.model)).toEqual(['organisation', 'subsidiary', 'profile', 'invitation', 'consent']);
  });

  it('audits the organisation, its subsidiary, the invitation and the consent with no actor — and no name, address, job title or company in any row', async () => {
    const { service, audit, audits } = registrationSetup();
    const { profileId } = await service.registerOrganisation(INPUT);
    expect(audit.record).not.toHaveBeenCalled(); // there is no actor to record as
    expect(audits.map((a) => [a.action, a.entity, a.entityId])).toEqual([
      ['create', 'organisation', ORG],
      ['create', 'subsidiary', SUB],
      ['invite', 'invitation', profileId],
      ['create', 'consent', profileId],
    ]);
    for (const row of audits) {
      expect(row.organisationId).toBe(ORG);
      expect((row.diff as { source: string }).source).toBe('auth:registration');
    }
    expect(audits[1].diff).toMatchObject({ default: true, geographyCode: 'TR' });
    expect(audits[3].diff).toMatchObject({ kind: 'kvkk_registration', textVersion: 'placeholder-1' });
    // Ids are random hex and can spell 'ada' by chance: they are removed
    // before the personal words are looked for.
    const trail = JSON.stringify(audits)
      .toLowerCase()
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');
    for (const personal of ['ada', 'yilmaz', 'example.test', 'sustainability', 'example holding']) {
      expect(trail, personal).not.toContain(personal);
    }
  });

  it('refuses an address that already has a profile, writing nothing (D17)', async () => {
    const { service, writes, audits } = registrationSetup({ taken: true });
    await expect(service.registerOrganisation(INPUT)).rejects.toMatchObject({ response: { code: 'email_unavailable' } });
    expect(writes).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('reads a unique-index race as the same refusal', async () => {
    const { service, tx } = registrationSetup();
    const { Prisma } = await import('@tonyai/db');
    tx.profile.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    await expect(service.registerOrganisation(INPUT)).rejects.toMatchObject({ response: { code: 'email_unavailable' } });
  });

  it.each(['organisation', 'subsidiary', 'profile', 'invitation', 'consent', 'audit'] as const)('a failure at the %s step leaves the transaction uncommitted', async (failAt) => {
    const { service, committed } = registrationSetup({ failAt });
    await expect(service.registerOrganisation(INPUT)).rejects.toThrow(`${failAt} failed`);
    expect(committed()).toBe(false);
  });

  it('refuses a language the product does not speak before the database is touched', async () => {
    const { service, prisma } = registrationSetup();
    await expect(service.registerOrganisation({ ...INPUT, language: 'de' as 'en' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('inviteMember — refusals audited and bounded (pre-g5-security-hardening)', () => {
  const NOW = new Date('2026-11-24T10:00:00.000Z');
  /** A transaction client for one invitation: the actor is an active masterkey of ORG. */
  function invitation(options: { refusals?: number; taken?: boolean; insertRace?: boolean } = {}) {
    const audit = { record: vi.fn(async () => undefined) };
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => [{ now: NOW }]),
      auditLog: {
        aggregate: vi.fn(async () => ({ _count: options.refusals ?? 0, _min: { createdAt: new Date(NOW.getTime() - 10 * 60_000) } })),
      },
      profile: {
        findUnique: vi.fn(async (args: { where: { id?: string; email?: string } }) =>
          args.where.id === 'actor'
            ? { role: UserRole.masterkey, organisationId: ORG, disabledAt: null, organisation: { offboardedAt: null } }
            : options.taken ? { id: 'someone' } : null),
        create: vi.fn(async () => {
          if (options.insertRace) {
            const { Prisma } = await import('@tonyai/db');
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
          }
          return {};
        }),
      },
      subsidiary: { findMany: vi.fn(async () => []) },
      invitation: { create: vi.fn(async () => ({})) },
      userSubsidiaryAccess: { createMany: vi.fn(async () => ({ count: 0 })) },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
    const service = new AccessAdminService(prisma as unknown as PrismaService, audit as unknown as AuditService);
    return { audit, tx, prisma, service };
  }
  const refusalRows = (audit: { record: ReturnType<typeof vi.fn> }) =>
    audit.record.mock.calls.filter((c) => (c[1] as { action: string }).action === 'invite_refused');

  it('a taken address answers email_unavailable, creates nothing, and audits the refusal without the address', async () => {
    const { audit, tx, service } = invitation({ taken: true });
    await expect(service.inviteMember(user('masterkey'), INVITE)).rejects.toMatchObject({ response: { code: 'email_unavailable' } });
    expect(tx.profile.create).not.toHaveBeenCalled();
    expect(tx.invitation.create).not.toHaveBeenCalled();
    const rows = refusalRows(audit);
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toEqual({ action: 'invite_refused', entity: 'invitation', entityId: null, diff: { reason: 'email_unavailable' } });
    // On the transaction, so it commits with nothing else.
    expect(rows[0][2]).toBe(tx);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(INVITE.email);
  });

  it('a new address is invited as before, with no refusal row', async () => {
    const { audit, tx, service } = invitation();
    await expect(service.inviteMember(user('masterkey'), INVITE)).resolves.toMatchObject({ profileId: expect.any(String) });
    expect(tx.profile.create).toHaveBeenCalledTimes(1);
    expect(refusalRows(audit)).toHaveLength(0);
  });

  it.each([false, true])('at five refusals within the hour, every invitation is refused 429 before the lookup (taken: %s)', async (taken) => {
    const { audit, tx, service } = invitation({ refusals: 5, taken });
    const refusal = await service.inviteMember(user('masterkey'), INVITE).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ status: 429, response: { code: 'invite_refusals_exhausted' } });
    // The same answer, whatever the address: it was never looked up.
    expect(tx.profile.findUnique.mock.calls.filter((c) => c[0].where.email !== undefined)).toHaveLength(0);
    expect(tx.profile.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    // A retry hint: until the oldest refusal of the hour (ten minutes old) ages out.
    expect((refusal as { retryAfter: number }).retryAfter).toBe(50 * 60);
  });

  it('below the bound, the count is read for this organisation and the last hour on the database clock', async () => {
    const { tx, service } = invitation({ refusals: 4 });
    await service.inviteMember(user('masterkey'), INVITE);
    expect((tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray])[0].join('?')).toBe('SELECT now() AS now');
    expect(tx.auditLog.aggregate).toHaveBeenCalledWith({
      where: { organisationId: ORG, action: 'invite_refused', createdAt: { gt: new Date(NOW.getTime() - 3_600_000) } },
      _count: true,
      _min: { createdAt: true },
    });
  });

  it('an insert that loses the race when another request used the last refusal meanwhile answers the bound, and writes nothing (Codex review)', async () => {
    const { audit, tx, service } = invitation({ insertRace: true });
    tx.auditLog.aggregate
      .mockResolvedValueOnce({ _count: 4, _min: { createdAt: new Date(NOW.getTime() - 10 * 60_000) } })
      .mockResolvedValueOnce({ _count: 5, _min: { createdAt: new Date(NOW.getTime() - 10 * 60_000) } });
    await expect(service.inviteMember(user('masterkey'), INVITE)).rejects.toMatchObject({ status: 429, response: { code: 'invite_refusals_exhausted' } });
    expect(refusalRows(audit)).toHaveLength(0);
  });

  it('an insert that loses the race for the address is the same refusal, audited in its own transaction', async () => {
    const { audit, prisma, service } = invitation({ insertRace: true });
    await expect(service.inviteMember(user('masterkey'), INVITE)).rejects.toMatchObject({ response: { code: 'email_unavailable' } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(refusalRows(audit)).toHaveLength(1);
  });
});

describe("a child company's creator (inc26-group-tree, design D5)", () => {
  /** What `SubsidiariesService.create` does around its insert, in one transaction. */
  async function createChild(w: ReturnType<typeof world>, actor: RequestUser, parentId: string, childId: string) {
    return w.prisma.$transaction(async (tx) => {
      await w.service.lockChildCompanyCreator(tx as never, actor, parentId);
      await w.service.grantChildCompanyCreator(tx as never, actor, childId);
    });
  }

  it('grants a super_admin the child it created under a granted company, with its audit row — and nobody else', async () => {
    const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }, { id: SAB, role: 'super_admin', grants: { [A]: [], [B]: [] } }]);
    await createChild(w, w.as(SA), A, C);
    expect(w.grantsOf(SA)).toEqual({ [A]: [], [C]: [] });
    expect(w.grantsOf(SAB)).toEqual({ [A]: [], [B]: [] });
    expect(w.audits()).toEqual([
      { actorId: SA, actorRole: 'super_admin', action: 'create', entity: 'subsidiary_access', entityId: SA, diff: { subsidiaryId: C } },
    ]);
  });

  it('answers a parent outside its grants as unknown, granting nothing', async () => {
    const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }]);
    const before = snapshot(w);
    await expect(createChild(w, w.as(SA), B, C)).rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
    expect(w.state()).toEqual(before);
  });

  it('reads the grants as they stand now: a parent withdrawn since authentication answers as unknown', async () => {
    const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }]);
    const actor = w.as(SA);
    w.meanwhile((s) => { s.grants = s.grants.filter((g) => g.userId !== SA); });
    await expect(createChild(w, actor, A, C)).rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
  });

  it('refuses a role without the power, and grants a masterkey nothing (it reads the whole organisation)', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: 'su', role: 'standard_user', grants: { [A]: [] } }]);
    await expect(createChild(w, w.as('su'), A, C)).rejects.toBeInstanceOf(ForbiddenException);
    await createChild(w, w.as(MK), A, C);
    expect(w.grantsOf(MK)).toEqual({});
    expect(w.audits()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// inc26-central-reporter-onboarding (tasks 3.2–3.5, 3.7): the grant is rows of
// `user_subsidiary_access` with kind `central_reporter`; only a masterkey
// writes it, and every other access write leaves it exactly as it was.
// ---------------------------------------------------------------------------

describe('central reporting — ordinary access writes act on assigned rows only (task 3.2)', () => {
  const R = 'reporter'; // main company C, a grant for A and B
  const grantRows = { [A]: ['Mobile Combustion'], [B]: ['Mobile Combustion'] };
  const reporterWorld = (extra: Seed[] = []) => world([
    { id: MK, role: 'masterkey' },
    { id: SA, role: 'super_admin', grants: { [A]: [] } },
    { id: 'sa-c', role: 'super_admin', grants: { [C]: [] } },
    { id: 'sa-bc', role: 'super_admin', grants: { [B]: [], [C]: [] } },
    { id: 'sa-ac', role: 'super_admin', grants: { [A]: [], [C]: [] } },
    { id: R, role: 'standard_user', grants: { [C]: ['Water'] }, reports: grantRows },
    ...extra,
  ]);
  const grant = (subsidiaryId: string, categories: string[] = []): UserAccessGrantDTO => ({ subsidiaryId, categories: categories as Category[] });

  it("an earlier client's body changes the main company's categories and leaves the grant as it was", async () => {
    const w = reporterWorld();
    await w.service.replaceSubsidiaryAccess(w.as('sa-c'), R, [grant(C, ['Water', 'Electricity'])]);
    expect(w.rowsOf(R)).toEqual({
      [A]: 'central_reporter:Mobile Combustion',
      [B]: 'central_reporter:Mobile Combustion',
      [C]: 'assigned:Electricity,Water',
    });
  });

  it('a super_admin of an owning company saving the same access again (no assigned row it sees) writes nothing', async () => {
    const w = reporterWorld();
    const before = snapshot(w);
    await w.service.replaceSubsidiaryAccess(w.as(SA), R, []);
    expect(w.state()).toEqual(before);
  });

  it('naming the grant company as an assignment is refused as an added second company, naming no company', async () => {
    const w = reporterWorld();
    const before = snapshot(w);
    const refusal = await w.service.replaceSubsidiaryAccess(w.as(SA), R, [grant(A, ['Mobile Combustion'])]).catch((e) => e);
    expect(refusal.response).toMatchObject({ code: 'standard_user_single_company' });
    expect(refusal.response.params).toBeUndefined();
    expect(w.state()).toEqual(before);
  });

  it('moving the main company to a company outside the grant is allowed, the grant companies not counted', async () => {
    const w = world([
      { id: 'sa-bc', role: 'super_admin', grants: { [B]: [], [C]: [] } },
      { id: R, role: 'standard_user', grants: { [C]: ['Water'] }, reports: { [A]: ['Mobile Combustion'] } },
    ]);
    await w.service.replaceSubsidiaryAccess(w.as('sa-bc'), R, [grant(B, ['Water'])]);
    expect(w.rowsOf(R)).toEqual({ [A]: 'central_reporter:Mobile Combustion', [B]: 'assigned:Water' });
  });

  it('a central reporter keeps a main company (task 3.4): withdrawn, or moved into the grant, is refused', async () => {
    const w = reporterWorld();
    const before = snapshot(w);
    await expect(w.service.replaceSubsidiaryAccess(w.as('sa-c'), R, [])).rejects.toMatchObject({ response: { code: 'central_reporter_needs_main_entity' } });
    await expect(w.service.replaceSubsidiaryAccess(w.as('sa-ac'), R, [grant(A, ['Water'])]))
      .rejects.toMatchObject({ response: { code: 'central_reporter_needs_main_entity' } });
    expect(w.state()).toEqual(before);
  });
});

describe('central reporting — single entry in the invitation and the access change (task 3.3)', () => {
  const R = 'acct-r7'; // an id no sentence can contain
  const U = 'own-user';
  const grant = (subsidiaryId: string, categories: string[] = []): UserAccessGrantDTO => ({ subsidiaryId, categories: categories as Category[] });
  const base = () => world([
    { id: SA, role: 'super_admin', grants: { [A]: [] } },
    { id: R, role: 'standard_user', grants: { [C]: ['Water'] }, reports: { [A]: ['Mobile Combustion'] } },
    { id: U, role: 'standard_user' },
  ]);

  it('an invitation opening a central reporter\'s category: refused, side central_reporter, nothing created', async () => {
    const w = base();
    const before = snapshot(w);
    const refusal = await w.service.inviteMember(w.as(SA), {
      email: 'new@tonyai.test', fullName: 'New', role: UserRole.standard_user, language: 'en',
      access: [grant(A, ['Electricity', 'Mobile Combustion'])],
    }).catch((e) => e);
    expect(refusal.response).toMatchObject({
      code: 'single_entry_conflict',
      params: { side: 'central_reporter' },
      conflicts: [{ subsidiaryId: A, categories: ['Mobile Combustion'] }],
    });
    expect(JSON.stringify(refusal.response)).not.toContain(R);
    expect(w.state()).toEqual(before);
  });

  it('an access change opening it: refused, the user unchanged; a different category is saved', async () => {
    const w = base();
    const before = snapshot(w);
    await expect(w.service.replaceSubsidiaryAccess(w.as(SA), U, [grant(A, ['Mobile Combustion'])]))
      .rejects.toMatchObject({ response: { code: 'single_entry_conflict', params: { side: 'central_reporter' } } });
    expect(w.state()).toEqual(before);
    await w.service.replaceSubsidiaryAccess(w.as(SA), U, [grant(A, ['Electricity'])]);
    expect(w.rowsOf(U)).toEqual({ [A]: 'assigned:Electricity' });
  });

  it('lists only the companies the reader may read', () => {
    const conflicts = [{ subsidiaryId: A, categories: ['Fuel' as Category] }, { subsidiaryId: C, categories: ['Water' as Category] }];
    expect(conflictsVisibleTo(conflicts, new Set([A]))).toEqual([{ subsidiaryId: A, categories: ['Fuel'] }]);
    expect(conflictsVisibleTo(conflicts, null)).toEqual(conflicts);
  });
});

describe('central reporting — the masterkey gives, changes and withdraws the grant (task 3.5)', () => {
  const R = 'reporter';
  const MC = ['Mobile Combustion'] as Category[];
  const base = (extra: Seed[] = []) => world([
    { id: MK, role: 'masterkey' },
    { id: SA, role: 'super_admin', grants: { [A]: [], [C]: [] } },
    { id: R, role: 'standard_user', grants: { [C]: ['Water'] } },
    ...extra,
  ]);

  it('gives a grant for two companies beside the main company; one audit row each, kind and categories, no address or name', async () => {
    const w = base();
    await w.service.setCentralReporterGrant(w.as(MK), R, { subsidiaryIds: [B, A], categories: ['Natural Gas', 'Mobile Combustion'] as Category[] });
    expect(w.rowsOf(R)).toEqual({
      [A]: 'central_reporter:Mobile Combustion,Natural Gas',
      [B]: 'central_reporter:Mobile Combustion,Natural Gas',
      [C]: 'assigned:Water',
    });
    const rows = w.audits().filter((a) => a.entity === 'subsidiary_access');
    expect(rows).toEqual([A, B].map((subsidiaryId) => ({
      actorId: MK, actorRole: 'masterkey', action: 'create', entity: 'subsidiary_access', entityId: R,
      diff: { subsidiaryId, kind: 'central_reporter', categories: ['Mobile Combustion', 'Natural Gas'] },
    })));
    expect(JSON.stringify(w.audits())).not.toMatch(/@tonyai\.test/);
  });

  it('narrows (a company withdrawn, audited with what it held), re-categorises, and withdraws the whole grant with no company', async () => {
    const w = base();
    await w.service.setCentralReporterGrant(w.as(MK), R, { subsidiaryIds: [A, B], categories: MC });
    const auditsBefore = w.audits().length;
    await w.service.setCentralReporterGrant(w.as(MK), R, { subsidiaryIds: [A], categories: ['Electricity'] as Category[] });
    expect(w.rowsOf(R)).toEqual({ [A]: 'central_reporter:Electricity', [C]: 'assigned:Water' });
    expect(w.audits().slice(auditsBefore).map((a) => [a.action, a.diff])).toEqual([
      ['update', { subsidiaryId: A, before: { kind: 'central_reporter', categories: MC }, after: { kind: 'central_reporter', categories: ['Electricity'] } }],
      ['delete', { subsidiaryId: B, kind: 'central_reporter', categories: MC }],
    ]);
    await w.service.setCentralReporterGrant(w.as(MK), R, { subsidiaryIds: [], categories: [] });
    expect(w.rowsOf(R)).toEqual({ [C]: 'assigned:Water' });
    // Saving the same thing again writes nothing.
    const before = snapshot(w);
    await w.service.setCentralReporterGrant(w.as(MK), R, { subsidiaryIds: [], categories: [] });
    expect(w.state()).toEqual(before);
  });

  it('refuses companies with no category as invalid input, before the database', async () => {
    const w = base();
    await expect(w.service.setCentralReporterGrant(w.as(MK), R, { subsidiaryIds: [A], categories: [] })).rejects.toBeInstanceOf(BadRequestException);
    expect(w.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['super_admin', 'standard_user', 'auditor'] as const)('a %s is forbidden, nothing written', async (role) => {
    const w = base([{ id: 'actor-x', role, grants: role === 'auditor' ? {} : { [A]: [] } }]);
    await expect(w.service.setCentralReporterGrant(w.as('actor-x'), R, { subsidiaryIds: [A], categories: MC })).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('the holder must be a standard user with exactly one main company outside the grant', async () => {
    const w = base([{ id: 'none', role: 'standard_user' }, { id: 'sa-target', role: 'super_admin', grants: { [A]: [] } }]);
    const before = snapshot(w);
    await expect(w.service.setCentralReporterGrant(w.as(MK), 'sa-target', { subsidiaryIds: [B], categories: MC }))
      .rejects.toMatchObject({ response: { code: 'access_role_mismatch' } });
    await expect(w.service.setCentralReporterGrant(w.as(MK), 'none', { subsidiaryIds: [B], categories: MC }))
      .rejects.toMatchObject({ response: { code: 'central_reporter_needs_main_entity' } });
    await expect(w.service.setCentralReporterGrant(w.as(MK), R, { subsidiaryIds: [C], categories: MC }))
      .rejects.toMatchObject({ response: { code: 'central_reporter_needs_main_entity' } });
    expect(w.state()).toEqual(before);
  });

  it('names only companies of the organisation that hold records', async () => {
    const w = base();
    const before = snapshot(w);
    await expect(w.service.setCentralReporterGrant(w.as(MK), R, { subsidiaryIds: [A, ASSOCIATE], categories: MC }))
      .rejects.toMatchObject({ response: { code: 'subsidiary_not_assignable' } });
    await expect(w.service.setCentralReporterGrant(w.as(MK), R, { subsidiaryIds: [SECTOR_GROUP], categories: MC }))
      .rejects.toMatchObject({ response: { code: 'subsidiary_not_assignable' } });
    await expect(w.service.setCentralReporterGrant(w.as(MK), R, { subsidiaryIds: [X], categories: MC }))
      .rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
    expect(w.state()).toEqual(before);
  });

  it("refuses a grant where companies' own users hold the categories, listing each company, naming no user", async () => {
    const w = base([
      { id: 'own-a', role: 'standard_user', grants: { [A]: ['Mobile Combustion'] } },
      { id: 'own-b', role: 'standard_user', grants: { [B]: ['Mobile Combustion', 'Electricity'] } },
    ]);
    const before = snapshot(w);
    const refusal = await w.service.setCentralReporterGrant(w.as(MK), R, {
      subsidiaryIds: [A, B], categories: ['Electricity', 'Mobile Combustion'] as Category[],
    }).catch((e) => e);
    expect(refusal.response).toMatchObject({
      code: 'single_entry_conflict',
      params: { side: 'company_users' },
      conflicts: [
        { subsidiaryId: A, categories: ['Mobile Combustion'] },
        { subsidiaryId: B, categories: ['Electricity', 'Mobile Combustion'] },
      ],
    });
    expect(JSON.stringify(refusal.response)).not.toMatch(/own-a|own-b/);
    expect(w.state()).toEqual(before);
  });

  describe('a carried-over account is converted by the grant (C7)', () => {
    const carried = () => world([
      { id: MK, role: 'masterkey' },
      { id: R, role: 'standard_user', grants: { [A]: ['Electricity'], [B]: ['Electricity'], [C]: ['Mobile Combustion'] } },
    ]);

    it('the named companies become the grant\'s with its categories; the one left keeps its own; audited before and after', async () => {
      const w = carried();
      await w.service.setCentralReporterGrant(w.as(MK), R, { subsidiaryIds: [B, C], categories: MC });
      expect(w.rowsOf(R)).toEqual({
        [A]: 'assigned:Electricity',
        [B]: 'central_reporter:Mobile Combustion',
        [C]: 'central_reporter:Mobile Combustion',
      });
      expect(w.audits().map((a) => [a.action, a.diff])).toEqual([
        ['update', { subsidiaryId: B, before: { kind: 'assigned', categories: ['Electricity'] }, after: { kind: 'central_reporter', categories: MC } }],
        ['update', { subsidiaryId: C, before: { kind: 'assigned', categories: MC }, after: { kind: 'central_reporter', categories: MC } }],
      ]);
    });

    it('a grant naming one of three leaves two assigned: refused, nothing changed', async () => {
      const w = carried();
      const before = snapshot(w);
      await expect(w.service.setCentralReporterGrant(w.as(MK), R, { subsidiaryIds: [C], categories: MC }))
        .rejects.toMatchObject({ response: { code: 'central_reporter_needs_main_entity' } });
      expect(w.state()).toEqual(before);
    });
  });
});

describe('central reporting — withdrawals by other paths (task 3.7)', () => {
  it("a role change withdraws a grant's rows, each audited with its kind and the categories it held", async () => {
    const w = world([
      { id: MK, role: 'masterkey' },
      { id: 'reporter', role: 'standard_user', grants: { [C]: ['Water'] }, reports: { [A]: ['Mobile Combustion'] } },
    ]);
    await w.service.setRole(w.as(MK), 'reporter', UserRole.auditor);
    expect(w.grantsOf('reporter')).toEqual({});
    const withdrawals = w.audits().filter((a) => a.entity === 'subsidiary_access').map((a) => a.diff);
    expect(withdrawals).toEqual([
      { subsidiaryId: A, reason: 'role changed from standard_user to auditor', kind: 'central_reporter', categories: ['Mobile Combustion'] },
      { subsidiaryId: C, reason: 'role changed from standard_user to auditor' },
    ]);
  });
});

describe('central reporting — the review passes of 2026-11-26 (qa-auditor A5, A11, A18/A20, A23)', () => {
  const grantRow = (subsidiaryId: string, categories: string[] = []): UserAccessGrantDTO => ({ subsidiaryId, categories: categories as Category[] });

  it("a re-categorisation alone that opens a reporter's category is refused with its conflict listed", async () => {
    const w = world([
      { id: SA, role: 'super_admin', grants: { [A]: [] } },
      { id: 'rep', role: 'standard_user', grants: { [C]: ['Water'] }, reports: { [A]: ['Mobile Combustion'] } },
      { id: 'own', role: 'standard_user', grants: { [A]: ['Electricity'] } },
    ]);
    const refusal = await w.service.replaceSubsidiaryAccess(w.as(SA), 'own', [grantRow(A, ['Electricity', 'Mobile Combustion'])]).catch((e) => e);
    expect(refusal.response).toMatchObject({ code: 'single_entry_conflict', conflicts: [{ subsidiaryId: A, categories: ['Mobile Combustion'] }] });
  });

  it('saving the same grant again writes nothing — no update, no audit row', async () => {
    const w = world([{ id: MK, role: 'masterkey' }, { id: 'rep', role: 'standard_user', grants: { [C]: ['Water'] }, reports: { [A]: ['Fuel'] } }]);
    const before = snapshot(w);
    await w.service.setCentralReporterGrant(w.as(MK), 'rep', { subsidiaryIds: [A], categories: ['Fuel'] as Category[] });
    expect(w.state()).toEqual(before);
    expect(w.tx.userSubsidiaryAccess.update).not.toHaveBeenCalled();
  });

  it('a company named twice in a grant is invalid input, before the database', async () => {
    const w = world([{ id: MK, role: 'masterkey' }]);
    await expect(w.service.setCentralReporterGrant(w.as(MK), 'rep', { subsidiaryIds: [A, A.toUpperCase()], categories: ['Fuel'] as Category[] }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(w.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("an invitation raced by another writer's grant: TA024's refusal answered single_entry_conflict with an empty list", async () => {
    const w = world([{ id: SA, role: 'super_admin', grants: { [A]: [] } }]);
    w.tx.userSubsidiaryAccess.createMany.mockRejectedValueOnce(new Prisma.PrismaClientUnknownRequestError(
      'PostgresError { code: "TA024", message: "single_entry_conflict: side=central_reporter; at subsidiary x", severity: "ERROR" }',
      { clientVersion: 'test' },
    ) as never);
    const refusal = await w.service.inviteMember(w.as(SA), {
      email: 'raced@tonyai.test', fullName: 'Raced', role: UserRole.standard_user, language: 'en', access: [grantRow(A, ['Fuel'])],
    }).catch((e) => e);
    expect(refusal.response).toMatchObject({ code: 'single_entry_conflict', params: { side: 'central_reporter' }, conflicts: [] });
  });
});
