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
 *   granted the company and the row's category, or as its holder while
 *   unbatched (a super_admin holder of an ungranted company's row reads none).
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
 * The rows the reader may read, as a predicate on `fuel_rows` under `alias`:
 * PR A's `fuel_rows_select_scoped`, row for row — its company's scope, its
 * holder's while unbatched, and a standard user's own batch's.
 */
export function fuelRowScopeSql(user: RequestUser, alias = 'r'): Prisma.Sql {
  const column = (name: string) => Prisma.raw(`"${alias}"."${name}"`);
  const organisation = Prisma.sql`${column('organisation_id')} = ${user.organisationId}::uuid`;
  if (readsWholeOrganisation(user)) return organisation;
  // Its holder reads an unbatched row with no company; one with a company
  // only as a standard user (D14's "or as its holder") — never a super_admin,
  // whose company rows are its grant's alone. PR A's RLS policy holds the same
  // (`fuel_rows_select_scoped`; WP9 PR B review, P2).
  const holderReads = can(user.role, 'scope.categories')
    ? Prisma.sql`true`
    : Prisma.sql`${column('subsidiary_id')} IS NULL`;
  const holder = Prisma.sql`(${column('holder_id')} = ${user.id}::uuid AND ${column('fuel_batch_id')} IS NULL AND ${holderReads})`;
  // A row in a batch is read exactly when its batch is: a standard user reads
  // its own batch in a company it is still granted, in any category (D14, as
  // `fuel_rows_select_scoped`), so a category untick never hides that batch's
  // rows from its counts while the batch itself stays open to it (second
  // review of the branch, P2). A super_admin's batches are its grant's (above).
  const companies = user.accessibleSubsidiaryIds;
  const ownBatch =
    can(user.role, 'scope.categories') && companies.length > 0
      ? Prisma.sql` OR (${column('fuel_batch_id')} IS NOT NULL AND ${column('subsidiary_id')} = ANY(${companies}::uuid[])
          AND EXISTS (SELECT 1 FROM fuel_batches own WHERE own.id = ${column('fuel_batch_id')} AND own.created_by = ${user.id}::uuid))`
      : Prisma.empty;
  return Prisma.sql`(${organisation} AND (${holder} OR (${column('subsidiary_id')} IS NOT NULL AND ${grantedRowSql(user, alias)})${ownBatch}))`;
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
