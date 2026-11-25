import { describe, expect, it } from 'vitest';
import { Prisma } from '@tonyai/db';
import { CATEGORIES } from '@tonyai/shared-types';
import { errorCodeOf } from '../common/api-error';
import {
  assertCategoryGranted,
  CategoryNotGrantedError,
  grantedCategories,
  inRecordScope,
  recordScopeSql,
  recordScopeWhere,
} from './record-scope';
import { makeAuditor, makeMasterkey, makeStandardUser, makeSuperAdmin } from '../../test/helpers';
import type { RequestUser } from '../auth/auth.types';

/**
 * The record scope (inc26-roles-approval-chain, design Decision 6; tasks 8.1,
 * 8.4): the one filter every read of activity records takes. Three forms of
 * one rule — a Prisma where, a SQL predicate and an in-memory check — so each
 * case below asks all three where it can and expects them to agree.
 */

/** A standard user granted A with Electricity and B with Fuel (the spec's
 *  "A category differs by company"). */
const split = (over: Partial<RequestUser> = {}) =>
  makeStandardUser({
    accessibleSubsidiaryIds: ['sub-a', 'sub-b'],
    categoryGrants: { 'sub-a': ['Electricity'], 'sub-b': ['Fuel'] },
    ...over,
  });

const rec = (subsidiaryId: string, category: string, createdBy: string | null = 'someone-else') => ({
  subsidiaryId,
  category,
  createdBy,
});

/** A SQL fragment as text and its bound values, never interpolated. */
function sqlOf(user: RequestUser, alias = 'ar'): { text: string; values: unknown[] } {
  const sql = recordScopeSql(user, alias);
  return { text: sql.sql, values: sql.values };
}

describe('recordScopeWhere — the Prisma filter, per role', () => {
  it.each([
    ['masterkey', makeMasterkey()],
    ['auditor', makeAuditor()],
    ['super_admin', makeSuperAdmin()],
  ] as const)('a %s reads every category of its companies: the company filter alone', (_role, user) => {
    expect(recordScopeWhere(user)).toEqual({ subsidiaryId: { in: user.accessibleSubsidiaryIds } });
  });

  it('a super_admin is never narrowed by categories, even when its grants name some', () => {
    const user = makeSuperAdmin({ categoryGrants: { 'sub-1': ['Electricity'] } });
    expect(recordScopeWhere(user)).toEqual({ subsidiaryId: { in: ['sub-1', 'sub-2'] } });
  });

  it('a standard user: per grant, its company with that grant\'s categories, plus its own records in any granted company', () => {
    expect(recordScopeWhere(split())).toEqual({
      OR: [
        { subsidiaryId: 'sub-a', category: { in: ['Electricity'] } },
        { subsidiaryId: 'sub-b', category: { in: ['Fuel'] } },
        { subsidiaryId: { in: ['sub-a', 'sub-b'] }, createdBy: 'user-entry' },
      ],
    });
  });

  it('a grant with an empty category list adds no branch; the own-record branch still covers that company', () => {
    const user = split({ categoryGrants: { 'sub-a': [], 'sub-b': ['Fuel'] } });
    expect(recordScopeWhere(user)).toEqual({
      OR: [
        { subsidiaryId: 'sub-b', category: { in: ['Fuel'] } },
        { subsidiaryId: { in: ['sub-a', 'sub-b'] }, createdBy: 'user-entry' },
      ],
    });
  });

  it('a standard user with no categoryGrants at all reads only its own records (fails closed)', () => {
    const user = makeStandardUser({ categoryGrants: undefined });
    expect(recordScopeWhere(user)).toEqual({
      OR: [{ subsidiaryId: { in: ['sub-1', 'sub-2'] }, createdBy: 'user-entry' }],
    });
  });

  it('drops a category text the build does not know rather than passing it to the query', () => {
    const user = split({ categoryGrants: { 'sub-a': ['Electricity', 'Not a category'] as never, 'sub-b': [] } });
    expect(grantedCategories(user, 'sub-a')).toEqual(['Electricity']);
    expect(recordScopeWhere(user)).toEqual({
      OR: [
        { subsidiaryId: 'sub-a', category: { in: ['Electricity'] } },
        { subsidiaryId: { in: ['sub-a', 'sub-b'] }, createdBy: 'user-entry' },
      ],
    });
  });

  it('a grant for a company outside the accessible set adds nothing (grants follow access)', () => {
    const user = split({ accessibleSubsidiaryIds: ['sub-a'] });
    expect(recordScopeWhere(user)).toEqual({
      OR: [
        { subsidiaryId: 'sub-a', category: { in: ['Electricity'] } },
        { subsidiaryId: { in: ['sub-a'] }, createdBy: 'user-entry' },
      ],
    });
  });

  it.each([
    ['standard_user', makeStandardUser({ accessibleSubsidiaryIds: [] })],
    ['super_admin', makeSuperAdmin({ accessibleSubsidiaryIds: [] })],
  ] as const)('a %s with no accessible company matches nothing', (_role, user) => {
    expect(recordScopeWhere(user)).toEqual({ subsidiaryId: { in: [] } });
  });
});

describe('inRecordScope — the in-memory twin', () => {
  it.each([
    ['masterkey', makeMasterkey()],
    ['auditor', makeAuditor()],
    ['super_admin', makeSuperAdmin()],
  ] as const)('a %s: any category of an accessible company, nothing outside it', (_role, user) => {
    for (const category of CATEGORIES) expect(inRecordScope(user, rec('sub-1', category))).toBe(true);
    expect(inRecordScope(user, rec('sub-foreign', 'Electricity'))).toBe(false);
  });

  it('a standard user: the grant\'s categories per company — Electricity in A, Fuel in B, not crosswise', () => {
    const user = split();
    expect(inRecordScope(user, rec('sub-a', 'Electricity'))).toBe(true);
    expect(inRecordScope(user, rec('sub-b', 'Fuel'))).toBe(true);
    expect(inRecordScope(user, rec('sub-a', 'Fuel'))).toBe(false);
    expect(inRecordScope(user, rec('sub-b', 'Electricity'))).toBe(false);
  });

  it('a standard user reads its own record in any category of a granted company (a withdrawn category)', () => {
    const user = split();
    expect(inRecordScope(user, rec('sub-a', 'Fuel', 'user-entry'))).toBe(true);
    // Never outside its companies, own or not.
    expect(inRecordScope(user, rec('sub-c', 'Electricity', 'user-entry'))).toBe(false);
  });

  it('a record with no author is never "own"', () => {
    const user = split();
    expect(inRecordScope(user, rec('sub-a', 'Fuel', null))).toBe(false);
  });

  it('with no categoryGrants a standard user reads only its own records', () => {
    const user = makeStandardUser({ categoryGrants: undefined });
    expect(inRecordScope(user, rec('sub-1', 'Electricity'))).toBe(false);
    expect(inRecordScope(user, rec('sub-1', 'Electricity', 'user-entry'))).toBe(true);
  });

  it('an empty category list on a grant leaves only its own records in that company', () => {
    const user = split({ categoryGrants: { 'sub-a': [], 'sub-b': ['Fuel'] } });
    expect(inRecordScope(user, rec('sub-a', 'Electricity'))).toBe(false);
    expect(inRecordScope(user, rec('sub-a', 'Electricity', 'user-entry'))).toBe(true);
  });

  it('no accessible company: nothing, own or not', () => {
    const user = makeStandardUser({ accessibleSubsidiaryIds: [] });
    expect(inRecordScope(user, rec('sub-1', 'Electricity', 'user-entry'))).toBe(false);
  });
});

describe('recordScopeSql — the raw-SQL predicate', () => {
  it.each([
    ['masterkey', makeMasterkey({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] })],
    ['auditor', makeAuditor({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] })],
    ['super_admin', makeSuperAdmin()],
  ] as const)('a %s: the company predicate alone, every id a bound parameter', (_role, user) => {
    const { text, values } = sqlOf(user);
    expect(text).toBe('(ar.subsidiary_id IN (?::uuid,?::uuid))');
    expect(values).toEqual(['sub-1', 'sub-2']);
  });

  it('a standard user: one branch per grant with categories, and the own-record branch', () => {
    const { text, values } = sqlOf(split());
    expect(text).toBe(
      '((ar.subsidiary_id = ?::uuid AND ar.category IN (?)) OR ' +
        '(ar.subsidiary_id = ?::uuid AND ar.category IN (?)) OR ' +
        '(ar.subsidiary_id IN (?::uuid,?::uuid) AND ar.created_by = ?::uuid))',
    );
    expect(values).toEqual(['sub-a', 'Electricity', 'sub-b', 'Fuel', 'sub-a', 'sub-b', 'user-entry']);
  });

  it('an empty category list, or no categoryGrants, leaves the own-record branch only', () => {
    for (const user of [split({ categoryGrants: { 'sub-a': [], 'sub-b': [] } }), split({ categoryGrants: undefined })]) {
      const { text, values } = sqlOf(user);
      expect(text).toBe('((ar.subsidiary_id IN (?::uuid,?::uuid) AND ar.created_by = ?::uuid))');
      expect(values).toEqual(['sub-a', 'sub-b', 'user-entry']);
    }
  });

  it('no accessible company is FALSE, for every role', () => {
    for (const user of [
      makeMasterkey({ accessibleSubsidiaryIds: [] }),
      makeSuperAdmin({ accessibleSubsidiaryIds: [] }),
      makeStandardUser({ accessibleSubsidiaryIds: [] }),
    ]) {
      expect(sqlOf(user).text).toBe('FALSE');
    }
  });

  it('never interpolates a value: a hostile category or id travels as a parameter', () => {
    const user = split({
      id: "x'; DROP TABLE activity_records; --",
      categoryGrants: { 'sub-a': ['Electricity'], 'sub-b': [] },
    });
    const { text, values } = sqlOf(user);
    expect(text).not.toContain('DROP');
    expect(values).toContain("x'; DROP TABLE activity_records; --");
  });

  it.each(['ar; DROP', 'AR', '1ar', 'a.b', ''])('refuses an unsafe alias %j', (alias) => {
    expect(() => recordScopeSql(makeMasterkey(), alias)).toThrow(/unsafe alias/);
  });

  it('composes into a larger Prisma.sql statement, its values bound in place', () => {
    const user = makeMasterkey({ accessibleSubsidiaryIds: ['sub-1'] });
    const whole = Prisma.sql`SELECT 1 FROM activity_records r WHERE r.reporting_year = ${2026} AND ${recordScopeSql(user, 'r')}`;
    expect(whole.sql).toBe('SELECT 1 FROM activity_records r WHERE r.reporting_year = ? AND (r.subsidiary_id IN (?::uuid))');
    expect(whole.values).toEqual([2026, 'sub-1']);
  });
});

describe('assertCategoryGranted — the write gate', () => {
  it('lets a standard user write a category ticked on the grant for that company', () => {
    expect(() => assertCategoryGranted(split(), 'sub-a', 'Electricity')).not.toThrow();
    expect(() => assertCategoryGranted(split(), 'sub-b', 'Fuel')).not.toThrow();
  });

  it('refuses another category with 403 category_not_granted, naming it', () => {
    const refusal = (() => {
      try {
        assertCategoryGranted(split(), 'sub-a', 'Fuel');
      } catch (e) {
        return e;
      }
    })();
    expect(refusal).toBeInstanceOf(CategoryNotGrantedError);
    expect((refusal as CategoryNotGrantedError).getStatus()).toBe(403);
    expect(errorCodeOf(refusal)).toBe('category_not_granted');
    expect((refusal as CategoryNotGrantedError).getResponse()).toMatchObject({ params: { category: 'Fuel' } });
  });

  it('refuses everything without categoryGrants, and for a company with none ticked', () => {
    expect(() => assertCategoryGranted(makeStandardUser({ categoryGrants: undefined }), 'sub-1', 'Electricity')).toThrow(
      CategoryNotGrantedError,
    );
    expect(() => assertCategoryGranted(split({ categoryGrants: { 'sub-a': [] } }), 'sub-a', 'Electricity')).toThrow(
      CategoryNotGrantedError,
    );
  });

  it.each([
    ['masterkey', makeMasterkey()],
    ['super_admin', makeSuperAdmin()],
  ] as const)('never refuses a %s, whatever the category or its grants', (_role, user) => {
    for (const category of CATEGORIES) {
      expect(() => assertCategoryGranted(user, 'sub-1', category)).not.toThrow();
      expect(() => assertCategoryGranted({ ...user, categoryGrants: undefined }, 'sub-1', category)).not.toThrow();
    }
  });
});
