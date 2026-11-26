import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { USER_ROLES, can, type UserRole } from '@tonyai/shared-types';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { makeMasterkey } from '../../test/helpers';
import { UpdateConsolidationApproachDto } from './dto/update-consolidation-approach.dto';
import { OrganisationService } from './organisation.service';

/** The organisation read and its consolidation approach (inc26-group-tree, 5.1). */

const FINISHED = new Date('2026-11-26T12:00:00.000Z');
const ORG = { id: 'org-1', legalName: 'TonyAI Holding A.Ş.', tradingName: null, consolidationApproach: 'operational_control', onboardingCompletedAt: FINISHED as Date | null };
const ORG_DTO = { ...ORG, onboardingCompletedAt: FINISHED.toISOString() };

function build() {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'org-1' }]),
    // The masterkey re-read under the administrative lock (owner's third review of WP7).
    $executeRaw: vi.fn(async () => 1),
    profile: {
      findUnique: vi.fn(async () => ({
        role: 'masterkey', organisationId: 'org-1', disabledAt: null as Date | null, organisation: { offboardedAt: null }, subsidiaryAccess: [],
      })),
    },
    organisation: {
      findUnique: vi.fn(async () => ({ ...ORG })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...ORG, ...data })),
    },
  };
  const prisma = {
    organisation: { findUnique: vi.fn(async () => ({ ...ORG, country: 'TR', offboardedAt: null })) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const audit = { record: vi.fn() };
  const service = new OrganisationService(prisma as unknown as PrismaService, audit as unknown as AuditService);
  return { tx, prisma, audit, service };
}

const as = (role: UserRole) => makeMasterkey({ role, id: `user-${role}` });

describe('OrganisationService', () => {
  let w: ReturnType<typeof build>;
  beforeEach(() => {
    w = build();
  });

  it.each([...USER_ROLES])('lets a %s read its own organisation: id, names and the approach — nothing else', async (role) => {
    expect(await w.service.get(as(role))).toEqual(ORG_DTO);
    expect(w.prisma.organisation.findUnique).toHaveBeenCalledWith({ where: { id: 'org-1' } });
  });

  it('answers a caller with no organisation not found, reading nothing', async () => {
    await expect(w.service.get(makeMasterkey({ organisationId: null }))).rejects.toBeInstanceOf(NotFoundException);
    expect(w.prisma.organisation.findUnique).not.toHaveBeenCalled();
  });

  it('a masterkey changes the approach to financial control, with one audit row holding both values', async () => {
    const dto = await w.service.setConsolidationApproach(as('masterkey'), { consolidationApproach: 'financial_control' });
    expect(dto.consolidationApproach).toBe('financial_control');
    expect(w.tx.organisation.update).toHaveBeenCalledWith({ where: { id: 'org-1' }, data: { consolidationApproach: 'financial_control' } });
    expect(w.audit.record).toHaveBeenCalledTimes(1);
    expect(w.audit.record.mock.calls[0][1]).toEqual({
      action: 'update',
      entity: 'organisation',
      entityId: 'org-1',
      diff: { before: { consolidationApproach: 'operational_control' }, after: { consolidationApproach: 'financial_control' } },
    });
    expect(w.audit.record.mock.calls[0][2]).toBe(w.tx);
  });

  it.each([
    ['demoted', { role: 'auditor' }],
    ['disabled', { disabledAt: new Date() }],
  ])('a masterkey %s while the request waited changes nothing (owner review, P2)', async (_what, over) => {
    w.tx.profile.findUnique.mockResolvedValue({
      role: 'masterkey', organisationId: 'org-1', disabledAt: null, organisation: { offboardedAt: null }, subsidiaryAccess: [], ...over,
    } as never);
    await expect(w.service.setConsolidationApproach(as('masterkey'), { consolidationApproach: 'financial_control' } as never)).rejects.toBeDefined();
    expect(w.tx.organisation.update).not.toHaveBeenCalled();
    expect(w.audit.record).not.toHaveBeenCalled();
    // Re-read under the admin lock, before the organisation row is locked.
    expect(w.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(w.tx.profile.findUnique.mock.invocationCallOrder[0]);
    expect(w.tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('writes and audits nothing when the approach is already the one sent', async () => {
    await w.service.setConsolidationApproach(as('masterkey'), { consolidationApproach: 'operational_control' });
    expect(w.tx.organisation.update).not.toHaveBeenCalled();
    expect(w.audit.record).not.toHaveBeenCalled();
  });

  it.each(USER_ROLES.filter((r) => !can(r, 'consolidation.write')))('refuses a %s as forbidden, before anything is read', async (role) => {
    await expect(
      w.service.setConsolidationApproach(as(role), { consolidationApproach: 'financial_control' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.prisma.$transaction).not.toHaveBeenCalled();
    expect(w.audit.record).not.toHaveBeenCalled();
  });
});

describe('UpdateConsolidationApproachDto', () => {
  const errors = (body: unknown) => validateSync(plainToInstance(UpdateConsolidationApproachDto, body));

  it('accepts the two stored approaches', () => {
    expect(errors({ consolidationApproach: 'operational_control' })).toEqual([]);
    expect(errors({ consolidationApproach: 'financial_control' })).toEqual([]);
  });

  it('refuses equity share — announced, not offered — and anything else as invalid', () => {
    for (const value of ['equity_share', 'Operational_Control', '', null, undefined]) {
      expect(errors({ consolidationApproach: value }), String(value)).not.toEqual([]);
    }
  });
});

describe('OrganisationService.completeOnboarding (inc26-central-reporter-onboarding, task 7.4)', () => {
  let w: ReturnType<typeof build>;
  beforeEach(() => {
    w = build();
    w.tx.organisation.findUnique.mockResolvedValue({ ...ORG, onboardingCompletedAt: null });
  });

  it('a masterkey finishes: the timestamp set under the administrative lock, one audit row', async () => {
    const dto = await w.service.completeOnboarding(as('masterkey'));
    expect(dto.onboardingCompletedAt).toEqual(expect.any(String));
    expect(w.tx.organisation.update).toHaveBeenCalledWith({ where: { id: 'org-1' }, data: { onboardingCompletedAt: expect.any(Date) } });
    expect(w.audit.record).toHaveBeenCalledTimes(1);
    expect(w.audit.record.mock.calls[0][1]).toMatchObject({
      action: 'update', entity: 'organisation', entityId: 'org-1', diff: { before: { onboardingCompletedAt: null } },
    });
    expect(w.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(w.tx.organisation.findUnique.mock.invocationCallOrder[0]);
  });

  it('a second call answers the finished organisation and writes nothing', async () => {
    w.tx.organisation.findUnique.mockResolvedValue({ ...ORG });
    expect(await w.service.completeOnboarding(as('masterkey'))).toEqual(ORG_DTO);
    expect(w.tx.organisation.update).not.toHaveBeenCalled();
    expect(w.audit.record).not.toHaveBeenCalled();
  });

  it('a masterkey disabled while the request waited finishes nothing', async () => {
    w.tx.profile.findUnique.mockResolvedValue({
      role: 'masterkey', organisationId: 'org-1', disabledAt: new Date(), organisation: { offboardedAt: null }, subsidiaryAccess: [],
    } as never);
    await expect(w.service.completeOnboarding(as('masterkey'))).rejects.toBeDefined();
    expect(w.tx.organisation.update).not.toHaveBeenCalled();
  });

  it.each(USER_ROLES.filter((r) => !can(r, 'onboarding.run')))('refuses a %s as forbidden, before anything is read', async (role) => {
    await expect(w.service.completeOnboarding(as(role))).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.prisma.$transaction).not.toHaveBeenCalled();
  });
});
