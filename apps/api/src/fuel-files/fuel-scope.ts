import { Prisma } from '@tonyai/db';
import { can, type Category, type FuelUsage } from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { grantedCategories } from '../activity-records/record-scope';

/**
 * Who reads which fuel rows and accounts (inc28-fuel-bulk D14, C6). The API
 * runs as the runtime role, which bypasses RLS, so this is the filter every
 * fuel read takes; the RLS policies of PR A hold the same matrix for a direct
 * database client. Scope is the reader's CURRENT access: a withdrawn grant
 * closes its rows at once.
 *
 * - masterkey, auditor: every row and account of the organisation.
 * - A row with no company (`waiting_account`): its holder only, besides them.
 * - A row with a company: a super_admin granted the company; a standard user
 *   granted the company and the row's category; its holder while unbatched.
 * - Accounts: a super_admin those mapped or proposed to a granted company; a
 *   standard user none.
 */

/** The category a usage's records are filed under (D6). */
export const usageCategory = (usage: FuelUsage): Extract<Category, 'Mobile Combustion' | 'Fuel'> =>
  usage === 'stationary' ? 'Fuel' : 'Mobile Combustion';

export const readsWholeOrganisation = (user: RequestUser): boolean => can(user.role, 'scope.organisation');

/** Whether the reader may read a company's name: one of its accessible companies. */
export const readsCompany = (user: RequestUser, subsidiaryId: string | null): boolean =>
  subsidiaryId !== null && user.accessibleSubsidiaryIds.includes(subsidiaryId);

/** The rows of a company and category the reader's grant covers (no holder clause). */
function grantedRowSql(user: RequestUser, alias: string): Prisma.Sql {
  const column = (name: string) => Prisma.raw(`"${alias}"."${name}"`);
  const companies = user.accessibleSubsidiaryIds;
  if (companies.length === 0) return Prisma.sql`false`;
  if (!can(user.role, 'scope.categories')) {
    return Prisma.sql`${column('subsidiary_id')} = ANY(${companies}::uuid[])`;
  }
  const byGrant: Prisma.Sql[] = [];
  for (const subsidiaryId of companies) {
    const categories = grantedCategories(user, subsidiaryId);
    if (categories.length === 0) continue;
    byGrant.push(
      Prisma.sql`(${column('subsidiary_id')} = ${subsidiaryId}::uuid AND (CASE WHEN ${column('usage')} = 'stationary' THEN 'Fuel' ELSE 'Mobile Combustion' END) = ANY(${categories}::text[]))`,
    );
  }
  return byGrant.length === 0 ? Prisma.sql`false` : Prisma.sql`(${Prisma.join(byGrant, ' OR ')})`;
}

/**
 * The rows the reader may read, as a predicate on `fuel_rows` under `alias`.
 * A batched row is read here only by its company's scope; a batch's own rows
 * are read through the batch (D10).
 */
export function fuelRowScopeSql(user: RequestUser, alias = 'r'): Prisma.Sql {
  const column = (name: string) => Prisma.raw(`"${alias}"."${name}"`);
  const organisation = Prisma.sql`${column('organisation_id')} = ${user.organisationId}::uuid`;
  if (readsWholeOrganisation(user)) return organisation;
  const holder = Prisma.sql`(${column('holder_id')} = ${user.id}::uuid AND ${column('fuel_batch_id')} IS NULL)`;
  return Prisma.sql`(${organisation} AND (${holder} OR (${column('subsidiary_id')} IS NOT NULL AND ${grantedRowSql(user, alias)})))`;
}

/** The accounts the reader may read, as a predicate on `fuel_accounts` under `alias`; null: none at all. */
export function fuelAccountScopeSql(user: RequestUser, alias = 'a'): Prisma.Sql | null {
  const column = (name: string) => Prisma.raw(`"${alias}"."${name}"`);
  const organisation = Prisma.sql`${column('organisation_id')} = ${user.organisationId}::uuid`;
  if (can(user.role, 'fuel_account.read_all')) return organisation;
  if (!can(user.role, 'fuel_account.confirm_granted')) return null;
  const companies = user.accessibleSubsidiaryIds;
  if (companies.length === 0) return Prisma.sql`false`;
  return Prisma.sql`(${organisation} AND ${column('subsidiary_id')} = ANY(${companies}::uuid[]))`;
}

/** The fuel uploads (imports) whose summary the reader reads: all of them, or its own (D14). */
export function fuelUploadScopeWhere(user: RequestUser): Prisma.ImportBatchWhereInput {
  const where: Prisma.ImportBatchWhereInput = {
    organisationId: user.organisationId ?? '00000000-0000-0000-0000-000000000000',
    source: { not: 'template' },
  };
  return readsWholeOrganisation(user) ? where : { ...where, uploadedBy: user.id };
}
