import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import { can, isCategory, type Category } from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { errorBody } from '../common/api-error';

/**
 * Which activity records a caller reads (inc26-roles-approval-chain, design
 * Decision 6; INC-2.6 §1, §7.3, ruling R5). THE one source of the filter:
 * every read of activity records, and of figures built from them, takes it
 * from here — a read that used `accessibleSubsidiaryIds` alone would show a
 * standard user every category of its company.
 *
 * - A masterkey, an auditor, a super_admin: the records of their companies.
 * - A standard user (`scope.categories`): per granted company, the records of
 *   the categories ticked on that grant; plus, in any granted company, the
 *   records it created — a withdrawn category never orphans its own draft.
 *   With no `categoryGrants` (a hand-built caller), only its own records:
 *   the scope fails closed.
 */
export function recordScopeWhere(user: RequestUser): Prisma.ActivityRecordWhereInput {
  const companies = user.accessibleSubsidiaryIds;
  if (!can(user.role, 'scope.categories')) return { subsidiaryId: { in: companies } };
  if (companies.length === 0) return { subsidiaryId: { in: [] } };
  const byGrant: Prisma.ActivityRecordWhereInput[] = [];
  for (const subsidiaryId of companies) {
    const categories = grantedCategories(user, subsidiaryId);
    if (categories.length) byGrant.push({ subsidiaryId, category: { in: categories } });
  }
  return {
    OR: [...byGrant, { subsidiaryId: { in: companies }, createdBy: user.id }],
  };
}

/**
 * The same rule as a SQL predicate over `alias` (an `activity_records` row),
 * for the raw-SQL readers. Never interpolates text: every value is a bound
 * parameter.
 */
export function recordScopeSql(user: RequestUser, alias: string): Prisma.Sql {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`unsafe alias ${alias}`);
  const a = Prisma.raw(alias);
  const companies = user.accessibleSubsidiaryIds;
  if (companies.length === 0) return Prisma.sql`FALSE`;
  const inCompanies = Prisma.sql`${a}.subsidiary_id IN (${Prisma.join(companies.map((id) => Prisma.sql`${id}::uuid`))})`;
  if (!can(user.role, 'scope.categories')) return Prisma.sql`(${inCompanies})`;
  const parts: Prisma.Sql[] = [];
  for (const subsidiaryId of companies) {
    const categories = grantedCategories(user, subsidiaryId);
    if (categories.length) {
      parts.push(Prisma.sql`(${a}.subsidiary_id = ${subsidiaryId}::uuid AND ${a}.category IN (${Prisma.join(categories)}))`);
    }
  }
  parts.push(Prisma.sql`(${inCompanies} AND ${a}.created_by = ${user.id}::uuid)`);
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

/** Whether `record` is inside the caller's record scope — the in-memory twin of `recordScopeWhere`. */
export function inRecordScope(
  user: RequestUser,
  record: { subsidiaryId: string; category: string; createdBy: string | null },
): boolean {
  if (!user.accessibleSubsidiaryIds.includes(record.subsidiaryId)) return false;
  if (!can(user.role, 'scope.categories')) return true;
  if (record.createdBy === user.id) return true;
  return (grantedCategories(user, record.subsidiaryId) as readonly string[]).includes(record.category);
}

/** The categories ticked on the caller's grant for a company (meaningful for
 *  a standard user only; empty when none is ticked or none is known). */
export function grantedCategories(user: RequestUser, subsidiaryId: string): Category[] {
  return [...(user.categoryGrants?.[subsidiaryId] ?? [])].filter(isCategory);
}

/** 403 `category_not_granted`, naming the category (INC-2.6 §1, §7.3). */
export class CategoryNotGrantedError extends ForbiddenException {
  constructor(category: string) {
    super(
      errorBody(
        'category_not_granted',
        `The category "${category}" is not assigned to you for this company; a super_admin of the company assigns categories.`,
        { category },
      ),
    );
  }
}

/**
 * The write gate of a standard user's categories: create, edit (on the
 * category the record would hold) and submit, and each bulk-upload row — after
 * the role and scope checks. A masterkey and a super_admin are never refused
 * by it. Recall and delete are not gated: they only take data back.
 */
export function assertCategoryGranted(user: RequestUser, subsidiaryId: string, category: string): void {
  if (!can(user.role, 'scope.categories')) return;
  if (!(grantedCategories(user, subsidiaryId) as readonly string[]).includes(category)) {
    throw new CategoryNotGrantedError(category);
  }
}
