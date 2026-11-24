import { Prisma } from '@tonyai/db';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from './auth.types';
import { passwordSetRowId, PreferencesService } from './preferences.service';

// DB-free: what is written, and in which transaction. That the runtime role
// may write `language` and nothing else new is proven on PostgreSQL in
// test/int/runtime-role.int.spec.ts, and the route end to end in
// test/int/tenant-isolation.int.spec.ts ("PATCH /me/preferences").

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

describe('PreferencesService.recordPasswordSet (pre-g5-security-hardening)', () => {
  const CHANGE = '7f3c2a1e-4b5d-4c6e-8f90-123456789abc';
  function recorder(write: () => Promise<void>) {
    const audit = { record: vi.fn(write) };
    const prisma = { auditLog: { findFirst: vi.fn() }, $transaction: vi.fn() };
    return { audit, prisma, service: new PreferencesService(prisma as unknown as PrismaService, audit as unknown as AuditService) };
  }

  it.each(['invite', 'recovery'] as const)('writes one password_set row as the caller, with an id derived from them and the change (%s)', async (flow) => {
    const { audit, prisma, service } = recorder(async () => undefined);
    await service.recordPasswordSet(user, flow, CHANGE);
    expect(audit.record).toHaveBeenCalledWith(
      user,
      { action: 'password_set', entity: 'profile', entityId: user.id, diff: { flow, changeId: CHANGE } },
      undefined,
      passwordSetRowId(user.id, CHANGE),
    );
    // No read first: the primary key decides (Codex review).
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
  });

  it('answers quietly when the row already exists — a repeat of the same change', async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`id`)', { code: 'P2002', clientVersion: 'test' });
    const { service } = recorder(async () => { throw duplicate; });
    await expect(service.recordPasswordSet(user, 'invite', CHANGE)).resolves.toBeUndefined();
  });

  it('passes any other failure through', async () => {
    const failure = new Error('connection lost');
    const { service } = recorder(async () => { throw failure; });
    await expect(service.recordPasswordSet(user, 'invite', CHANGE)).rejects.toBe(failure);
  });
});

describe('passwordSetRowId', () => {
  it('is a UUID, the same for the same user and change, and another for any other', () => {
    const id = passwordSetRowId(user.id, 'change-1');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(passwordSetRowId(user.id, 'change-1')).toBe(id);
    expect(passwordSetRowId(user.id, 'change-2')).not.toBe(id);
    expect(passwordSetRowId('someone-else', 'change-1')).not.toBe(id);
  });
});
