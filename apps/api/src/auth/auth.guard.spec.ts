import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { SupabaseAuthGuard } from './auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from './auth.types';

// jwt.verify is stubbed so we can drive the token subject without a real secret.
vi.mock('jsonwebtoken', () => ({
  verify: vi.fn().mockReturnValue({ sub: 'user-1' }),
}));

function createPrismaMock() {
  return {
    profile: { findUnique: vi.fn() },
    subsidiary: { findMany: vi.fn().mockResolvedValue([]) },
  };
}
type PrismaMock = ReturnType<typeof createPrismaMock>;

function makeContext(): { context: ExecutionContext; request: { user?: RequestUser } } {
  const request: { headers: Record<string, string>; user?: RequestUser } = {
    headers: { authorization: 'Bearer tok' },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => null,
    getClass: () => null,
  } as unknown as ExecutionContext;
  return { context, request };
}

const reflector = {
  getAllAndOverride: vi.fn().mockReturnValue(false),
} as unknown as Reflector;

describe('SupabaseAuthGuard — accessibleSubsidiaryIds', () => {
  let prisma: PrismaMock;
  let guard: SupabaseAuthGuard;

  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
    prisma = createPrismaMock();
    guard = new SupabaseAuthGuard(reflector, prisma as unknown as PrismaService);
  });

  it('gives a data_entry user exactly its explicit subsidiary access', async () => {
    prisma.profile.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'e@x',
      role: 'data_entry',
      organisationId: 'org-1',
      subsidiaryAccess: [{ subsidiaryId: 'sub-1' }, { subsidiaryId: 'sub-2' }],
    });
    const { context, request } = makeContext();
    await guard.canActivate(context);
    expect(request.user?.accessibleSubsidiaryIds).toEqual(['sub-1', 'sub-2']);
    expect(prisma.subsidiary.findMany).not.toHaveBeenCalled();
  });

  it('gives a super_admin every subsidiary in its organisation', async () => {
    prisma.profile.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'a@x',
      role: 'super_admin',
      organisationId: 'org-1',
      subsidiaryAccess: [],
    });
    prisma.subsidiary.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    const { context, request } = makeContext();
    await guard.canActivate(context);
    expect(prisma.subsidiary.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organisationId: 'org-1' } }),
    );
    expect(request.user?.accessibleSubsidiaryIds).toEqual(['s1', 's2']);
  });

  it('DEFAULT-DENIES a privileged profile with a null organisationId (no cross-tenant leak)', async () => {
    prisma.profile.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'a@x',
      role: 'super_admin',
      organisationId: null,
      subsidiaryAccess: [],
    });
    const { context, request } = makeContext();
    await guard.canActivate(context);
    // No unfiltered findMany, and an empty accessible set (default-deny).
    expect(prisma.subsidiary.findMany).not.toHaveBeenCalled();
    expect(request.user?.accessibleSubsidiaryIds).toEqual([]);
  });

  it('also default-denies a consultant with a null organisationId', async () => {
    prisma.profile.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'c@x',
      role: 'consultant',
      organisationId: null,
      subsidiaryAccess: [],
    });
    const { context, request } = makeContext();
    await guard.canActivate(context);
    expect(prisma.subsidiary.findMany).not.toHaveBeenCalled();
    expect(request.user?.accessibleSubsidiaryIds).toEqual([]);
  });
});
