import type { Prisma } from '@tonyai/db';
import { can } from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { grantedCategories } from '../activity-records/record-scope';

/** The batches a reader may read (D14): the organisation, a granted company, a standard user's category or own batch. */
export function fuelBatchScopeWhere(user: RequestUser): Prisma.FuelBatchWhereInput {
  const organisation: Prisma.FuelBatchWhereInput = { organisationId: user.organisationId ?? '00000000-0000-0000-0000-000000000000' };
  if (can(user.role, 'scope.organisation')) return organisation;
  const companies = user.accessibleSubsidiaryIds;
  if (!can(user.role, 'scope.categories')) return { ...organisation, subsidiaryId: { in: companies } };
  const byGrant: Prisma.FuelBatchWhereInput[] = companies
    .map((subsidiaryId) => ({ subsidiaryId, category: { in: grantedCategories(user, subsidiaryId) } }))
    .filter((w) => (w.category.in as string[]).length > 0);
  return { ...organisation, OR: [...byGrant, { createdBy: user.id, subsidiaryId: { in: companies } }] };
}

