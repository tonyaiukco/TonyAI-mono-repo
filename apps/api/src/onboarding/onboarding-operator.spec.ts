import { InvitationStatus, UserRole } from '@tonyai/db';
import { describe, expect, it, vi } from 'vitest';
import type { AuthSyncService } from '../users/auth-sync.service';
import type { InvitationDeliveryService } from '../users/invitation-delivery.service';
import { OnboardingOperator } from './onboarding-operator';

const ORG = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';

/** An owner connection whose every table belongs to the login — the owner check passes. */
function ownerDb(invitationUpdates: number) {
  const tx = {
    invitation: { updateMany: vi.fn(async () => ({ count: invitationUpdates })) },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    db: {
      $queryRaw: vi.fn(async () => [{ relname: 'invitations', owner: 'postgres', login: 'postgres', acting: 'postgres' }]),
      profile: {
        findUnique: vi.fn(async () => ({
          id: ADMIN,
          role: UserRole.super_admin,
          organisationId: ORG,
          organisation: { id: ORG, legalName: 'Org', offboardedAt: null },
          invitation: { status: InvitationStatus.sent },
        })),
      },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
}

describe('OnboardingOperator.provision — re-sending an unaccepted invitation (R2)', () => {
  const input = { organisationId: ORG, adminEmail: 'admin@org.test', adminName: 'A', language: 'en' as const };

  it('re-opens a sent invitation, audits it with the operator, and delivers', async () => {
    const { db, tx } = ownerDb(1);
    const deliver = vi.fn(async () => ({ delivered: true as const }));
    const operator = new OnboardingOperator(db as never, 'ops@x.io', { deliver } as unknown as InvitationDeliveryService, {} as AuthSyncService);
    const report = await operator.provision(input, true);
    expect(report).toMatchObject({ resent: true, delivery: { delivered: true } });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: null, action: 'invite', diff: expect.objectContaining({ resend: true, operator: 'ops@x.io' }) }),
    }));
    expect(deliver).toHaveBeenCalledOnce();
    // Only a still-sent invitation is re-opened: one accepted since the read stays accepted.
    expect(tx.invitation.updateMany).toHaveBeenCalledWith({ where: { profileId: ADMIN, status: InvitationStatus.sent }, data: { status: InvitationStatus.pending } });
  });

  it('a dry run says whether --apply would re-send, and changes nothing', async () => {
    const { db, tx } = ownerDb(1);
    const deliver = vi.fn();
    const operator = new OnboardingOperator(db as never, 'ops@x.io', { deliver } as unknown as InvitationDeliveryService, {} as AuthSyncService);
    expect(await operator.provision(input, false)).toMatchObject({ applied: false, resent: true, delivery: null });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.invitation.updateMany).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('says nothing was re-sent, and sends nothing, when the invitation was accepted or revoked meanwhile', async () => {
    const { db, tx } = ownerDb(0);
    const deliver = vi.fn();
    const operator = new OnboardingOperator(db as never, 'ops@x.io', { deliver } as unknown as InvitationDeliveryService, {} as AuthSyncService);
    const report = await operator.provision(input, true);
    expect(report).toMatchObject({ resent: false, delivery: null });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});

/** An owner connection with no profile for the address: a first provisioning. */
function newAddressDb() {
  const SUB = '33333333-3333-4333-8333-333333333333';
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    organisation: {
      create: vi.fn(async () => ({ id: ORG })),
      findUniqueOrThrow: vi.fn(async () => ({ offboardedAt: null })),
    },
    subsidiary: { create: vi.fn(async () => ({ id: SUB })) },
    profile: { create: vi.fn() },
    invitation: { create: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    SUB,
    tx,
    db: {
      $queryRaw: vi.fn(async () => [{ relname: 'invitations', owner: 'postgres', login: 'postgres', acting: 'postgres' }]),
      profile: { findUnique: vi.fn(async () => null) },
      organisation: { findUnique: vi.fn(async () => ({ offboardedAt: null })) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
}

describe('OnboardingOperator.provision — the default subsidiary (UAT round 2, K1)', () => {
  const NEW = {
    organisation: { legalName: 'Örnek Gıda A.Ş.', tradingName: 'Örnek', country: 'TR', geographyCode: 'TR', reportingCurrency: 'TRY', sector: 'Food' },
    adminEmail: 'admin@ornek.test',
    adminName: 'Ayşe',
    language: 'tr' as const,
  };
  const delivered = () => ({ deliver: vi.fn(async () => ({ delivered: true as const })) }) as unknown as InvitationDeliveryService;

  it('creates it with a new organisation, in the same transaction, named and placed like the organisation', async () => {
    const { db, tx, SUB } = newAddressDb();
    const operator = new OnboardingOperator(db as never, 'ops@x.io', delivered(), {} as AuthSyncService);
    const report = await operator.provision(NEW, true);
    expect(report).toMatchObject({ applied: true, organisation: { id: ORG, created: true }, subsidiary: { id: SUB, created: true } });
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(tx.subsidiary.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organisationId: ORG, legalName: 'Örnek Gıda A.Ş.', tradingName: 'Örnek', sector: 'Food', geographyCode: 'TR',
        includedScopes: [1, 2], trackingGranularity: 'subsidiary', reportingStatus: 'pending',
      }),
      select: { id: true },
    });
    const audits = tx.auditLog.create.mock.calls.map((c) => (c as unknown as [{ data: { entity: string; userId: null; diff: Record<string, unknown> } }])[0].data);
    expect(audits.map((a) => a.entity)).toEqual(['organisation', 'subsidiary', 'invitation']);
    const row = audits[1];
    expect(row.userId).toBeNull();
    expect(row.diff).toMatchObject({ operator: 'ops@x.io', source: 'onboarding:provision', default: true, geographyCode: 'TR' });
    expect(JSON.stringify(row.diff)).not.toContain('Örnek');
  });

  it('a dry run says --apply would create it, and writes nothing', async () => {
    const { db, tx } = newAddressDb();
    const operator = new OnboardingOperator(db as never, 'ops@x.io', delivered(), {} as AuthSyncService);
    expect(await operator.provision(NEW, false)).toMatchObject({ applied: false, subsidiary: { id: null, created: true } });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.subsidiary.create).not.toHaveBeenCalled();
  });

  it('adds none when an administrator is added to an existing organisation — applied or dry run', async () => {
    const input = { organisationId: ORG, adminEmail: 'second@ornek.test', adminName: 'B', language: 'en' as const };
    for (const apply of [false, true]) {
      const { db, tx } = newAddressDb();
      const operator = new OnboardingOperator(db as never, 'ops@x.io', delivered(), {} as AuthSyncService);
      expect(await operator.provision(input, apply)).toMatchObject({ applied: apply, organisation: { id: ORG, created: false }, subsidiary: { id: null, created: false } });
      expect(tx.organisation.create).not.toHaveBeenCalled();
      expect(tx.subsidiary.create).not.toHaveBeenCalled();
    }
  });

  it('adds none on a re-run for an address already provisioned', async () => {
    const { db } = ownerDb(1);
    const operator = new OnboardingOperator(db as never, 'ops@x.io', delivered(), {} as AuthSyncService);
    const report = await operator.provision({ organisationId: ORG, adminEmail: 'admin@org.test', adminName: 'A', language: 'en' }, true);
    expect(report).toMatchObject({ resent: true, subsidiary: { id: null, created: false } });
  });

  it('stores nothing when the subsidiary cannot be written: the transaction rejects', async () => {
    const { db, tx } = newAddressDb();
    tx.subsidiary.create.mockRejectedValue(new Error('subsidiary failed'));
    const deliver = vi.fn();
    const operator = new OnboardingOperator(db as never, 'ops@x.io', { deliver } as unknown as InvitationDeliveryService, {} as AuthSyncService);
    await expect(operator.provision(NEW, true)).rejects.toThrow('subsidiary failed');
    expect(tx.profile.create).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});
