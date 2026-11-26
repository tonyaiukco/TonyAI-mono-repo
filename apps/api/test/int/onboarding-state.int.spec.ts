import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserRole } from '@tonyai/db';
import { AuditService } from '../../src/audit/audit.service';
import { OrganisationService } from '../../src/organisation/organisation.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { addMember, connect, connectOwner, createTenant, type Tenant } from './db';

/**
 * The setup state on the real database (inc26-central-reporter-onboarding,
 * task 7.4): a new organisation is unfinished, and two masterkeys finishing
 * at once set it once, with one audit row.
 */

let owner: PrismaService;
let tenant: Tenant;

beforeAll(() => {
  owner = connectOwner();
});
afterAll(async () => {
  await owner.$disconnect();
});
beforeEach(async () => {
  tenant = await createTenant();
});
afterEach(async () => {
  await tenant?.cleanup();
});

describe('POST /organisation/onboarding/complete on the database', () => {
  it('an organisation created now is unfinished; two masterkeys finishing at once set it once, with one audit row', async () => {
    expect((await owner.organisation.findUniqueOrThrow({ where: { id: tenant.organisationId } })).onboardingCompletedAt).toBeNull();
    const second = await addMember(owner, tenant, UserRole.masterkey);
    const a = connect();
    const b = connect();
    try {
      const [first, other] = await Promise.all([
        new OrganisationService(a, new AuditService(a)).completeOnboarding(tenant.users.masterkey),
        new OrganisationService(b, new AuditService(b)).completeOnboarding(second),
      ]);
      expect(first.onboardingCompletedAt).not.toBeNull();
      expect(other.onboardingCompletedAt).toBe(first.onboardingCompletedAt);
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
    const rows = await owner.auditLog.findMany({ where: { organisationId: tenant.organisationId, entity: 'organisation', action: 'update' } });
    expect(rows).toHaveLength(1);
    const stored = await owner.organisation.findUniqueOrThrow({ where: { id: tenant.organisationId } });
    expect(stored.onboardingCompletedAt).not.toBeNull();
  });
});
