import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditService } from './audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';

function createPrismaMock() {
  return { auditLog: { create: vi.fn().mockResolvedValue({}) } };
}

function makeUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-1',
    email: 'admin@tonyai.local',
    role: 'super_admin',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1'],
    ...overrides,
  };
}

describe('AuditService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: AuditService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new AuditService(prisma as unknown as PrismaService);
  });

  it('stamps the actor id, role and organisation on every row', async () => {
    await service.record(makeUser(), {
      action: 'create',
      entity: 'subsidiary',
      entityId: 'sub-9',
      diff: { after: { id: 'sub-9' } },
    });

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      userId: 'user-1',
      role: 'super_admin',
      organisationId: 'org-1',
      action: 'create',
      entity: 'subsidiary',
      entityId: 'sub-9',
    });
  });

  it('records the role the actor held AT THE TIME, not a lookup', async () => {
    // Roles change; an audit trail that re-derived the role at read time would
    // misstate who was allowed to do what.
    await service.record(makeUser({ role: 'consultant' }), {
      action: 'reject',
      entity: 'activity_record',
      entityId: 'rec-1',
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data.role).toBe('consultant');
  });

  it('accepts a null entityId (report generation has no persisted row)', async () => {
    await service.record(makeUser(), {
      action: 'generate',
      entity: 'report',
      entityId: null,
      diff: { template: 'executive_summary' },
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      entity: 'report',
      entityId: null,
    });
  });

  it('writes through the transaction client when one is passed', async () => {
    // Auditing inside the mutation's transaction is what stops a crash between
    // the two from losing the audit row.
    const tx = { auditLog: { create: vi.fn().mockResolvedValue({}) } };
    await service.record(
      makeUser(),
      { action: 'lock', entity: 'period_lock', entityId: 'pl-1' },
      tx as never,
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('carries a null organisation through rather than inventing one', async () => {
    // A privileged profile with no organisation is already default-denied by the
    // guard; the audit row must not fabricate a tenant to make it readable.
    await service.record(makeUser({ organisationId: null }), {
      action: 'delete',
      entity: 'target',
      entityId: 't-1',
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data.organisationId).toBeNull();
  });

  it('normalises a missing diff to null instead of undefined', async () => {
    await service.record(makeUser(), {
      action: 'unlock',
      entity: 'period_lock',
      entityId: 'pl-2',
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data.diff).toBeNull();
  });

  it('exposes no update or delete path (audit_log is append-only)', () => {
    // Guards the CLAUDE.md rule at the type/shape level: if someone adds a
    // mutating method here, this fails and forces the conversation.
    const methods = Object.getOwnPropertyNames(AuditService.prototype).filter(
      (m) => m !== 'constructor',
    );
    expect(methods).toEqual(['record']);
  });
});
