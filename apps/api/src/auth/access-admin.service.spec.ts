import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@tonyai/db';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { AccessAdminService, tenantAdminLockKey } from './access-admin.service';
import type { RequestUser } from './auth.types';

// DB-free: the refusals that must happen before any query. The database half
// (organisation bounds, the per-organisation lock, audit atomicity) is proven
// on PostgreSQL in test/int/access-admin.int.spec.ts.

const ORG = '11111111-1111-4111-8111-111111111111';

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

const INVITE = { email: 'new@tonyai.test', fullName: 'New', role: UserRole.data_entry, language: 'en' as const, subsidiaryIds: [] };

describe('AccessAdminService — LP4-01 refusals before the database is touched', () => {
  it.each(['consultant', 'data_entry', 'executive_viewer'] as const)('a %s invites, disables, enables or re-sends nothing', async (role) => {
    const { prisma, service } = setup();
    await expect(service.inviteMember(user(role), INVITE)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.disableMember(user(role), 'p')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.enableMember(user(role), 'p')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.reopenInvitation(user(role), 'p')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.replaceSubsidiaryAccess(user(role), 'p', [])).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('nobody disables their own account (so the actor always stays an active super_admin) — in any spelling of the id', async () => {
    const { prisma, service } = setup();
    await expect(service.disableMember(user('super_admin'), 'actor')).rejects.toMatchObject({ response: { code: 'own_account_forbidden' } });
    await expect(service.disableMember(user('super_admin'), 'ACTOR')).rejects.toMatchObject({ response: { code: 'own_account_forbidden' } });
    await expect(service.setRole(user('super_admin'), 'ACTOR', UserRole.consultant)).rejects.toMatchObject({ response: { code: 'own_account_forbidden' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('an invitation with grants for an organisation-wide role, an unknown role or language is refused', async () => {
    const { prisma, service } = setup();
    await expect(service.inviteMember(user('super_admin'), { ...INVITE, role: UserRole.consultant, subsidiaryIds: ['s'] })).rejects.toMatchObject({
      response: { code: 'access_role_mismatch' },
    });
    await expect(service.inviteMember(user('super_admin'), { ...INVITE, role: 'platform_admin' as UserRole })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.inviteMember(user('super_admin'), { ...INVITE, language: 'de' as 'en' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('AccessAdminService — refused before the database is touched', () => {
  it.each(['consultant', 'data_entry', 'executive_viewer'] as const)('a %s administers nothing', async (role) => {
    const { prisma, service } = setup();
    await expect(service.grantSubsidiaryAccess(user(role), 'p', 's')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.revokeSubsidiaryAccess(user(role), 'p', 's')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.setRole(user(role), 'p', UserRole.consultant)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a super_admin with no organisation administers nothing — there is no platform-wide administrator', async () => {
    const { prisma, service } = setup();
    await expect(service.grantSubsidiaryAccess(user('super_admin', null), 'p', 's')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.setRole(user('super_admin', null), 'p', UserRole.consultant)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('nobody changes their own role', async () => {
    const { prisma, service } = setup();
    await expect(service.setRole(user('super_admin'), 'actor', UserRole.consultant)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('an unknown role is refused', async () => {
    const { prisma, service } = setup();
    await expect(service.setRole(user('super_admin'), 'p', 'platform_admin' as UserRole)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('AccessAdminService — every lookup is bounded by the actor\'s organisation', () => {
  // The composite keys would refuse a cross-organisation grant anyway, and with
  // the same 404 — but only after trying it, which a caller can time
  // (`qa-auditor` round 2 measured ~1 ms). The bound must be in the lookup.
  function txStub(found: { subsidiary?: unknown; member?: unknown }) {
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      profile: {
        findUnique: vi.fn(async () => ({ role: 'super_admin', organisationId: ORG })),
        findFirst: vi.fn(async () => found.member ?? null),
      },
      subsidiary: { findFirst: vi.fn(async () => found.subsidiary ?? null) },
      userSubsidiaryAccess: { findUnique: vi.fn(), create: vi.fn() },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const service = new AccessAdminService(prisma as unknown as PrismaService, { record: vi.fn() } as unknown as AuditService);
    return { tx, service };
  }

  it("a grant looks the subsidiary up within the actor's organisation, and never writes on a miss", async () => {
    const { tx, service } = txStub({ member: { id: 'p', role: 'data_entry' } });
    await expect(service.grantSubsidiaryAccess(user('super_admin'), 'p', 'foreign-subsidiary')).rejects.toThrow(
      'Subsidiary not found',
    );
    expect(tx.subsidiary.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'foreign-subsidiary', organisationId: ORG } }),
    );
    expect(tx.userSubsidiaryAccess.create).not.toHaveBeenCalled();
  });

  it("the target profile is looked up within the actor's organisation", async () => {
    const { tx, service } = txStub({});
    await expect(service.setRole(user('super_admin'), 'foreign-profile', UserRole.consultant)).rejects.toThrow(
      'User not found',
    );
    expect(tx.profile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'foreign-profile', organisationId: ORG } }),
    );
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
