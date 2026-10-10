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
