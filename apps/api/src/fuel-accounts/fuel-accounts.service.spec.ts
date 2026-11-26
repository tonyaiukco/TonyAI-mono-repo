import { describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { FuelAccountsService } from './fuel-accounts.service';

/**
 * DB-free: who may act on fuel accounts at all (inc28-fuel-bulk C5, D7, D14).
 * The targets — a super_admin's own proposal only, an associate by a masterkey
 * only, a sector group never — are proven against the database in
 * `test/int/fuel-files.int.spec.ts`.
 */

const user = (role: RequestUser['role']): RequestUser => ({
  id: '00000000-0000-4000-8000-0000000000ff',
  email: 'x@tonyai.test',
  fullName: 'X',
  role,
  organisationId: '00000000-0000-4000-8000-0000000000aa',
  accessibleSubsidiaryIds: ['00000000-0000-4000-8000-000000000001'],
  categoryGrants: {},
});

function service() {
  const prisma = { $transaction: vi.fn(), $queryRaw: vi.fn(async () => []), fuelAccount: { findMany: vi.fn(async () => []) } };
  return { prisma, accounts: new FuelAccountsService(prisma as unknown as PrismaService, { record: vi.fn() } as unknown as AuditService) };
}

const status = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as { getStatus(): number }).getStatus();
const ID = '00000000-0000-4000-8000-0000000000a1';
const TARGET = { subsidiaryId: '00000000-0000-4000-8000-000000000001' };

describe('FuelAccountsService — the roles', () => {
  it('refuses a standard user every act on accounts, the list included', async () => {
    const { prisma, accounts } = service();
    const standard = user('standard_user');
    expect(await status(accounts.list(standard))).toBe(403);
    expect(await status(accounts.confirm(standard, ID, TARGET))).toBe(403);
    expect(await status(accounts.create(standard, { source: 'shell', code: 'X', name: 'X', ...TARGET }))).toBe(403);
    expect(await status(accounts.update(standard, ID, TARGET))).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('lets an auditor read but never confirm, add or change', async () => {
    const { prisma, accounts } = service();
    const auditor = user('auditor');
    await expect(accounts.list(auditor)).resolves.toEqual([]);
    expect(await status(accounts.confirm(auditor, ID, TARGET))).toBe(403);
    expect(await status(accounts.create(auditor, { source: 'shell', code: 'X', name: 'X', ...TARGET }))).toBe(403);
    expect(await status(accounts.update(auditor, ID, TARGET))).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps adding by hand and changing a mapping with the masterkey', async () => {
    const { prisma, accounts } = service();
    const superAdmin = user('super_admin');
    expect(await status(accounts.create(superAdmin, { source: 'shell', code: 'X', name: 'X', ...TARGET }))).toBe(403);
    expect(await status(accounts.update(superAdmin, ID, { subsidiaryId: null }))).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
