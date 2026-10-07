import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from './auth.types';
import { PreferencesService } from './preferences.service';

// DB-free: what is written, and in which transaction. That the runtime role
// may write `language` and nothing else new is proven on PostgreSQL in
// test/int/preferences.int.spec.ts.

const user: RequestUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'entry@tonyai.test',
  fullName: 'Entry',
  role: 'data_entry',
  organisationId: '11111111-1111-4111-8111-111111111111',
  accessibleSubsidiaryIds: [],
};

function setup(current: string | undefined) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue(current === undefined ? [] : [{ language: current }]),
    profile: { update: vi.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new PreferencesService(prisma as unknown as PrismaService, audit as unknown as AuditService);
  return { tx, prisma, audit, service };
}

describe('PreferencesService.setLanguage', () => {
  it('writes the caller\'s own profile and audits before → after in the same transaction', async () => {
    const { tx, audit, service } = setup('en');
    await service.setLanguage(user, 'tr');

    expect(tx.profile.update).toHaveBeenCalledWith({ where: { id: user.id }, data: { language: 'tr' } });
    expect(audit.record).toHaveBeenCalledWith(
      user,
      { action: 'update', entity: 'profile', entityId: user.id, diff: { before: { language: 'en' }, after: { language: 'tr' } } },
      tx,
    );
    // Locked by the caller's id from the token — the only id this path uses.
    const [strings, ...values] = tx.$queryRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toMatch(/FOR UPDATE/);
    expect(values).toEqual([user.id]);
  });

  it('writes nothing — and audits nothing — when the language is already set', async () => {
    const { tx, audit, service } = setup('tr');
    await service.setLanguage(user, 'tr');
    expect(tx.profile.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('writes nothing when the profile is gone', async () => {
    const { tx, audit, service } = setup(undefined);
    await service.setLanguage(user, 'tr');
    expect(tx.profile.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('lets an audit failure fail the change (one transaction)', async () => {
    const { audit, service } = setup('en');
    audit.record.mockRejectedValueOnce(new Error('audit down'));
    await expect(service.setLanguage(user, 'tr')).rejects.toThrow('audit down');
  });
});
