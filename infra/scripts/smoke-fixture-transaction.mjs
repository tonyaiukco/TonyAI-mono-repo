/** Audited synthetic rows shared by hosted and existing smoke launchers. */
import { validateSmoke } from './smoke-contract.mjs';

export async function provisionRows(target, prisma) {
  validateSmoke(target);
  const geographyCode = target.mode === 'staging' ? 'UK' : 'DE';
  await prisma.$transaction(async (tx) => {
    for (const tenant of target.tenants) {
      const mutations = [
        ['organisation', tenant.organisationId, () => tx.organisation.create({ data: {
          id: tenant.organisationId, legalName: tenant.name,
          country: target.mode === 'staging' ? 'UK' : 'DE', geographyCode,
        } })],
        ['subsidiary', tenant.subsidiaryId, () => tx.subsidiary.create({ data: {
          id: tenant.subsidiaryId, organisationId: tenant.organisationId,
          legalName: tenant.name, geographyCode,
        } })],
        ['profile', tenant.userId, () => tx.profile.create({ data: {
          id: tenant.userId, email: tenant.email, fullName: 'LP2 synthetic smoke',
          organisationId: tenant.organisationId, role: 'super_admin',
        } })],
      ];
      for (const [entity, entityId, mutate] of mutations) {
        await mutate();
        await tx.auditLog.create({ data: {
          action: 'create', entity, entityId, organisationId: tenant.organisationId,
          diff: { purpose: 'LP2-02 synthetic staging smoke; no customer inventory' },
        } });
      }
    }
  });
}
