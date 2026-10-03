import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@tonyai/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccessAdminService } from '../../src/auth/access-admin.service';
import type { RequestUser } from '../../src/auth/auth.types';
import { AuditService } from '../../src/audit/audit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
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
 * LP1-03: the role/access mutation boundary onboarding (LP4-01) will call —
 * on the runtime role, against two organisations, every role as the actor, and
 * ids from the other tenant. No cross-tenant administrator exists: everything
 * here is bounded by the actor's organisation.
 */

let a: PrismaService;
let b: PrismaService;
let observer: PrismaService;
let owner: PrismaService;
let A: Tenant;
let B: Tenant;
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
  secondSubsidiaryA = (
    await owner.subsidiary.create({
      data: { organisationId: A.organisationId, legalName: 'Int-test second subsidiary', geographyCode: 'UK' },
    })
  ).id;
});

afterEach(async () => {
  await Promise.all([A.cleanup(), B.cleanup()]);
});

const grantsOf = (userId: string) =>
  observer.userSubsidiaryAccess.findMany({ where: { userId }, select: { subsidiaryId: true, organisationId: true } });
const auditOf = (entityId: string) =>
  observer.auditLog.findMany({
    where: { entityId, entity: { in: ['subsidiary_access', 'profile'] } },
    orderBy: { createdAt: 'asc' },
  });
const roleOf = async (id: string) => (await observer.profile.findUniqueOrThrow({ where: { id } })).role;

describe('grantSubsidiaryAccess', () => {
  it('grants a subsidiary of the organisation to its data_entry user, with its audit row', async () => {
    await service(a).grantSubsidiaryAccess(A.users.superAdmin, A.users.dataEntry.id, secondSubsidiaryA);

    expect(await grantsOf(A.users.dataEntry.id)).toEqual(
      expect.arrayContaining([{ subsidiaryId: secondSubsidiaryA, organisationId: A.organisationId }]),
    );
    const [row] = await auditOf(A.users.dataEntry.id);
    expect(row).toMatchObject({
      action: 'create',
      entity: 'subsidiary_access',
      userId: A.users.superAdmin.id,
      role: 'super_admin',
      organisationId: A.organisationId,
      diff: { subsidiaryId: secondSubsidiaryA },
    });
  });

  it('is idempotent: granting again changes nothing and audits nothing', async () => {
    await service(a).grantSubsidiaryAccess(A.users.superAdmin, A.users.dataEntry.id, secondSubsidiaryA);
    await service(a).grantSubsidiaryAccess(A.users.superAdmin, A.users.dataEntry.id, secondSubsidiaryA);
    expect(await auditOf(A.users.dataEntry.id)).toHaveLength(1);
  });

  it.each([
    ["another organisation's subsidiary", () => [A.users.dataEntry.id, B.subsidiaryId]],
    ["another organisation's user", () => [B.users.dataEntry.id, A.subsidiaryId]],
    ["another organisation's user AND subsidiary", () => [B.users.dataEntry.id, B.subsidiaryId]],
    ['an id that does not exist', () => [randomUUID(), A.subsidiaryId]],
  ])('%s: 404 — the same answer as a missing id, and nothing written', async (_label, ids) => {
    const [profileId, subsidiaryId] = ids();
    const before = await grantsOf(profileId);
    await expect(service(a).grantSubsidiaryAccess(A.users.superAdmin, profileId, subsidiaryId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await grantsOf(profileId)).toEqual(before);
    expect(await auditOf(profileId)).toEqual([]);
  });

  it("B's super_admin cannot grant A's subsidiary to A's user — there is no cross-tenant administrator", async () => {
    await expect(
      service(b).grantSubsidiaryAccess(B.users.superAdmin, A.users.dataEntry.id, secondSubsidiaryA),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await grantsOf(A.users.dataEntry.id)).toHaveLength(1);
  });

  it.each(['consultant', 'dataEntry', 'executiveViewer'] as const)('a %s cannot grant: 403', async (role) => {
    await expect(
      service(a).grantSubsidiaryAccess(A.users[role], A.users.dataEntry.id, secondSubsidiaryA),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await grantsOf(A.users.dataEntry.id)).toHaveLength(1);
  });

  it.each(['superAdmin', 'consultant', 'executiveViewer'] as const)(
    'a grant to a %s is refused (400): organisation-wide roles hold no grants',
    async (role) => {
      await expect(
        service(a).grantSubsidiaryAccess(A.users.superAdmin, A.users[role].id, secondSubsidiaryA),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await grantsOf(A.users[role].id)).toEqual([]);
    },
  );

  it('the grant and its audit row commit together (audit insert fails / audit insert aborts)', async () => {
    const pooled = connect(3);
    try {
      for (const client of [failingAuditClient(a), abortAfterAuditClient(pooled)]) {
        await expect(
          service(client).grantSubsidiaryAccess(A.users.superAdmin, A.users.dataEntry.id, secondSubsidiaryA),
        ).rejects.toThrow();
        expect(await grantsOf(A.users.dataEntry.id)).toHaveLength(1);
        expect(await auditOf(A.users.dataEntry.id)).toEqual([]);
      }
    } finally {
      await pooled.$disconnect();
    }
  });
});

describe('revokeSubsidiaryAccess', () => {
  it('withdraws a grant, with its audit row', async () => {
    await service(a).revokeSubsidiaryAccess(A.users.superAdmin, A.users.dataEntry.id, A.subsidiaryId);
    expect(await grantsOf(A.users.dataEntry.id)).toEqual([]);
    const [row] = await auditOf(A.users.dataEntry.id);
    expect(row).toMatchObject({ action: 'delete', entity: 'subsidiary_access', diff: { subsidiaryId: A.subsidiaryId } });
  });

  it("B's super_admin cannot withdraw A's grant: 404, and the grant stays", async () => {
    await expect(
      service(b).revokeSubsidiaryAccess(B.users.superAdmin, A.users.dataEntry.id, A.subsidiaryId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await grantsOf(A.users.dataEntry.id)).toHaveLength(1);
    expect(await auditOf(A.users.dataEntry.id)).toEqual([]);
  });

  it('a grant that does not exist: 404', async () => {
    await expect(
      service(a).revokeSubsidiaryAccess(A.users.superAdmin, A.users.dataEntry.id, secondSubsidiaryA),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['consultant', 'dataEntry', 'executiveViewer'] as const)('a %s cannot withdraw: 403', async (role) => {
    await expect(
      service(a).revokeSubsidiaryAccess(A.users[role], A.users.dataEntry.id, A.subsidiaryId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await grantsOf(A.users.dataEntry.id)).toHaveLength(1);
  });
});

describe('setRole', () => {
  it("changes a member's role, with its audit row (from → to)", async () => {
    await service(a).setRole(A.users.superAdmin, A.users.consultant.id, UserRole.executive_viewer);
    expect(await roleOf(A.users.consultant.id)).toBe('executive_viewer');
    const [row] = await auditOf(A.users.consultant.id);
    expect(row).toMatchObject({
      action: 'update',
      entity: 'profile',
      organisationId: A.organisationId,
      diff: { before: { role: 'consultant' }, after: { role: 'executive_viewer' } },
    });
  });

  it('a data_entry user moved to another role loses its grants (audited); moved back, it starts with none', async () => {
    await service(a).grantSubsidiaryAccess(A.users.superAdmin, A.users.dataEntry.id, secondSubsidiaryA);
    expect(await grantsOf(A.users.dataEntry.id)).toHaveLength(2);

    await service(a).setRole(A.users.superAdmin, A.users.dataEntry.id, UserRole.consultant);
    expect(await grantsOf(A.users.dataEntry.id)).toEqual([]);
    await service(a).setRole(A.users.superAdmin, A.users.dataEntry.id, UserRole.data_entry);
    expect(await grantsOf(A.users.dataEntry.id)).toEqual([]);

    const rows = await auditOf(A.users.dataEntry.id);
    const withdrawn = rows.filter((r) => r.entity === 'subsidiary_access' && r.action === 'delete');
    expect(withdrawn.map((r) => (r.diff as { subsidiaryId: string }).subsidiaryId).sort()).toEqual(
      [A.subsidiaryId, secondSubsidiaryA].sort(),
    );
    expect(rows.filter((r) => r.entity === 'profile')).toHaveLength(2);
  });

  it('nobody changes their own role — not even to promote or keep the last super_admin', async () => {
    await expect(
      service(a).setRole(A.users.superAdmin, A.users.superAdmin.id, UserRole.consultant),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await roleOf(A.users.superAdmin.id)).toBe('super_admin');
  });

  it.each(['consultant', 'dataEntry', 'executiveViewer'] as const)(
    'a %s cannot promote itself or anyone: 403',
    async (role) => {
      await expect(service(a).setRole(A.users[role], A.users.dataEntry.id, UserRole.super_admin)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service(a).setRole(A.users[role], A.users[role].id, UserRole.super_admin)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(await roleOf(A.users[role].id)).toBe(A.users[role].role);
    },
  );

  it("B's super_admin cannot change a role in A: 404", async () => {
    await expect(
      service(b).setRole(B.users.superAdmin, A.users.consultant.id, UserRole.super_admin),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await roleOf(A.users.consultant.id)).toBe('consultant');
  });

  it('an unknown role is refused (400)', async () => {
    await expect(
      service(a).setRole(A.users.superAdmin, A.users.consultant.id, 'platform_admin' as UserRole),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the same role again changes nothing and audits nothing', async () => {
    await service(a).setRole(A.users.superAdmin, A.users.consultant.id, UserRole.consultant);
    expect(await auditOf(A.users.consultant.id)).toEqual([]);
  });

  it('an administrator demoted since their request was authenticated cannot act on the stale role', async () => {
    await owner.profile.update({ where: { id: A.users.superAdmin.id }, data: { role: 'consultant' } });
    const stale: RequestUser = { ...A.users.superAdmin, role: 'super_admin' };
    await expect(service(a).setRole(stale, A.users.consultant.id, UserRole.super_admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service(a).grantSubsidiaryAccess(stale, A.users.dataEntry.id, secondSubsidiaryA),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await roleOf(A.users.consultant.id)).toBe('consultant');
  });

  it('two administrators demoting each other at once: exactly one wins, and the organisation keeps a super_admin', async () => {
    const second = await owner.profile.create({
      data: {
        id: randomUUID(),
        email: `int-admin2-${A.organisationId.slice(0, 8)}@tonyai.test`,
        fullName: 'Int admin two',
        role: 'super_admin',
        organisationId: A.organisationId,
      },
    });
    A.profileIds.push(second.id);
    const admin2: RequestUser = { ...A.users.superAdmin, id: second.id, email: second.email };

    // A re-reads its actor (still super_admin) and stops just before its write;
    // B then tries to demote A's actor.
    const hold = holdBefore(a, 'Profile', 'update');
    const requestA = service(hold.client).setRole(A.users.superAdmin, second.id, UserRole.consultant);
    await hold.reached();
    const pidB = await backendPid(b);
    const requestB = service(b).setRole(admin2, A.users.superAdmin.id, UserRole.consultant);
    // B must wait behind A's per-organisation lock rather than run ahead.
    expect(await settledOrBlocked(requestB, pidB, observer)).toBe('blocked');
    hold.release();

    const [resultA, resultB] = await Promise.allSettled([requestA, requestB]);
    expect(resultA.status).toBe('fulfilled');
    expect(resultB.status).toBe('rejected');
    expect((resultB as PromiseRejectedResult).reason).toBeInstanceOf(ForbiddenException);
    expect(await roleOf(A.users.superAdmin.id)).toBe('super_admin');
    expect(await roleOf(second.id)).toBe('consultant');
  });
});
