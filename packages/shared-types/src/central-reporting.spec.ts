import { describe, expect, it, expectTypeOf } from 'vitest';
import {
  centralReporterGrantOf,
  mainCompanyOf,
  recordParty,
  reportingEntityFor,
  singleEntryConflicts,
  type InviteUserRequest,
  type ReplaceUserAccessRequest,
  type SingleEntryAccessRow,
  type UserAccessGrantDTO,
  type UserAccessRowDTO,
} from './index';

const T = 'company-t';
const A = 'company-a';
const B = 'company-b';
const C = 'company-c';
const U = 'company-u';

const assigned = (subsidiaryId: string, categories: UserAccessRowDTO['categories'] = ['Electricity']): UserAccessRowDTO =>
  ({ subsidiaryId, categories, kind: 'assigned' });
const granted = (subsidiaryId: string, categories: UserAccessRowDTO['categories'] = ['Mobile Combustion']): UserAccessRowDTO =>
  ({ subsidiaryId, categories, kind: 'central_reporter' });

describe('mainCompanyOf and centralReporterGrantOf', () => {
  it('a user with one company: that company, no grant', () => {
    const access = [assigned(T)];
    expect(mainCompanyOf(access)).toBe(T);
    expect(centralReporterGrantOf(access)).toBeNull();
  });

  it('a central reporter: the one assigned company, and the grant beside it', () => {
    const access = [assigned(T), granted(A, ['Mobile Combustion', 'Natural Gas']),
      granted(B, ['Mobile Combustion', 'Natural Gas'])];
    expect(mainCompanyOf(access)).toBe(T);
    expect(centralReporterGrantOf(access)).toEqual({
      subsidiaryIds: [A, B],
      categories: ['Mobile Combustion', 'Natural Gas'],
    });
  });

  it('a carried-over account with two assigned companies has no single main company', () => {
    const access = [assigned(T), assigned(A)];
    expect(mainCompanyOf(access)).toBeNull();
    expect(centralReporterGrantOf(access)).toBeNull();
  });

  it('a super_admin with several companies has no single main company', () => {
    expect(mainCompanyOf([assigned(T, []), assigned(A, []), assigned(B, [])])).toBeNull();
  });

  it('an empty list: neither', () => {
    expect(mainCompanyOf([])).toBeNull();
    expect(centralReporterGrantOf([])).toBeNull();
  });

  it('reads a write-shape row with no kind as assigned', () => {
    const write: UserAccessGrantDTO[] = [{ subsidiaryId: T, categories: ['Electricity'] }];
    expect(mainCompanyOf(write)).toBe(T);
  });

  it('answers the union, never hiding a category, should grant rows ever differ', () => {
    expect(centralReporterGrantOf([assigned(T), granted(A, ['Mobile Combustion']), granted(B, ['Electricity'])])
      ?.categories).toEqual(['Mobile Combustion', 'Electricity']);
  });

  it('the two write requests accept a body with no kind', () => {
    expectTypeOf<{ subsidiaryId: string; categories: [] }>().toExtend<UserAccessGrantDTO>();
    expectTypeOf<ReplaceUserAccessRequest['access'][number]>().toEqualTypeOf<UserAccessGrantDTO>();
    expectTypeOf<NonNullable<InviteUserRequest['access']>[number]>().toEqualTypeOf<UserAccessGrantDTO>();
    const replace: ReplaceUserAccessRequest = { access: [{ subsidiaryId: T, categories: ['Electricity'] }] };
    expect(replace.access).toHaveLength(1);
  });
});

describe('reportingEntityFor', () => {
  const reporter = [assigned(T), granted(A), granted(B)];

  it('the main company → that company', () => {
    expect(reportingEntityFor(reporter, T)).toBe(T);
  });

  it('a grant company → the main company', () => {
    expect(reportingEntityFor(reporter, A)).toBe(T);
    expect(reportingEntityFor(reporter, B)).toBe(T);
  });

  it('a carried-over account → the company itself, for each', () => {
    const carried = [assigned(T), assigned(A), assigned(B)];
    for (const company of [T, A, B]) expect(reportingEntityFor(carried, company)).toBe(company);
  });

  it('a masterkey (no grants) → the company itself', () => {
    expect(reportingEntityFor([], A)).toBe(A);
  });

  it('a grant company with no single main company → null (the database refuses it)', () => {
    expect(reportingEntityFor([granted(A)], A)).toBeNull();
    expect(reportingEntityFor([assigned(T), assigned(U), granted(A)], A)).toBeNull();
  });
});

describe('singleEntryConflicts', () => {
  const row = (
    userId: string,
    subsidiaryId: string,
    kind: SingleEntryAccessRow['kind'],
    categories: SingleEntryAccessRow['categories'],
    holderRole: string | null = 'standard_user',
  ): SingleEntryAccessRow => ({ userId, subsidiaryId, kind, categories, holderRole });

  it("a grant meets the company's own user holding the category: refused, side company_users", () => {
    const standing = [row('own', A, 'assigned', ['Mobile Combustion'])];
    const proposed = [row('rep', T, 'assigned', ['Electricity']), row('rep', A, 'central_reporter', ['Mobile Combustion'])];
    expect(singleEntryConflicts(standing, proposed)).toEqual([
      { subsidiaryId: A, categories: ['Mobile Combustion'], side: 'company_users' },
    ]);
  });

  it('an assignment meets a central reporter holding the category: refused, side central_reporter', () => {
    const standing = [row('rep', A, 'central_reporter', ['Mobile Combustion'])];
    const proposed = [row('own', A, 'assigned', ['Mobile Combustion', 'Electricity'])];
    expect(singleEntryConflicts(standing, proposed)).toEqual([
      { subsidiaryId: A, categories: ['Mobile Combustion'], side: 'central_reporter' },
    ]);
  });

  it('different categories at the same company: no conflict', () => {
    const standing = [row('rep', A, 'central_reporter', ['Mobile Combustion'])];
    expect(singleEntryConflicts(standing, [row('own', A, 'assigned', ['Electricity'])])).toEqual([]);
  });

  it('several conflicts in one result, one per company', () => {
    const standing = [
      row('ownA', A, 'assigned', ['Mobile Combustion']),
      row('ownB', B, 'assigned', ['Mobile Combustion', 'Electricity']),
      row('ownB2', B, 'assigned', ['Electricity']),
    ];
    const proposed = [
      row('rep', T, 'assigned', []),
      ...[A, B, C].map((id) => row('rep', id, 'central_reporter', ['Mobile Combustion', 'Electricity'])),
    ];
    expect(singleEntryConflicts(standing, proposed)).toEqual([
      { subsidiaryId: A, categories: ['Mobile Combustion'], side: 'company_users' },
      { subsidiaryId: B, categories: ['Mobile Combustion', 'Electricity'], side: 'company_users' },
    ]);
  });

  it('rows of a holder that is not a standard user are no party', () => {
    const everything: SingleEntryAccessRow['categories'] = ['Mobile Combustion', 'Electricity'];
    const standing = [
      row('mk', A, 'central_reporter', everything, 'masterkey'),
      row('aud', A, 'assigned', everything, 'auditor'),
      row('sa', A, 'assigned', [], 'super_admin'),
      row('gone', A, 'assigned', everything, null),
    ];
    expect(singleEntryConflicts(standing, [row('own', A, 'assigned', everything)])).toEqual([]);
    expect(singleEntryConflicts([row('own', A, 'assigned', everything)],
      [row('mk', A, 'central_reporter', everything, 'masterkey')])).toEqual([]);
  });

  it("a carried-over account's rows count as the company's own users", () => {
    const standing = [row('carried', A, 'assigned', ['Mobile Combustion']), row('carried', B, 'assigned', ['Electricity'])];
    expect(singleEntryConflicts(standing, [row('rep', T, 'assigned', []), row('rep', A, 'central_reporter', ['Mobile Combustion'])]))
      .toEqual([{ subsidiaryId: A, categories: ['Mobile Combustion'], side: 'company_users' }]);
  });

  it('two central reporters at one company are not in conflict', () => {
    const standing = [row('rep1', A, 'central_reporter', ['Mobile Combustion'])];
    expect(singleEntryConflicts(standing, [row('rep2', A, 'central_reporter', ['Mobile Combustion'])])).toEqual([]);
  });

  it("the changed account's own standing rows are replaced, not compared", () => {
    // Converting a carried-over account: its assigned row at A becomes a grant row.
    const standing = [row('carried', A, 'assigned', ['Mobile Combustion']), row('carried', T, 'assigned', ['Electricity'])];
    const proposed = [row('carried', T, 'assigned', ['Electricity']), row('carried', A, 'central_reporter', ['Mobile Combustion'])];
    expect(singleEntryConflicts(standing, proposed)).toEqual([]);
  });
});

describe('recordParty', () => {
  it('a stored reporting entity that differs → central_reporter, whatever the role', () => {
    expect(recordParty({ subsidiaryId: A, reportedBySubsidiaryId: T }, 'standard_user')).toBe('central_reporter');
    expect(recordParty({ subsidiaryId: A, reportedBySubsidiaryId: T }, 'super_admin')).toBe('central_reporter');
  });

  it('a standard-user author without one → company_user (stored null or the DTO echo)', () => {
    expect(recordParty({ subsidiaryId: A, reportedBySubsidiaryId: null }, 'standard_user')).toBe('company_user');
    expect(recordParty({ subsidiaryId: A, reportedBySubsidiaryId: A }, 'standard_user')).toBe('company_user');
  });

  it("a super_admin's and a masterkey's record → neither party", () => {
    expect(recordParty({ subsidiaryId: A, reportedBySubsidiaryId: null }, 'super_admin')).toBeNull();
    expect(recordParty({ subsidiaryId: A, reportedBySubsidiaryId: null }, 'masterkey')).toBeNull();
  });

  it('an author whose profile is missing → neither party', () => {
    expect(recordParty({ subsidiaryId: A, reportedBySubsidiaryId: null }, null)).toBeNull();
    expect(recordParty({ subsidiaryId: A, reportedBySubsidiaryId: undefined }, undefined)).toBeNull();
  });
});
