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
const SUB = '22222222-2222-4222-8222-222222222222';

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

const INVITE = { email: 'new@tonyai.test', fullName: 'New', role: UserRole.data_entry, language: 'en' as const, subsidiaryIds: [] };

describe('AccessAdminService — LP4-01 refusals before the database is touched', () => {
  it.each(['consultant', 'data_entry', 'executive_viewer'] as const)('a %s invites, disables, enables or re-sends nothing', async (role) => {
    const { prisma, service } = setup();
    await expect(service.inviteMember(user(role), INVITE)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.disableMember(user(role), 'p')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.enableMember(user(role), 'p')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.reopenInvitation(user(role), 'p')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.replaceSubsidiaryAccess(user(role), 'p', [])).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('nobody disables their own account (so the actor always stays an active super_admin) — in any spelling of the id', async () => {
    const { prisma, service } = setup();
    await expect(service.disableMember(user('super_admin'), 'actor')).rejects.toMatchObject({ response: { code: 'own_account_forbidden' } });
    await expect(service.disableMember(user('super_admin'), 'ACTOR')).rejects.toMatchObject({ response: { code: 'own_account_forbidden' } });
    await expect(service.setRole(user('super_admin'), 'ACTOR', UserRole.consultant)).rejects.toMatchObject({ response: { code: 'own_account_forbidden' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('an invitation with grants for an organisation-wide role, an unknown role or language is refused', async () => {
    const { prisma, service } = setup();
    await expect(service.inviteMember(user('super_admin'), { ...INVITE, role: UserRole.consultant, subsidiaryIds: ['s'] })).rejects.toMatchObject({
      response: { code: 'access_role_mismatch' },
    });
    await expect(service.inviteMember(user('super_admin'), { ...INVITE, role: 'platform_admin' as UserRole })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.inviteMember(user('super_admin'), { ...INVITE, language: 'de' as 'en' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
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

describe('AccessAdminService — every lookup is bounded by the actor\'s organisation', () => {
  // The composite keys would refuse a cross-organisation grant anyway, and with
  // the same 404 — but only after trying it, which a caller can time
  // (`qa-auditor` round 2 measured ~1 ms). The bound must be in the lookup.
  function txStub(found: { subsidiary?: unknown; member?: unknown }) {
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      profile: {
        findUnique: vi.fn(async () => ({ role: 'super_admin', organisationId: ORG })),
        findFirst: vi.fn(async () => found.member ?? null),
      },
      subsidiary: { findFirst: vi.fn(async () => found.subsidiary ?? null) },
      userSubsidiaryAccess: { findUnique: vi.fn(), create: vi.fn() },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const service = new AccessAdminService(prisma as unknown as PrismaService, { record: vi.fn() } as unknown as AuditService);
    return { tx, service };
  }

  it("a grant looks the subsidiary up within the actor's organisation, and never writes on a miss", async () => {
    const { tx, service } = txStub({ member: { id: 'p', role: 'data_entry' } });
    await expect(service.grantSubsidiaryAccess(user('super_admin'), 'p', 'foreign-subsidiary')).rejects.toThrow(
      'Subsidiary not found',
    );
    expect(tx.subsidiary.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'foreign-subsidiary', organisationId: ORG } }),
    );
    expect(tx.userSubsidiaryAccess.create).not.toHaveBeenCalled();
  });

  it("the target profile is looked up within the actor's organisation", async () => {
    const { tx, service } = txStub({});
    await expect(service.setRole(user('super_admin'), 'foreign-profile', UserRole.consultant)).rejects.toThrow(
      'User not found',
    );
    expect(tx.profile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'foreign-profile', organisationId: ORG } }),
    );
  });
});

describe('tenantAdminLockKey', () => {
  it('is stable for an organisation and differs between organisations', () => {
    expect(tenantAdminLockKey(ORG)).toBe(tenantAdminLockKey(ORG));
    // Any spelling of one organisation's id reaches the same lock (the operator CLI, the API).
    const lettered = 'abcdef12-3456-4789-8abc-def012345678';
    expect(tenantAdminLockKey(lettered.toUpperCase())).toBe(tenantAdminLockKey(lettered));
    expect(tenantAdminLockKey(ORG)).not.toBe(tenantAdminLockKey('22222222-2222-4222-8222-222222222222'));
    expect(Number.isInteger(tenantAdminLockKey(ORG))).toBe(true);
  });
});

/**
 * Self-service registration's write, DB-free: what is written, in one
 * transaction, and what the audit rows hold. The grants, the cooldown claim
 * and the unique index are proven on PostgreSQL in
 * test/int/registration.int.spec.ts.
 */
describe('AccessAdminService.registerOrganisation — self-service registration', () => {
  const INPUT = {
    email: '  Ada@Example.test ',
    fullName: ' Ada Yilmaz ',
    jobTitle: ' Sustainability Manager ',
    companyName: ' Example Holding ',
    language: 'tr' as const,
    consentVersion: 'placeholder-1',
  };

  function registrationSetup(options: { taken?: boolean; failAt?: 'organisation' | 'subsidiary' | 'profile' | 'invitation' | 'consent' | 'audit' } = {}) {
    const writes: { model: string; data: Record<string, unknown> }[] = [];
    const audits: Record<string, unknown>[] = [];
    let committed = false;
    const create = (model: string, result: object = {}) => vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (options.failAt === model) throw new Error(`${model} failed`);
      writes.push({ model, data });
      return result;
    });
    const tx = {
      profile: { findUnique: vi.fn(async () => (options.taken ? { id: 'someone' } : null)), create: create('profile') },
      organisation: { create: create('organisation', { id: ORG }) },
      subsidiary: { create: create('subsidiary', { id: SUB }) },
      invitation: { create: create('invitation') },
      consent: { create: create('consent') },
    };
    const prisma = {
      $transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => {
        const result = await run(tx);
        committed = true;
        return result;
      }),
    };
    const audit = {
      record: vi.fn(),
      recordSystem: vi.fn(async (entry: Record<string, unknown>, writer: unknown) => {
        if (options.failAt === 'audit') throw new Error('audit failed');
        expect(writer).toBe(tx); // in the same transaction as the rows
        audits.push(entry);
      }),
    };
    const service = new AccessAdminService(prisma as unknown as PrismaService, audit as unknown as AuditService);
    return { service, tx, prisma, audit, writes, audits, committed: () => committed };
  }

  it('writes the organisation, its default subsidiary, its first super_admin, the invitation and the consent in one transaction', async () => {
    const { service, tx, prisma, writes } = registrationSetup();
    const result = await service.registerOrganisation(INPUT);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.profile.findUnique).toHaveBeenCalledWith({ where: { email: 'ada@example.test' }, select: { id: true } });
    const byModel = Object.fromEntries(writes.map((w) => [w.model, w.data]));
    expect(byModel.organisation).toEqual({ legalName: 'Example Holding', country: 'TR', geographyCode: 'TR', reportingCurrency: 'TRY' });
    // K1: the company itself, as its one subsidiary — a facility can be added at once.
    expect(byModel.subsidiary).toEqual({
      organisationId: ORG,
      legalName: 'Example Holding',
      tradingName: null,
      sector: null,
      geographyCode: 'TR',
      reportingStatus: 'pending',
      includedScopes: [1, 2],
      trackingGranularity: 'subsidiary',
    });
    expect(byModel.profile).toEqual({
      id: result.profileId,
      email: 'ada@example.test',
      fullName: 'Ada Yilmaz',
      jobTitle: 'Sustainability Manager',
      role: UserRole.super_admin,
      language: 'tr',
      organisationId: ORG,
    });
    expect(byModel.invitation).toEqual({ profileId: result.profileId, language: 'tr', invitedBy: null });
    expect(byModel.consent).toEqual({ profileId: result.profileId, kind: 'kvkk_registration', textVersion: 'placeholder-1', language: 'tr' });
    expect(result.organisationId).toBe(ORG);
    expect(writes.map((w) => w.model)).toEqual(['organisation', 'subsidiary', 'profile', 'invitation', 'consent']);
  });

  it('audits the organisation, its subsidiary, the invitation and the consent with no actor — and no name, address, job title or company in any row', async () => {
    const { service, audit, audits } = registrationSetup();
    const { profileId } = await service.registerOrganisation(INPUT);
    expect(audit.record).not.toHaveBeenCalled(); // there is no actor to record as
    expect(audits.map((a) => [a.action, a.entity, a.entityId])).toEqual([
      ['create', 'organisation', ORG],
      ['create', 'subsidiary', SUB],
      ['invite', 'invitation', profileId],
      ['create', 'consent', profileId],
    ]);
    for (const row of audits) {
      expect(row.organisationId).toBe(ORG);
      expect((row.diff as { source: string }).source).toBe('auth:registration');
    }
    expect(audits[1].diff).toMatchObject({ default: true, geographyCode: 'TR' });
    expect(audits[3].diff).toMatchObject({ kind: 'kvkk_registration', textVersion: 'placeholder-1' });
    const trail = JSON.stringify(audits).toLowerCase();
    for (const personal of ['ada', 'yilmaz', 'example.test', 'sustainability', 'example holding']) {
      expect(trail, personal).not.toContain(personal);
    }
  });

  it('refuses an address that already has a profile, writing nothing (D17)', async () => {
    const { service, writes, audits } = registrationSetup({ taken: true });
    await expect(service.registerOrganisation(INPUT)).rejects.toMatchObject({ response: { code: 'email_unavailable' } });
    expect(writes).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('reads a unique-index race as the same refusal', async () => {
    const { service, tx } = registrationSetup();
    const { Prisma } = await import('@tonyai/db');
    tx.profile.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    await expect(service.registerOrganisation(INPUT)).rejects.toMatchObject({ response: { code: 'email_unavailable' } });
  });

  it.each(['organisation', 'subsidiary', 'profile', 'invitation', 'consent', 'audit'] as const)('a failure at the %s step leaves the transaction uncommitted', async (failAt) => {
    const { service, committed } = registrationSetup({ failAt });
    await expect(service.registerOrganisation(INPUT)).rejects.toThrow(`${failAt} failed`);
    expect(committed()).toBe(false);
  });

  it('refuses a language the product does not speak before the database is touched', async () => {
    const { service, prisma } = registrationSetup();
    await expect(service.registerOrganisation({ ...INPUT, language: 'de' as 'en' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('inviteMember — refusals audited and bounded (pre-g5-security-hardening)', () => {
  const NOW = new Date('2026-11-24T10:00:00.000Z');
  /** A transaction client for one invitation: the actor is an active super_admin of ORG. */
  function invitation(options: { refusals?: number; taken?: boolean; insertRace?: boolean } = {}) {
    const audit = { record: vi.fn(async () => undefined) };
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => [{ now: NOW }]),
      auditLog: {
        aggregate: vi.fn(async () => ({ _count: options.refusals ?? 0, _min: { createdAt: new Date(NOW.getTime() - 10 * 60_000) } })),
      },
      profile: {
        findUnique: vi.fn(async (args: { where: { id?: string; email?: string } }) =>
          args.where.id === 'actor'
            ? { role: UserRole.super_admin, organisationId: ORG, disabledAt: null, organisation: { offboardedAt: null } }
            : options.taken ? { id: 'someone' } : null),
        create: vi.fn(async () => {
          if (options.insertRace) {
            const { Prisma } = await import('@tonyai/db');
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
          }
          return {};
        }),
      },
      subsidiary: { count: vi.fn(async () => 0) },
      invitation: { create: vi.fn(async () => ({})) },
      userSubsidiaryAccess: { createMany: vi.fn(async () => ({ count: 0 })) },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
    const service = new AccessAdminService(prisma as unknown as PrismaService, audit as unknown as AuditService);
    return { audit, tx, prisma, service };
  }
  const refusalRows = (audit: { record: ReturnType<typeof vi.fn> }) =>
    audit.record.mock.calls.filter((c) => (c[1] as { action: string }).action === 'invite_refused');

  it('a taken address answers email_unavailable, creates nothing, and audits the refusal without the address', async () => {
    const { audit, tx, service } = invitation({ taken: true });
    await expect(service.inviteMember(user('super_admin'), INVITE)).rejects.toMatchObject({ response: { code: 'email_unavailable' } });
    expect(tx.profile.create).not.toHaveBeenCalled();
    expect(tx.invitation.create).not.toHaveBeenCalled();
    const rows = refusalRows(audit);
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toEqual({ action: 'invite_refused', entity: 'invitation', entityId: null, diff: { reason: 'email_unavailable' } });
    // On the transaction, so it commits with nothing else.
    expect(rows[0][2]).toBe(tx);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(INVITE.email);
  });

  it('a new address is invited as before, with no refusal row', async () => {
    const { audit, tx, service } = invitation();
    await expect(service.inviteMember(user('super_admin'), INVITE)).resolves.toMatchObject({ profileId: expect.any(String) });
    expect(tx.profile.create).toHaveBeenCalledTimes(1);
    expect(refusalRows(audit)).toHaveLength(0);
  });

  it.each([false, true])('at five refusals within the hour, every invitation is refused 429 before the lookup (taken: %s)', async (taken) => {
    const { audit, tx, service } = invitation({ refusals: 5, taken });
    const refusal = await service.inviteMember(user('super_admin'), INVITE).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ status: 429, response: { code: 'invite_refusals_exhausted' } });
    // The same answer, whatever the address: it was never looked up.
    expect(tx.profile.findUnique.mock.calls.filter((c) => c[0].where.email !== undefined)).toHaveLength(0);
    expect(tx.profile.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    // A retry hint: until the oldest refusal of the hour (ten minutes old) ages out.
    expect((refusal as { retryAfter: number }).retryAfter).toBe(50 * 60);
  });

  it('below the bound, the count is read for this organisation and the last hour on the database clock', async () => {
    const { tx, service } = invitation({ refusals: 4 });
    await service.inviteMember(user('super_admin'), INVITE);
    expect((tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray])[0].join('?')).toBe('SELECT now() AS now');
    expect(tx.auditLog.aggregate).toHaveBeenCalledWith({
      where: { organisationId: ORG, action: 'invite_refused', createdAt: { gt: new Date(NOW.getTime() - 3_600_000) } },
      _count: true,
      _min: { createdAt: true },
    });
  });

  it('an insert that loses the race when another request used the last refusal meanwhile answers the bound, and writes nothing (Codex review)', async () => {
    const { audit, tx, service } = invitation({ insertRace: true });
    tx.auditLog.aggregate
      .mockResolvedValueOnce({ _count: 4, _min: { createdAt: new Date(NOW.getTime() - 10 * 60_000) } })
      .mockResolvedValueOnce({ _count: 5, _min: { createdAt: new Date(NOW.getTime() - 10 * 60_000) } });
    await expect(service.inviteMember(user('super_admin'), INVITE)).rejects.toMatchObject({ status: 429, response: { code: 'invite_refusals_exhausted' } });
    expect(refusalRows(audit)).toHaveLength(0);
  });

  it('an insert that loses the race for the address is the same refusal, audited in its own transaction', async () => {
    const { audit, prisma, service } = invitation({ insertRace: true });
    await expect(service.inviteMember(user('super_admin'), INVITE)).rejects.toMatchObject({ response: { code: 'email_unavailable' } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(refusalRows(audit)).toHaveLength(1);
  });
});
