import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@tonyai/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccessAdminService } from '../../src/auth/access-admin.service';
import type { RequestUser } from '../../src/auth/auth.types';
import { AuditService } from '../../src/audit/audit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  addMember,
  backendPid,
  connect,
  connectOwner,
  createTenant,
  holdBefore,
  settledOrBlocked,
  type Tenant,
} from './db';
import { abortAfterAuditClient, failingAuditClient } from './services';

/**
 * LP1-03: the role/access mutation boundary onboarding (LP4-01) calls — on the
 * runtime role, against two organisations, every role as the actor, and ids
 * from the other tenant. No cross-tenant administrator exists: everything here
 * is bounded by the actor's organisation. INC-2.6 (design Decision 9): a
 * masterkey sets a super_admin's companies, a super_admin a standard user's
 * company and categories inside its own grants (`replaceSubsidiaryAccess`, the
 * whole selection); the grant/revoke pair is gone.
 */

let a: PrismaService;
let b: PrismaService;
let observer: PrismaService;
let owner: PrismaService;
let A: Tenant;
let B: Tenant;
/** A's second company: granted to nobody by the fixture. */
let secondSubsidiaryA: string;

const service = (client: PrismaService) => new AccessAdminService(client, new AuditService(client));

beforeAll(() => {
  a = connect();
  b = connect();
  observer = connect();
  owner = connectOwner();
});

afterAll(async () => {
  await Promise.all([a, b, observer, owner].map((c) => c.$disconnect()));
});

beforeEach(async () => {
  [A, B] = await Promise.all([createTenant(), createTenant()]);
  secondSubsidiaryA = A.otherSubsidiaryId;
});

afterEach(async () => {
  await Promise.all([A.cleanup(), B.cleanup()]);
});

const grantsOf = async (userId: string) =>
  (
    await observer.userSubsidiaryAccess.findMany({
      where: { userId },
      select: { subsidiaryId: true, organisationId: true, categories: true },
      orderBy: { subsidiaryId: 'asc' },
    })
  ).map((g) => ({ ...g, categories: [...g.categories].sort() }));
const companiesOf = async (userId: string) => (await grantsOf(userId)).map((g) => g.subsidiaryId).sort();
const auditOf = (entityId: string) =>
  observer.auditLog.findMany({
    where: { entityId, entity: { in: ['subsidiary_access', 'profile', 'invitation'] } },
    orderBy: { createdAt: 'asc' },
  });
const roleOf = async (id: string) => (await observer.profile.findUniqueOrThrow({ where: { id } })).role;
const failure = (p: Promise<unknown>) => p.then(() => null, (err: unknown) => err);
const codeOf = (err: unknown) => (err as { getResponse?: () => { code?: string } }).getResponse?.().code;
const grant = (subsidiaryId: string, categories: string[] = []) => ({ subsidiaryId, categories }) as never;

describe("replaceSubsidiaryAccess — a masterkey sets a super_admin's companies", () => {
  it('adds a company of the organisation, with its audit row', async () => {
    await service(a).replaceSubsidiaryAccess(A.users.masterkey, A.users.superAdmin.id, [grant(A.subsidiaryId), grant(secondSubsidiaryA)]);

    expect(await companiesOf(A.users.superAdmin.id)).toEqual([A.subsidiaryId, secondSubsidiaryA].sort());
    const rows = await auditOf(A.users.superAdmin.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'create',
      entity: 'subsidiary_access',
      userId: A.users.masterkey.id,
      role: 'masterkey',
      organisationId: A.organisationId,
      diff: { subsidiaryId: secondSubsidiaryA },
    });
  });

  it('is idempotent: the same selection again changes nothing and audits nothing', async () => {
    await service(a).replaceSubsidiaryAccess(A.users.masterkey, A.users.superAdmin.id, [grant(A.subsidiaryId), grant(secondSubsidiaryA)]);
    await service(a).replaceSubsidiaryAccess(A.users.masterkey, A.users.superAdmin.id, [grant(secondSubsidiaryA), grant(A.subsidiaryId)]);
    expect(await auditOf(A.users.superAdmin.id)).toHaveLength(1);
  });

  it('withdraws a company left out of the selection, with its audit row', async () => {
    await service(a).replaceSubsidiaryAccess(A.users.masterkey, A.users.superAdmin.id, []);
    expect(await grantsOf(A.users.superAdmin.id)).toEqual([]);
    const [row] = await auditOf(A.users.superAdmin.id);
    expect(row).toMatchObject({ action: 'delete', entity: 'subsidiary_access', diff: { subsidiaryId: A.subsidiaryId } });
  });

  it.each([
    ["another organisation's subsidiary", () => [A.users.superAdmin.id, B.subsidiaryId]],
    ["another organisation's user", () => [B.users.superAdmin.id, A.subsidiaryId]],
    ["another organisation's user AND subsidiary", () => [B.users.superAdmin.id, B.subsidiaryId]],
    ['an id that does not exist', () => [randomUUID(), A.subsidiaryId]],
  ])('%s: 404 — the same answer as a missing id, and nothing written', async (_label, ids) => {
    const [profileId, subsidiaryId] = ids();
    const before = await grantsOf(profileId);
    await expect(
      service(a).replaceSubsidiaryAccess(A.users.masterkey, profileId, [grant(subsidiaryId)]),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await grantsOf(profileId)).toEqual(before);
    expect(await auditOf(profileId)).toEqual([]);
  });

  it("B's masterkey cannot set A's user's access — there is no cross-tenant administrator", async () => {
    for (const access of [[grant(secondSubsidiaryA)], []]) {
      await expect(
        service(b).replaceSubsidiaryAccess(B.users.masterkey, A.users.superAdmin.id, access),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(await companiesOf(A.users.superAdmin.id)).toEqual([A.subsidiaryId]);
    expect(await auditOf(A.users.superAdmin.id)).toEqual([]);
  });

  it.each(['standardUser', 'auditor'] as const)('a %s sets nobody\'s access: 403', async (role) => {
    await expect(
      service(a).replaceSubsidiaryAccess(A.users[role], A.users.superAdmin.id, [grant(secondSubsidiaryA)]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await companiesOf(A.users.superAdmin.id)).toEqual([A.subsidiaryId]);
  });

  it("the masterkey does not set a standard user's company (ruling R3): 403, nothing written", async () => {
    await expect(
      service(a).replaceSubsidiaryAccess(A.users.masterkey, A.users.standardUser.id, [grant(secondSubsidiaryA, ['Electricity'])]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await companiesOf(A.users.standardUser.id)).toEqual([A.subsidiaryId]);
    expect(await auditOf(A.users.standardUser.id)).toEqual([]);
  });

  it.each(['masterkey', 'auditor'] as const)(
    'access for a %s is refused (409 access_role_mismatch): organisation-wide roles hold no grants',
    async (role) => {
      const target = role === 'masterkey' ? await addMember(owner, A, UserRole.masterkey) : A.users.auditor;
      await expect(
        service(a).replaceSubsidiaryAccess(A.users.masterkey, target.id, [grant(secondSubsidiaryA)]),
      ).rejects.toMatchObject({ status: 409, response: { code: 'access_role_mismatch' } });
      expect(await grantsOf(target.id)).toEqual([]);
    },
  );

  it("categories on a super_admin's grant are refused (409 access_role_mismatch): only a standard user's grant names them", async () => {
    await expect(
      service(a).replaceSubsidiaryAccess(A.users.masterkey, A.users.superAdmin.id, [grant(A.subsidiaryId, ['Electricity'])]),
    ).rejects.toMatchObject({ status: 409, response: { code: 'access_role_mismatch' } });
    expect(await grantsOf(A.users.superAdmin.id)).toEqual([{ subsidiaryId: A.subsidiaryId, organisationId: A.organisationId, categories: [] }]);
  });

  it('the change and its audit rows commit together (audit insert fails / audit insert aborts)', async () => {
    // Pooled clients both: a service that wrote its audit row on the root client
    // instead of the transaction's would then commit it on another connection
    // and be caught here, not merely starve a one-connection client.
    const pooled = connect(3);
    try {
      for (const client of [failingAuditClient(pooled), abortAfterAuditClient(pooled)]) {
        for (const access of [[grant(A.subsidiaryId), grant(secondSubsidiaryA)], []]) {
          await expect(
            service(client).replaceSubsidiaryAccess(A.users.masterkey, A.users.superAdmin.id, access),
          ).rejects.toThrow();
          expect(await companiesOf(A.users.superAdmin.id)).toEqual([A.subsidiaryId]);
          expect(await auditOf(A.users.superAdmin.id)).toEqual([]);
        }
      }
    } finally {
      await pooled.$disconnect();
    }
  });
});

describe("replaceSubsidiaryAccess — a super_admin sets a standard user's company and categories, inside its own grants (task 6.7)", () => {
  it('re-categorises the grant in its company, audited before → after', async () => {
    await service(a).replaceSubsidiaryAccess(A.users.superAdmin, A.users.standardUser.id, [grant(A.subsidiaryId, ['Fuel', 'Electricity'])]);
    expect(await grantsOf(A.users.standardUser.id)).toEqual([
      { subsidiaryId: A.subsidiaryId, organisationId: A.organisationId, categories: ['Electricity', 'Fuel'] },
    ]);
    const rows = await auditOf(A.users.standardUser.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'update', entity: 'subsidiary_access', userId: A.users.superAdmin.id, role: 'super_admin',
      diff: { subsidiaryId: A.subsidiaryId, after: { categories: ['Electricity', 'Fuel'] } },
    });
  });

  it('a target granted A and C, the actor granted A: a replace touches A and leaves C as it was', async () => {
    // A standard user carried over with two companies (written as the owner:
    // the product grants one, ruling R6), C outside the super_admin's scope.
    await owner.userSubsidiaryAccess.create({
      data: { userId: A.users.standardUser.id, subsidiaryId: secondSubsidiaryA, organisationId: A.organisationId, categories: ['Water'] },
    });
    const c = { subsidiaryId: secondSubsidiaryA, organisationId: A.organisationId, categories: ['Water'] };

    await service(a).replaceSubsidiaryAccess(A.users.superAdmin, A.users.standardUser.id, [grant(A.subsidiaryId, ['Electricity'])]);
    expect(await grantsOf(A.users.standardUser.id)).toEqual(
      [{ subsidiaryId: A.subsidiaryId, organisationId: A.organisationId, categories: ['Electricity'] }, c]
        .sort((x, y) => x.subsidiaryId.localeCompare(y.subsidiaryId)),
    );

    // The whole selection empty: only the actor's company is withdrawn.
    await service(a).replaceSubsidiaryAccess(A.users.superAdmin, A.users.standardUser.id, []);
    expect(await grantsOf(A.users.standardUser.id)).toEqual([c]);
    const rows = await auditOf(A.users.standardUser.id);
    expect(rows.map((r) => [r.action, (r.diff as { subsidiaryId: string }).subsidiaryId])).toEqual([
      ['update', A.subsidiaryId],
      ['delete', A.subsidiaryId],
    ]);

    // Naming C is naming a company it does not hold: 404, C untouched.
    const refused = await failure(
      service(a).replaceSubsidiaryAccess(A.users.superAdmin, A.users.standardUser.id, [grant(secondSubsidiaryA, ['Fuel'])]),
    );
    expect(refused).toBeInstanceOf(NotFoundException);
    expect(codeOf(refused)).toBe('subsidiary_not_found');
    expect(await grantsOf(A.users.standardUser.id)).toEqual([c]);
  });

  it('a standard user granted only another company is refused the super_admin\'s company (409 standard_user_single_company)', async () => {
    await owner.userSubsidiaryAccess.deleteMany({ where: { userId: A.users.standardUser.id } });
    await owner.userSubsidiaryAccess.create({
      data: { userId: A.users.standardUser.id, subsidiaryId: secondSubsidiaryA, organisationId: A.organisationId, categories: ['Water'] },
    });
    const refused = await failure(
      service(a).replaceSubsidiaryAccess(A.users.superAdmin, A.users.standardUser.id, [grant(A.subsidiaryId, ['Electricity'])]),
    );
    expect(refused).toMatchObject({ status: 409, response: { code: 'standard_user_single_company' } });
    expect(await companiesOf(A.users.standardUser.id)).toEqual([secondSubsidiaryA]);
    expect(await auditOf(A.users.standardUser.id)).toEqual([]);
  });

  it.each(['masterkey', 'auditor', 'superAdmin'] as const)(
    'an account whose role it does not assign (%s) answers 404 user_not_found, with or without access asked',
    async (role) => {
      const target = role === 'superAdmin'
        ? await addMember(owner, A, UserRole.super_admin, { grants: [A.subsidiaryId] })
        : A.users[role];
      const before = await grantsOf(target.id);
      for (const access of [[grant(A.subsidiaryId)], []]) {
        const refused = await failure(service(a).replaceSubsidiaryAccess(A.users.superAdmin, target.id, access));
        expect(refused, JSON.stringify(access)).toBeInstanceOf(NotFoundException);
        expect(codeOf(refused)).toBe('user_not_found');
      }
      expect(await grantsOf(target.id)).toEqual(before);
      expect(await auditOf(target.id)).toEqual([]);
    },
  );

  it('an unknown category is refused (400) and nothing is written', async () => {
    await expect(
      service(a).replaceSubsidiaryAccess(A.users.superAdmin, A.users.standardUser.id, [grant(A.subsidiaryId, ['Unicorns'])]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await auditOf(A.users.standardUser.id)).toEqual([]);
  });
});

describe('inviteMember — whom each role invites, with which companies', () => {
  const invitee = (role: UserRole, access: never[]) => ({
    email: `int-invitee-${randomUUID().slice(0, 8)}@tonyai.test`,
    fullName: 'Int invitee',
    role,
    language: 'en' as const,
    access,
  });
  const profileByEmail = (email: string) => observer.profile.findUnique({ where: { email } });

  it('BUG-14: a masterkey invites a super_admin for two companies — both grants exist, each audited', async () => {
    const input = invitee(UserRole.super_admin, [grant(A.subsidiaryId), grant(secondSubsidiaryA)]);
    const { profileId } = await service(a).inviteMember(A.users.masterkey, input);
    A.profileIds.push(profileId);

    expect(await roleOf(profileId)).toBe('super_admin');
    expect(await grantsOf(profileId)).toEqual(
      [A.subsidiaryId, secondSubsidiaryA].sort().map((subsidiaryId) => ({ subsidiaryId, organisationId: A.organisationId, categories: [] })),
    );
    const rows = await auditOf(profileId);
    expect(rows.map((r) => r.action).sort()).toEqual(['create', 'create', 'invite']);
    expect(rows.find((r) => r.action === 'invite')).toMatchObject({
      entity: 'invitation', userId: A.users.masterkey.id,
      diff: { role: 'super_admin', subsidiaryIds: [A.subsidiaryId, secondSubsidiaryA].sort() },
    });
  });

  it('a super_admin invites a standard user into its company with ticked categories', async () => {
    const input = invitee(UserRole.standard_user, [grant(A.subsidiaryId, ['Fuel', 'Electricity'])]);
    const { profileId } = await service(a).inviteMember(A.users.superAdmin, input);
    A.profileIds.push(profileId);
    expect(await grantsOf(profileId)).toEqual([{ subsidiaryId: A.subsidiaryId, organisationId: A.organisationId, categories: ['Electricity', 'Fuel'] }]);
    const created = (await auditOf(profileId)).find((r) => r.action === 'create');
    expect(created).toMatchObject({ role: 'super_admin', diff: { subsidiaryId: A.subsidiaryId, categories: ['Electricity', 'Fuel'] } });
  });

  it.each([
    ['a company outside its grants', () => [grant(secondSubsidiaryA, ['Fuel'])], 404, 'subsidiary_not_found'],
    ['two companies for a standard user', () => [grant(A.subsidiaryId, ['Fuel']), grant(secondSubsidiaryA, ['Fuel'])], 409, 'standard_user_single_company'],
  ] as const)('a super_admin naming %s is refused — no account is created', async (_label, access, status, code) => {
    const input = invitee(UserRole.standard_user, access() as never[]);
    const refused = await failure(service(a).inviteMember(A.users.superAdmin, input));
    expect(refused).toMatchObject({ status, response: { code } });
    expect(await profileByEmail(input.email)).toBeNull();
  });

  it.each([
    ['masterkey', UserRole.standard_user],
    ['masterkey', UserRole.masterkey],
    ['superAdmin', UserRole.super_admin],
    ['superAdmin', UserRole.auditor],
    ['standardUser', UserRole.standard_user],
    ['auditor', UserRole.auditor],
  ] as const)('a %s may not invite a %s: 403, no account', async (actor, role) => {
    const access = role === UserRole.standard_user || role === UserRole.super_admin ? [grant(A.subsidiaryId)] : [];
    const input = invitee(role, access);
    await expect(service(a).inviteMember(A.users[actor], input)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await profileByEmail(input.email)).toBeNull();
  });
});

describe('the composite foreign key refuses a cross-organisation grant, categories or not (task 6.7)', () => {
  it.each([
    ["A's user, B's company, A's organisation", () => ({ userId: A.users.standardUser.id, subsidiaryId: B.subsidiaryId, organisationId: A.organisationId })],
    ["A's user, B's company, B's organisation", () => ({ userId: A.users.standardUser.id, subsidiaryId: B.subsidiaryId, organisationId: B.organisationId })],
    ["B's user, A's company, A's organisation", () => ({ userId: B.users.standardUser.id, subsidiaryId: A.subsidiaryId, organisationId: A.organisationId })],
  ])('%s, with categories: refused by the database, even to the owner', async (_label, row) => {
    for (const writer of [owner, a]) {
      const refused = await failure(writer.userSubsidiaryAccess.create({ data: { ...row(), categories: ['Electricity', 'Fuel'] } }));
      expect(refused, writer === owner ? 'owner' : 'runtime').toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((refused as Prisma.PrismaClientKnownRequestError).code).toBe('P2003');
    }
    expect(await observer.userSubsidiaryAccess.count({ where: { userId: row().userId, subsidiaryId: row().subsidiaryId } })).toBe(0);
  });
});

describe('every change commits with its audit rows, or not at all', () => {
  it('a role change whose audit insert fails or aborts leaves the role AND the grants as they were', async () => {
    const pooled = connect(3);
    try {
      for (const client of [failingAuditClient(pooled), abortAfterAuditClient(pooled)]) {
        await expect(
          service(client).setRole(A.users.masterkey, A.users.standardUser.id, UserRole.auditor),
        ).rejects.toThrow();
        expect(await roleOf(A.users.standardUser.id)).toBe('standard_user');
        expect(await grantsOf(A.users.standardUser.id)).toHaveLength(1);
        expect(await auditOf(A.users.standardUser.id)).toEqual([]);
      }
    } finally {
      await pooled.$disconnect();
    }
  });
});

describe('the withdrawal leg of a role change commits with the rest, or not at all (`qa-auditor` round 2)', () => {
  it('a role change whose SECOND audit insert (a withdrawal row) aborts leaves role, grants and trail unchanged', async () => {
    const pooled = connect(3);
    try {
      let inserts = 0;
      const client = pooled.$extends({
        query: {
          auditLog: {
            async create({ args, query }) {
              const row = await query(args);
              inserts += 1;
              if (inserts === 2) throw new Error('aborted at the withdrawal audit row (LP1-03 test)');
              return row;
            },
          },
        },
      }) as unknown as PrismaService;
      await expect(
        service(client).setRole(A.users.masterkey, A.users.standardUser.id, UserRole.auditor),
      ).rejects.toThrow();
      expect(inserts).toBe(2);
      expect(await roleOf(A.users.standardUser.id)).toBe('standard_user');
      expect(await grantsOf(A.users.standardUser.id)).toHaveLength(1);
      expect(await auditOf(A.users.standardUser.id)).toEqual([]);
    } finally {
      await pooled.$disconnect();
    }
  });
});

describe('setRole', () => {
  it("changes a member's role, with its audit row (from → to)", async () => {
    await service(a).setRole(A.users.masterkey, A.users.auditor.id, UserRole.super_admin);
    expect(await roleOf(A.users.auditor.id)).toBe('super_admin');
    const [row] = await auditOf(A.users.auditor.id);
    expect(row).toMatchObject({
      action: 'update',
      entity: 'profile',
      organisationId: A.organisationId,
      diff: { before: { role: 'auditor' }, after: { role: 'super_admin' } },
    });
  });

  // INC-2.6: ANY role change withdraws every grant — between the two granted
  // roles too, since they read a grant differently (task 6.7).
  it.each([
    ['super_admin → auditor', 'superAdmin', UserRole.auditor],
    ['super_admin → standard_user', 'superAdmin', UserRole.standard_user],
    ['standard_user → super_admin', 'standardUser', UserRole.super_admin],
  ] as const)('%s withdraws every grant, each audited with its reason; moved back, it starts with none', async (_label, who, role) => {
    const target = A.users[who];
    await owner.userSubsidiaryAccess.create({
      data: { userId: target.id, subsidiaryId: secondSubsidiaryA, organisationId: A.organisationId },
    });
    expect(await grantsOf(target.id)).toHaveLength(2);

    await service(a).setRole(A.users.masterkey, target.id, role);
    expect(await grantsOf(target.id)).toEqual([]);
    await service(a).setRole(A.users.masterkey, target.id, target.role);
    expect(await grantsOf(target.id)).toEqual([]);

    const rows = await auditOf(target.id);
    const withdrawn = rows.filter((r) => r.entity === 'subsidiary_access' && r.action === 'delete');
    expect(withdrawn.map((r) => (r.diff as { subsidiaryId: string }).subsidiaryId).sort()).toEqual(
      [A.subsidiaryId, secondSubsidiaryA].sort(),
    );
    for (const r of withdrawn) expect(r.diff).toMatchObject({ reason: `role changed from ${target.role} to ${role}` });
    expect(rows.filter((r) => r.entity === 'profile')).toHaveLength(2);
  });

  it('nobody changes their own role', async () => {
    await expect(
      service(a).setRole(A.users.masterkey, A.users.masterkey.id, UserRole.auditor),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await roleOf(A.users.masterkey.id)).toBe('masterkey');
  });

  it('nobody is made a masterkey, not even by a masterkey (ruling R1)', async () => {
    await expect(
      service(a).setRole(A.users.masterkey, A.users.superAdmin.id, UserRole.masterkey),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await roleOf(A.users.superAdmin.id)).toBe('super_admin');
    expect(await auditOf(A.users.superAdmin.id)).toEqual([]);
  });

  it.each(['superAdmin', 'standardUser', 'auditor'] as const)(
    'a %s cannot change a role — its own or anyone\'s: 403',
    async (role) => {
      await expect(service(a).setRole(A.users[role], A.users.standardUser.id, UserRole.auditor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service(a).setRole(A.users[role], A.users[role].id, UserRole.masterkey)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(await roleOf(A.users[role].id)).toBe(A.users[role].role);
      expect(await roleOf(A.users.standardUser.id)).toBe('standard_user');
    },
  );

  it("B's masterkey cannot change a role in A: 404", async () => {
    await expect(
      service(b).setRole(B.users.masterkey, A.users.auditor.id, UserRole.super_admin),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await roleOf(A.users.auditor.id)).toBe('auditor');
  });

  it('an unknown or retired role is refused (400)', async () => {
    for (const role of ['platform_admin', 'consultant', 'data_entry']) {
      await expect(
        service(a).setRole(A.users.masterkey, A.users.auditor.id, role as UserRole),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(await roleOf(A.users.auditor.id)).toBe('auditor');
  });

  it('the same role again changes nothing and audits nothing', async () => {
    await service(a).setRole(A.users.masterkey, A.users.auditor.id, UserRole.auditor);
    expect(await auditOf(A.users.auditor.id)).toEqual([]);
  });

  it('an administrator demoted since their request was authenticated cannot act on the stale role', async () => {
    await owner.profile.update({ where: { id: A.users.masterkey.id }, data: { role: 'auditor' } });
    const stale: RequestUser = { ...A.users.masterkey, role: 'masterkey' };
    await expect(service(a).setRole(stale, A.users.auditor.id, UserRole.super_admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service(a).replaceSubsidiaryAccess(stale, A.users.superAdmin.id, [grant(A.subsidiaryId), grant(secondSubsidiaryA)]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await roleOf(A.users.auditor.id)).toBe('auditor');
    expect(await companiesOf(A.users.superAdmin.id)).toEqual([A.subsidiaryId]);
  });

  it('two administrators demoting each other at once: exactly one wins, and the organisation keeps a masterkey', async () => {
    const second = await owner.profile.create({
      data: {
        id: randomUUID(),
        email: `int-admin2-${A.organisationId.slice(0, 8)}@tonyai.test`,
        fullName: 'Int admin two',
        role: 'masterkey',
        organisationId: A.organisationId,
      },
    });
    A.profileIds.push(second.id);
    const admin2: RequestUser = { ...A.users.masterkey, id: second.id, email: second.email };

    // A re-reads its actor (still masterkey) and stops just before its write;
    // B then tries to demote A's actor.
    const hold = holdBefore(a, 'Profile', 'update');
    const requestA = service(hold.client).setRole(A.users.masterkey, second.id, UserRole.auditor);
    await hold.reached();
    const pidB = await backendPid(b);
    const requestB = service(b).setRole(admin2, A.users.masterkey.id, UserRole.auditor);
    // B must wait behind A's per-organisation lock rather than run ahead.
    expect(await settledOrBlocked(requestB, pidB, observer)).toBe('blocked');
    hold.release();

    const [resultA, resultB] = await Promise.allSettled([requestA, requestB]);
    expect(resultA.status).toBe('fulfilled');
    expect(resultB.status).toBe('rejected');
    expect((resultB as PromiseRejectedResult).reason).toBeInstanceOf(ForbiddenException);
    expect(await roleOf(A.users.masterkey.id)).toBe('masterkey');
    expect(await roleOf(second.id)).toBe('auditor');
  });
});
