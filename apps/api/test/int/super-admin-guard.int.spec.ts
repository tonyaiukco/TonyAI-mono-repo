import { randomUUID } from 'node:crypto';
import { UserRole } from '@tonyai/db';
import { afterAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { connectOwner, TENANT_ORG_PREFIX, withRollback } from './db';

// inc26-roles-approval-chain (owner's review, P1): a super_admin presupposes its
// organisation's masterkey. The database refuses anything else — the previous
// API image, live between the migration and the rollout, would otherwise create
// a registration's first administrator as `super_admin` (its name for the
// organisation-wide role) in an organisation with no masterkey. Every write is
// rolled back.
const owner: PrismaService = connectOwner();
afterAll(() => owner.$disconnect());

const organisation = (tx: Parameters<Parameters<typeof withRollback>[1]>[0]) =>
  tx.organisation.create({ data: { legalName: `${TENANT_ORG_PREFIX}guard ${randomUUID().slice(0, 8)}`, country: 'GB', geographyCode: 'UK' } });
const profile = (organisationId: string, role: UserRole) => ({
  id: randomUUID(),
  email: `int-guard-${randomUUID().slice(0, 8)}@tonyai.test`,
  fullName: 'Int guard',
  role,
  organisationId,
});

describe('profiles_super_admin_needs_masterkey', () => {
  it('refuses a super_admin in an organisation with no masterkey — the deploy window\'s registration', async () => {
    await expect(
      withRollback(owner, async (tx) => {
        const org = await organisation(tx);
        await tx.profile.create({ data: profile(org.id, UserRole.super_admin) });
      }),
    ).rejects.toThrow(/A super_admin needs a masterkey in its organisation/);
  });

  it('refuses a role change to super_admin in an organisation with no masterkey', async () => {
    await expect(
      withRollback(owner, async (tx) => {
        const org = await organisation(tx);
        const auditor = await tx.profile.create({ data: profile(org.id, UserRole.auditor) });
        await tx.profile.update({ where: { id: auditor.id }, data: { role: UserRole.super_admin } });
      }),
    ).rejects.toThrow(/A super_admin needs a masterkey in its organisation/);
  });

  it('accepts a super_admin once the organisation has a masterkey, and a masterkey may not count itself', async () => {
    const counted = await withRollback(owner, async (tx) => {
      const org = await organisation(tx);
      await tx.profile.create({ data: profile(org.id, UserRole.masterkey) });
      await tx.profile.create({ data: profile(org.id, UserRole.super_admin) });
      return tx.profile.count({ where: { organisationId: org.id } });
    });
    expect(counted).toBe(2);
  });

  it('does not stand in the way of an organisation\'s delete (its profiles leave it)', async () => {
    await withRollback(owner, async (tx) => {
      const org = await organisation(tx);
      await tx.profile.create({ data: profile(org.id, UserRole.masterkey) });
      await tx.profile.create({ data: profile(org.id, UserRole.super_admin) });
      await tx.organisation.delete({ where: { id: org.id } });
    });
  });
});
