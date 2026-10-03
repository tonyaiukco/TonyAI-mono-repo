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

describe('tenantAdminLockKey', () => {
  it('is stable for an organisation and differs between organisations', () => {
    expect(tenantAdminLockKey(ORG)).toBe(tenantAdminLockKey(ORG));
    expect(tenantAdminLockKey(ORG)).not.toBe(tenantAdminLockKey('22222222-2222-4222-8222-222222222222'));
    expect(Number.isInteger(tenantAdminLockKey(ORG))).toBe(true);
  });
});
