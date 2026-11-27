import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { EntriesJump } from '@/components/data-entry/entries-jump';
import { MESSAGES } from '@/messages';
import { needsEvidenceBeforeSubmit } from '@/lib/types';
import {
  fuelBatchLink,
  RECORDS_HEADING_ID,
  blankRecordsFilter,
  entriesJumpWording,
  evidenceCell,
  isNarrowed,
  jumpToRecords,
  type JumpTarget,
  pickRecordsFilter,
  recordsQuery,
  recordsYearOptions,
  resolveRecordsFilter,
} from './records-table-view';

/**
 * BUG-R2-05's records table: its filters go to the API (so Load more honours
 * them), the year follows the form until the user picks one, another
 * subsidiary starts clean, and the evidence cell says "missing" exactly where
 * the evidence gate would refuse a submit.
 */

describe('the year filter follows the form until picked', () => {
  it('starts at the form year', () => {
    const state = blankRecordsFilter('sub-a');
    expect(resolveRecordsFilter(state, 'sub-a', 2025).year).toBe(2025);
    expect(resolveRecordsFilter(state, 'sub-a', 2024).year).toBe(2024);
  });

  it('keeps a picked year when the form year changes', () => {
    const picked = pickRecordsFilter(blankRecordsFilter('sub-a'), 'sub-a', { year: 2023 });
    expect(resolveRecordsFilter(picked, 'sub-a', 2025).year).toBe(2023);
  });

  it('keeps All years once picked', () => {
    const picked = pickRecordsFilter(blankRecordsFilter('sub-a'), 'sub-a', { year: 'all' });
    expect(resolveRecordsFilter(picked, 'sub-a', 2025).year).toBe('all');
    expect(resolveRecordsFilter(picked, 'sub-a', 2024).year).toBe('all');
  });

  it('does not pin the year when only the status or category changes', () => {
    const state = pickRecordsFilter(blankRecordsFilter('sub-a'), 'sub-a', { status: 'draft' });
    expect(resolveRecordsFilter(state, 'sub-a', 2024)).toEqual({ year: 2024, status: 'draft', category: 'all' });
  });
});

describe('another subsidiary starts clean', () => {
  it('ignores filters saved for another subsidiary', () => {
    const forA = pickRecordsFilter(blankRecordsFilter('sub-a'), 'sub-a', { year: 'all', status: 'approved', category: 'Fuel' });
    expect(resolveRecordsFilter(forA, 'sub-b', 2025)).toEqual({ year: 2025, status: 'all', category: 'all' });
  });

  it('starts a pick for another subsidiary from blank, not from the old state', () => {
    const forA = pickRecordsFilter(blankRecordsFilter('sub-a'), 'sub-a', { status: 'approved' });
    const forB = pickRecordsFilter(forA, 'sub-b', { category: 'Electricity' });
    expect(forB).toEqual({ subsidiaryId: 'sub-b', yearPinned: false, year: 'all', status: 'all', category: 'Electricity' });
  });
});

describe('recordsQuery', () => {
  it('sends each narrowing filter, the status as a one-item set', () => {
    expect(recordsQuery({ year: 2025, status: 'draft', category: 'Natural Gas' })).toEqual({
      year: 2025,
      status: ['draft'],
      category: 'Natural Gas',
    });
  });
  it('sends nothing for All', () => {
    expect(recordsQuery({ year: 'all', status: 'all', category: 'all' })).toEqual({});
  });
});

describe('isNarrowed', () => {
  it('is false only with every filter on All', () => {
    expect(isNarrowed({ year: 'all', status: 'all', category: 'all' })).toBe(false);
    expect(isNarrowed({ year: 2025, status: 'all', category: 'all' })).toBe(true);
    expect(isNarrowed({ year: 'all', status: 'rejected', category: 'all' })).toBe(true);
    expect(isNarrowed({ year: 'all', status: 'all', category: 'Water' })).toBe(true);
  });
});

describe('evidenceCell', () => {
  it('says missing for a required category with no file', () => {
    expect(evidenceCell({ category: 'Electricity', evidenceCount: 0, status: 'draft' })).toEqual({ kind: 'missing' });
  });
  it('shows the count once a file is attached', () => {
    expect(evidenceCell({ category: 'Electricity', evidenceCount: 1, status: 'submitted' })).toEqual({
      kind: 'count',
      count: 1,
    });
  });
  it('shows 0, not missing, where no file is required', () => {
    expect(evidenceCell({ category: 'Business Travel', evidenceCount: 0, status: 'draft' })).toEqual({
      kind: 'count',
      count: 0,
    });
  });
  it('never calls a voided record missing a file', () => {
    expect(evidenceCell({ category: 'Fuel', evidenceCount: 0, status: 'voided' })).toEqual({ kind: 'count', count: 0 });
  });
  it('agrees with the submit gate for every category on a live record', () => {
    for (const category of ['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants', 'Water', 'Waste', 'Business Travel']) {
      for (const evidenceCount of [0, 2]) {
        const missing = evidenceCell({ category, evidenceCount, status: 'draft' }).kind === 'missing';
        expect(missing, `${category} with ${evidenceCount}`).toBe(needsEvidenceBeforeSubmit({ category, evidenceCount }));
      }
    }
  });
});

describe('recordsYearOptions', () => {
  it('adds a pinned year outside the form range, newest first', () => {
    const state = pickRecordsFilter(blankRecordsFilter('sub-a'), 'sub-a', { year: 2010 });
    const filter = resolveRecordsFilter(state, 'sub-a', 2026);
    expect(recordsYearOptions([2026, 2025, 2024], filter)).toEqual([2026, 2025, 2024, 2010]);
  });
  it('adds nothing for a year already offered or for All years', () => {
    expect(recordsYearOptions([2026, 2025], { year: 2025, status: 'all', category: 'all' })).toEqual([2026, 2025]);
    expect(recordsYearOptions([2026, 2025], { year: 'all', status: 'all', category: 'all' })).toEqual([2026, 2025]);
  });
  it('does not change the list it was given', () => {
    const base = [2026] as const;
    recordsYearOptions(base, { year: 2010, status: 'all', category: 'all' });
    expect(base).toEqual([2026]);
  });
});

describe('the way to the records table from the top of Data Entry (uat4-quick-fixes, BUG-15)', () => {
  it('says the count, that there are none yet, or neither while the count is unknown', () => {
    expect(entriesJumpWording(12)).toEqual({ key: 'jump.count', count: 12 });
    expect(entriesJumpWording(1)).toEqual({ key: 'jump.count', count: 1 });
    expect(entriesJumpWording(0)).toEqual({ key: 'jump.none' });
    expect(entriesJumpWording(null)).toEqual({ key: 'jump.unknown' });
  });

  const render = (locale: 'en' | 'tr', total: number | null) =>
    renderToStaticMarkup(createElement(IntlProvider, {
      locale, timeZone: 'UTC', messages: MESSAGES[locale],
      children: createElement(EntriesJump, { total }),
    }));

  it.each([
    ['en', 12, 'View or edit your entries (12)'],
    ['en', 3, 'View or edit your entries (3)'],
    ['en', 0, 'View or edit your entries (none yet)'],
    ['en', null, 'View or edit your entries'],
    ['tr', 12, 'Girdiğiniz verileri görüntüleyin / düzenleyin (12)'],
    ['tr', 0, 'Girdiğiniz verileri görüntüleyin / düzenleyin (henüz yok)'],
    ['tr', null, 'Girdiğiniz verileri görüntüleyin / düzenleyin'],
  ] as const)('%s: a total of %s reads "%s"', (locale, total, label) => {
    const html = render(locale, total);
    expect(html).toContain(`${label}</button>`);
    // A button, never a link: a jump must not read as a navigation.
    expect(html).toMatch(/<button[^>]*type="button"[^>]*data-testid="entries-jump"|<button[^>]*data-testid="entries-jump"[^>]*type="button"/);
    expect(html).not.toContain('<a ');
  });

  const target = () => {
    const calls: string[] = [];
    const heading: JumpTarget = {
      scrollIntoView: (options) => calls.push(`scroll:${options.behavior}:${options.block}`),
      focus: (options) => calls.push(`focus:preventScroll=${options.preventScroll}`),
    };
    return { calls, heading };
  };

  it('scrolls to the table heading and puts focus on it', () => {
    const { calls, heading } = target();
    const asked: string[] = [];
    const went = jumpToRecords((id) => { asked.push(id); return heading; }, false);
    expect(went).toBe(true);
    expect(asked).toEqual([RECORDS_HEADING_ID]);
    expect(calls).toEqual(['scroll:smooth:start', 'focus:preventScroll=true']);
  });

  it('jumps without an animated scroll when the system asks for reduced motion', () => {
    const { calls, heading } = target();
    jumpToRecords(() => heading, true);
    expect(calls).toEqual(['scroll:auto:start', 'focus:preventScroll=true']);
  });

  it('does nothing, and says so, when the table is not on the page', () => {
    expect(jumpToRecords(() => null, false)).toBe(false);
  });
});

describe("a fuel batch's record (inc28-fuel-bulk D16)", () => {
  it("links a batch's record to its batch, and no other record", () => {
    expect(fuelBatchLink({ fuelBatchId: "b-1" })).toBe("/fuel-files?batch=b-1");
    expect(fuelBatchLink({ fuelBatchId: null })).toBeNull();
    expect(fuelBatchLink({})).toBeNull();
  });
});
