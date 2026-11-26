import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { MESSAGES } from '@/messages';
import { copyFor } from '@/lib/i18n/testing';
import type { Category, UserAccessRowDTO, UserSummaryDTO } from '@/lib/types';
import {
  accessPayload,
  accessSummary,
  grantPayload,
  grantPreview,
  grantRowsOf,
  grantableCompanies,
  initialDraft,
  initialGrantDraft,
  rowActions,
  singleEntryLines,
  usersErrorKey,
} from './users-view';

/**
 * The users screen's central reporter decisions (inc26-central-reporter-
 * onboarding, tasks 5.1–5.3): the access column's two parts, the editor's
 * draft without the grant's rows, the grant dialog's before-and-after view,
 * and a single-entry refusal worded from the screen's own lists.
 */

const row = (subsidiaryId: string, kind: UserAccessRowDTO['kind'], categories: Category[] = []): UserAccessRowDTO => ({ subsidiaryId, categories, kind });
const member = (role: UserSummaryDTO['role'], access: UserAccessRowDTO[], id = 'u-target'): UserSummaryDTO => ({
  id, email: 'x@y.test', fullName: 'Rana Reporter', role, language: 'en', status: 'active', access,
  disabledAt: null, authSyncPending: false, invitation: null, createdAt: '2026-11-26T09:00:00.000Z',
});
const names = new Map([['t', 'Supply Co'], ['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma']]);
const reporter = member('standard_user', [row('t', 'assigned', ['Water']), row('a', 'central_reporter', ['Mobile Combustion']), row('b', 'central_reporter', ['Mobile Combustion'])]);
const masterkey = { id: 'u-mk', role: 'masterkey' as const, accessibleSubsidiaryIds: ['t', 'a', 'b', 'c'] };
const superAdminOfA = { id: 'u-sa', role: 'super_admin' as const, accessibleSubsidiaryIds: ['a'] };

describe('the access column states the main company and the grant apart (task 5.1)', () => {
  it('a masterkey reader: the main company, and the grant with its companies and categories', () => {
    expect(accessSummary(reporter, names, 'en-GB')).toEqual({
      key: 'named', names: ['Supply Co'], overflow: 0, all: ['Supply Co'],
      grant: { names: ['Alpha', 'Beta'], overflow: 0, all: ['Alpha', 'Beta'], categories: ['Mobile Combustion'] },
    });
  });

  it("a super_admin reader of an owning company: the grant's row inside its company only, no main company", () => {
    // The API answers the rows inside the super_admin's companies only.
    const seen = member('standard_user', [row('a', 'central_reporter', ['Mobile Combustion'])]);
    expect(accessSummary(seen, names, 'en-GB')).toEqual({
      key: 'named', names: [], overflow: 0, all: [],
      grant: { names: ['Alpha'], overflow: 0, all: ['Alpha'], categories: ['Mobile Combustion'] },
    });
  });
});

describe('the access editor leaves the grant out of what it saves (task 5.2)', () => {
  it("a super_admin of an owning company: the grant row shown read-only, the draft and the payload without it", () => {
    const seen = member('standard_user', [row('a', 'central_reporter', ['Mobile Combustion'])]);
    expect(grantRowsOf(seen)).toEqual([row('a', 'central_reporter', ['Mobile Combustion'])]);
    expect(initialDraft(seen)).toEqual([]);
    expect(accessPayload('standard_user', initialDraft(seen))).toEqual([]);
  });

  it('an unchanged save sends the main company alone, exactly as held', () => {
    expect(accessPayload('standard_user', initialDraft(reporter))).toEqual([{ subsidiaryId: 't', categories: ['Water'] }]);
  });
});

describe('the central reporter action and dialog (task 5.3)', () => {
  it("is offered to a masterkey on a standard user's row only", () => {
    expect(rowActions(masterkey, reporter).centralReporter).toBe(true);
    expect(rowActions(masterkey, member('super_admin', [row('a', 'assigned')])).centralReporter).toBe(false);
    expect(rowActions(masterkey, member('auditor', [])).centralReporter).toBe(false);
    expect(rowActions(superAdminOfA, reporter).centralReporter).toBe(false);
    expect(rowActions(masterkey, member('standard_user', [], 'u-mk')).centralReporter).toBe(false);
  });

  it('offers only companies that hold records', () => {
    const offered = grantableCompanies([
      { id: 'a', nodeType: 'company' as const, control: 'controlled' as const },
      { id: 'x', nodeType: 'company' as const, control: 'associate' as const },
      { id: 'g', nodeType: 'sector_group' as const, control: 'controlled' as const },
    ]);
    expect(offered.map((s) => s.id)).toEqual(['a']);
  });

  it('starts from the standing grant', () => {
    expect(initialGrantDraft(reporter)).toEqual({ subsidiaryIds: ['a', 'b'], categories: ['Mobile Combustion'] });
  });

  it("a carried-over account whose companies hold different categories: the main company named, each company's categories now and after", () => {
    const carried = member('standard_user', [row('a', 'assigned', ['Electricity']), row('b', 'assigned', ['Electricity']), row('c', 'assigned', ['Mobile Combustion'])]);
    const preview = grantPreview(carried, { subsidiaryIds: ['b', 'c'], categories: ['Mobile Combustion'] });
    expect(preview.mainCompanyId).toBe('a');
    expect(preview.changes).toEqual([
      { subsidiaryId: 'a', before: { kind: 'assigned', categories: ['Electricity'] }, after: { kind: 'assigned', categories: ['Electricity'] } },
      { subsidiaryId: 'b', before: { kind: 'assigned', categories: ['Electricity'] }, after: { kind: 'central_reporter', categories: ['Mobile Combustion'] } },
      { subsidiaryId: 'c', before: { kind: 'assigned', categories: ['Mobile Combustion'] }, after: { kind: 'central_reporter', categories: ['Mobile Combustion'] } },
    ]);
  });

  it('a narrowed grant shows the withdrawn company; a grant naming every held company leaves no main company', () => {
    const narrowed = grantPreview(reporter, { subsidiaryIds: ['a'], categories: ['Mobile Combustion'] });
    expect(narrowed.changes.find((c) => c.subsidiaryId === 'b')).toEqual({
      subsidiaryId: 'b', before: { kind: 'central_reporter', categories: ['Mobile Combustion'] }, after: null,
    });
    expect(grantPreview(reporter, { subsidiaryIds: ['t', 'a'], categories: ['Mobile Combustion'] }).mainCompanyId).toBeNull();
  });

  it('a save with no company withdraws the grant and sends no category', () => {
    expect(grantPayload({ subsidiaryIds: [], categories: ['Water'] })).toEqual({ subsidiaryIds: [], categories: [] });
    expect(grantPayload({ subsidiaryIds: ['a', 'a'], categories: ['Water', 'Electricity'] })).toEqual({ subsidiaryIds: ['a'], categories: ['Electricity', 'Water'] });
  });
});

describe('the refusals in the reader\'s words (tasks 5.1, 5.3)', () => {
  const conflict = (side: 'company_users' | 'central_reporter', conflicts: { subsidiaryId: string; categories: Category[] }[]) =>
    new ApiError('refused', 409, 'single_entry_conflict', { side }, undefined, conflicts);
  const lines = (error: unknown, locale: 'en' | 'tr') =>
    singleEntryLines(error, names, (c) => MESSAGES[locale].categories[c], copyFor('users', locale));

  it('one conflict, in English and Turkish', () => {
    const error = conflict('company_users', [{ subsidiaryId: 'a', categories: ['Mobile Combustion'] }]);
    expect(lines(error, 'en')).toEqual(["Alpha: the company's own users already hold Mobile Combustion. Nothing was changed."]);
    expect(lines(error, 'tr')).toEqual([`Alpha: şirketin kendi kullanıcıları ${MESSAGES.tr.categories['Mobile Combustion']} kategorilerini zaten tutuyor. Hiçbir şey değiştirilmedi.`]);
  });

  it('several conflicts, one sentence each, the categories listed in the product\'s order', () => {
    const error = conflict('company_users', [
      { subsidiaryId: 'a', categories: ['Mobile Combustion'] },
      { subsidiaryId: 'b', categories: ['Mobile Combustion', 'Electricity'] },
    ]);
    expect(lines(error, 'en')).toEqual([
      "Alpha: the company's own users already hold Mobile Combustion. Nothing was changed.",
      "Beta: the company's own users already hold Electricity and Mobile Combustion. Nothing was changed.",
    ]);
  });

  it("a central reporter's side, and the general sentence for a raced refusal's empty list", () => {
    expect(lines(conflict('central_reporter', [{ subsidiaryId: 'a', categories: ['Fuel'] }]), 'en'))
      .toEqual(['Alpha: a central reporter already holds Fuel. Nothing was changed.']);
    expect(lines(conflict('central_reporter', []), 'en')).toEqual([MESSAGES.en.users.errors.singleEntry.centralReporterGeneral]);
    expect(lines(conflict('company_users', []), 'tr')).toEqual([MESSAGES.tr.users.errors.singleEntry.companyUsersGeneral]);
  });

  it('answers null for anything else, and words the main-company refusal itself', () => {
    expect(lines(new ApiError('x', 409, 'standard_user_single_company'), 'en')).toBeNull();
    expect(usersErrorKey(new ApiError('x', 409, 'central_reporter_needs_main_entity'))).toBe('errors.centralReporterNeedsMainEntity');
  });
});

describe('the grant preview names no main company when several stay assigned (qa-auditor U4)', () => {
  it('a carried-over account with three companies and a grant naming one', () => {
    const carried = member('standard_user', [row('a', 'assigned', ['Fuel']), row('b', 'assigned', ['Fuel']), row('c', 'assigned', ['Fuel'])]);
    expect(grantPreview(carried, { subsidiaryIds: ['c'], categories: ['Fuel'] }).mainCompanyId).toBeNull();
  });
});
