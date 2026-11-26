import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { describeFor } from '@/lib/i18n/testing';
import { MESSAGES } from '@/messages';
import type { BulkUploadRowIssue, UserAccessRowDTO } from '@/lib/types';
import { issueSentence } from './bulk-upload-view';
import { categoryGate, offeredCategories } from './entry-categories-view';

/**
 * Data Entry for a central reporter (inc26-central-reporter-onboarding, task
 * 5.4): the main company and the grant's companies, each with its own
 * categories; and the period refusal in the reader's language, on save and
 * in the bulk panel's row results.
 */

const reporter = {
  role: 'standard_user' as const,
  access: [
    { subsidiaryId: 'T', categories: ['Water', 'Electricity'], kind: 'assigned' },
    { subsidiaryId: 'A', categories: ['Mobile Combustion'], kind: 'central_reporter' },
    { subsidiaryId: 'B', categories: ['Mobile Combustion'], kind: 'central_reporter' },
  ] satisfies UserAccessRowDTO[],
};

describe("Data Entry offers a central reporter the grant's companies and categories", () => {
  it("a grant company offers the grant's categories alone", () => {
    expect(offeredCategories(reporter, 'A')).toEqual(['Mobile Combustion']);
    expect(offeredCategories(reporter, 'B')).toEqual(['Mobile Combustion']);
  });

  it("back to the main company: its own categories, not the grant's", () => {
    expect(offeredCategories(reporter, 'T')).toEqual(['Electricity', 'Water']);
  });

  it('a company outside the grant offers nothing; a link to its category is not granted there', () => {
    expect(categoryGate(reporter, 'C', null)).toEqual({ kind: 'none' });
    expect(categoryGate(reporter, 'A', 'Electricity')).toEqual({ kind: 'not_granted', category: 'Electricity', categories: ['Mobile Combustion'] });
  });
});

describe('the period refusal in the reader\'s language', () => {
  const params = { side: 'company_users', category: 'Mobile Combustion', year: 2026, period: 'March' };
  const refusal = new ApiError('English', 409, 'single_entry_period_conflict', params);

  it('on save, in English and Turkish, by its side', () => {
    expect(describeFor('en')(refusal).title).toBe(
      "The company's own users already entered Mobile Combustion for March 2026, so a central reporter cannot enter it for this company in that period.",
    );
    const tr = describeFor('tr')(refusal).title;
    expect(tr).toContain(MESSAGES.tr.categories['Mobile Combustion']);
    expect(tr).toContain('2026');
    expect(tr).not.toContain('{');
    const other = describeFor('en')(new ApiError('English', 409, 'single_entry_period_conflict', { ...params, side: 'central_reporter' })).title;
    expect(other).toBe('A central reporter already entered Mobile Combustion for March 2026 for this company, so its own users cannot enter it in that period.');
  });

  it("in the bulk panel's row results: the same sentence from the row's params; any other row keeps the server's", () => {
    const row: BulkUploadRowIssue = { row: 4, column: null, code: 'single_entry_period_conflict', message: 'English', params };
    expect(issueSentence(row, describeFor('tr'))).toBe(describeFor('tr')(refusal).title);
    expect(issueSentence({ ...row, code: 'duplicate_existing', params: undefined }, describeFor('tr'))).toBe('English');
  });
});
