import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import { createDefaultSubsidiary } from './default-subsidiary';

// DB-free: what the default subsidiary is written with and what its audit row
// holds. The rows on PostgreSQL are proven in test/int/registration.int.spec.ts
// and test/int/onboarding.int.spec.ts.

const ORG = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';

function setup(failAt?: 'subsidiary' | 'audit') {
  const tx = {
    subsidiary: {
      create: vi.fn(async () => {
        if (failAt === 'subsidiary') throw new Error('subsidiary failed');
        return { id: SUB };
      }),
    },
    auditLog: { create: vi.fn() },
  };
  const audit = {
    recordSystem: vi.fn(async (_entry: Record<string, unknown>, writer: unknown) => {
      if (failAt === 'audit') throw new Error('audit failed');
      expect(writer).toBe(tx); // in the caller's transaction
    }),
  };
  return { tx, audit };
}

const INPUT = {
  organisationId: ORG,
  legalName: 'Örnek Gıda A.Ş.',
  tradingName: 'Örnek',
  sector: 'Food',
  geographyCode: 'TR',
  source: { source: 'auth:registration' },
};

describe('createDefaultSubsidiary (UAT round 2, K1)', () => {
  it('writes the subsidiary with the parent company name, its geography and explicit settings', async () => {
    const { tx, audit } = setup();
    await expect(createDefaultSubsidiary(tx as never, audit as unknown as AuditService, INPUT)).resolves.toEqual({ id: SUB });
    expect(tx.subsidiary.create).toHaveBeenCalledTimes(1);
    expect(tx.subsidiary.create).toHaveBeenCalledWith({
      data: {
        organisationId: ORG,
        legalName: 'Örnek Gıda A.Ş.',
        tradingName: 'Örnek',
        sector: 'Food',
        geographyCode: 'TR',
        reportingStatus: 'pending',
        includedScopes: [1, 2],
        trackingGranularity: 'subsidiary',
      },
      select: { id: true },
    });
  });

  it('writes null trading name and sector when none is given', async () => {
    const { tx, audit } = setup();
    await createDefaultSubsidiary(tx as never, audit as unknown as AuditService, {
      organisationId: ORG,
      legalName: 'Solo',
      geographyCode: 'TR',
      source: { source: 'auth:registration' },
    });
    const call = tx.subsidiary.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(call[0].data.tradingName).toBeNull();
    expect(call[0].data.sector).toBeNull();
  });

  it('audits one system row naming the source, with no name, trading name or sector', async () => {
    const { tx, audit } = setup();
    await createDefaultSubsidiary(tx as never, audit as unknown as AuditService, {
      ...INPUT,
      source: { operator: 'ops@tonyai.test', source: 'onboarding:provision' },
    });
    expect(audit.recordSystem).toHaveBeenCalledTimes(1);
    const [entry] = audit.recordSystem.mock.calls[0];
    expect(entry).toEqual({
      organisationId: ORG,
      action: 'create',
      entity: 'subsidiary',
      entityId: SUB,
      diff: {
        operator: 'ops@tonyai.test',
        source: 'onboarding:provision',
        default: true,
        geographyCode: 'TR',
        includedScopes: [1, 2],
        trackingGranularity: 'subsidiary',
        reportingStatus: 'pending',
      },
    });
    const text = JSON.stringify(entry);
    for (const secret of ['Örnek', 'Food']) expect(text).not.toContain(secret);
  });

  it('writes no audit row when the insert fails', async () => {
    const { tx, audit } = setup('subsidiary');
    await expect(createDefaultSubsidiary(tx as never, audit as unknown as AuditService, INPUT)).rejects.toThrow('subsidiary failed');
    expect(audit.recordSystem).not.toHaveBeenCalled();
  });

  it('rejects when the audit row fails, so the caller\'s transaction rolls back', async () => {
    const { tx, audit } = setup('audit');
    await expect(createDefaultSubsidiary(tx as never, audit as unknown as AuditService, INPUT)).rejects.toThrow('audit failed');
  });
});
