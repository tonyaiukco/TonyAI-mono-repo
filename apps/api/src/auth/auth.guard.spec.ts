import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { SupabaseAuthGuard } from './auth.guard';
import { tokenVerifier } from './token-verifier';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from './auth.types';

// Token verification is stubbed so these cases can drive the token subject
// without real keys; the verifier itself is covered by token-verifier.spec.ts.
vi.mock('./token-verifier', async (importOriginal) => ({
  // Keep the real TokenVerificationError so the guard's instanceof check (which
  // decides whether a config problem gets logged) behaves as in production.
  ...(await importOriginal<typeof import('./token-verifier')>()),
  tokenVerifier: { verify: vi.fn().mockResolvedValue({ sub: 'user-1' }) },
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

/**
 * The guard is the PRIMARY tenant-isolation enforcement point, so every way it
 * can refuse a request is locked down here. Without these, a refactor that
 * dropped the try/catch or the `sub` check would ship green.
 */
describe('SupabaseAuthGuard — rejection paths', () => {
  let prisma: PrismaMock;
  let guard: SupabaseAuthGuard;

  beforeEach(() => {
    prisma = createPrismaMock();
    guard = new SupabaseAuthGuard(reflector, prisma as unknown as PrismaService);
    vi.mocked(tokenVerifier.verify).mockResolvedValue({ sub: 'user-1' });
  });

  it.each([
    ['no Authorization header', undefined],
    ['a non-Bearer scheme', 'Basic dXNlcjpwYXNz'],
    ['a bare token without the Bearer prefix', 'eyJhbGciOiJIUzI1NiJ9.e30.x'],
  ])('rejects %s without touching the database', async (_label, header) => {
    const request: { headers: Record<string, string>; user?: RequestUser } = { headers: {} };
    if (header) request.headers.authorization = header;
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => null,
      getClass: () => null,
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(prisma.profile.findUnique).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it('rejects when verification fails, and never attaches a user', async () => {
    vi.mocked(tokenVerifier.verify).mockRejectedValue(new Error('bad signature'));
    const { context, request } = makeContext();
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(prisma.profile.findUnique).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>]>([
    ['absent', {}],
    ['non-string', { sub: 42 }],
  ])('rejects a verified token whose sub is %s', async (_label, payload) => {
    vi.mocked(tokenVerifier.verify).mockResolvedValue(payload);
    const { context, request } = makeContext();
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(prisma.profile.findUnique).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it('rejects a valid token with no matching profile', async () => {
    prisma.profile.findUnique.mockResolvedValue(null);
    const { context, request } = makeContext();
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });

  it('lets a @Public() route through without a token', async () => {
    vi.mocked(reflector.getAllAndOverride).mockReturnValueOnce(true);
    const request = { headers: {} };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => null,
      getClass: () => null,
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(tokenVerifier.verify).not.toHaveBeenCalled();
  });
});
