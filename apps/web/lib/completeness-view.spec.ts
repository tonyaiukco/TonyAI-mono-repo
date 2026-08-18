import { describe, it, expect } from 'vitest';
import {
  deriveEntryCoverage,
  reviewNote,
  shortfallReasons,
  slotState,
} from './completeness-view';
import type {
  CategoryCompleteness,
  CompletenessSlot,
  SubsidiaryCompletenessDTO,
} from '@tonyai/shared-types';

/**
 * The sentences this module builds are the whole of what a data-entry user is
 * told about whether their year is finished. Round-1 DE-2 exists because the
 * screen said "green" when the truthful answer was "keyed in, but nobody has
 * looked at it" — so every assertion here is about a claim being TRUE, not
 * about a string being present.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** One site's twelve slots; `covered`/`awaiting` name the months in each state. */
function months(
  covered: string[] = [],
  awaiting: string[] = [],
): CompletenessSlot[] {
  return MONTHS.map((month) => ({
    month,
    covered: covered.includes(month) || awaiting.includes(month),
    awaitingReview: awaiting.includes(month),
  }));
}

function category(over: Partial<CategoryCompleteness> = {}): CategoryCompleteness {
  return {
    category: 'Electricity',
    required: 12,
    covered: 0,
    unattributedRecords: 0,
    nonMonthlyRecords: 0,
    missingEvidenceRecords: 0,
    outOfScopeRecords: 0,
    awaitingReviewSlots: 0,
    companyLevelMonths: [],
    locations: [{ locationId: 'loc-1', locationName: 'Ankara Power Plant', months: months() }],
    ...over,
  } as CategoryCompleteness;
}

function dto(over: Partial<SubsidiaryCompletenessDTO> = {}): SubsidiaryCompletenessDTO {
  return {
    subsidiaryId: 'sub-1',
    reportingYear: 2026,
    trackingGranularity: 'location',
    locationCount: 1,
    categories: [category()],
    ...over,
  };
}

const derive = (
  data: SubsidiaryCompletenessDTO,
  over: Partial<Parameters<typeof deriveEntryCoverage>[0]> = {},
) =>
  deriveEntryCoverage({
    data,
    category: 'Electricity',
    locationId: 'loc-1',
    reportingPeriod: 'monthly',
    periodValue: 'January',
    ...over,
  });

describe('slotState', () => {
  it('separates an accepted invoice from one waiting for review', () => {
    expect(slotState({ month: 'January', covered: true, awaitingReview: false }, [])).toBe('accepted');
    expect(slotState({ month: 'January', covered: true, awaitingReview: true }, [])).toBe('awaiting');
  });

  it('marks an open month recorded company-wide, so the grid can refuse the click', () => {
    const open: CompletenessSlot = { month: 'January', covered: false, awaitingReview: false };
    expect(slotState(open, ['january'])).toBe('company');
    expect(slotState(open, ['february'])).toBe('open');
  });
});

describe('shortfallReasons', () => {
  it('names only the counts that are actually non-zero', () => {
    const reasons = shortfallReasons(
      category({ unattributedRecords: 3, missingEvidenceRecords: 1 }),
      2026,
    );
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('3 entries are');
    // Singular and plural both matter: these lines are read by testers who
    // report the wording back as a bug when it reads "1 entries are".
    expect(reasons[1]).toContain('1 entry is');
  });

  it('says nothing when every committed record closed its slot', () => {
    expect(shortfallReasons(category({ covered: 12 }), 2026)).toEqual([]);
  });
});

describe('reviewNote', () => {
  it('explains a yellow status that the shortfall lines cannot account for', () => {
    // The cell can read 24 of 24 and still be yellow. Without this line there is
    // nothing on screen saying why.
    expect(reviewNote(6)).toContain('6 invoices are keyed in but still waiting');
    expect(reviewNote(1)).toContain('1 invoice is keyed in');
  });

  it('is absent when nothing is queued', () => {
    expect(reviewNote(0)).toBeNull();
    expect(reviewNote(-1)).toBeNull();
  });
});

describe('deriveEntryCoverage — when the rule does not apply', () => {
  it('says a whole-company subsidiary has no per-site targets, rather than 0 of 0', () => {
    const view = derive(dto({ trackingGranularity: 'subsidiary', categories: [] }));
    expect(view.kind).toBe('whole_company');
  });

  it('says so for a category outside the invoice rule', () => {
    const view = derive(dto(), { category: 'Fuel' });
    expect(view).toEqual({ kind: 'category_not_tracked', category: 'Fuel' });
  });

  it('refuses to call a year with no sites complete', () => {
    // Reachable: the denominator only counts sites that existed at the end of
    // the reported year. `required` is 0, and every obvious complete-check
    // (`covered >= required`) would put a green tick over a year in which
    // nothing was tracked at all.
    const view = derive(dto({ categories: [category({ required: 0, locations: [] })] }));
    expect(view.kind).toBe('no_locations');
  });
});

describe('deriveEntryCoverage — the DE-2 status', () => {
  it('is not complete while an invoice is still waiting for review', () => {
    const view = derive(
      dto({
        categories: [
          category({
            covered: 12,
            awaitingReviewSlots: 2,
            locations: [
              {
                locationId: 'loc-1',
                locationName: 'Ankara Power Plant',
                months: months(MONTHS.slice(0, 10), ['November', 'December']),
              },
            ],
          }),
        ],
      }),
    );

    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    // Every slot is closed — the data IS all in, and the headline says so.
    expect(view.covered).toBe(12);
    expect(view.headline).toBe('12 of 12 invoices keyed in');
    // What is not true is that the collection is finished. This is DE-2.
    expect(view.status).toBe('awaiting_review');
    expect(view.accepted).toBe(10);
    expect(view.reasons.some((r) => r.includes('waiting for review'))).toBe(true);
  });

  it('is complete only once every slot is accepted', () => {
    const view = derive(
      dto({
        categories: [
          category({
            covered: 12,
            awaitingReviewSlots: 0,
            locations: [
              {
                locationId: 'loc-1',
                locationName: 'Ankara Power Plant',
                months: months(MONTHS),
              },
            ],
          }),
        ],
      }),
    );

    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.status).toBe('complete');
    expect(view.accepted).toBe(12);
    expect(view.reasons).toEqual([]);
  });

  it('is in progress while slots are still open', () => {
    const view = derive(dto({ categories: [category({ covered: 5 })] }));
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.status).toBe('in_progress');
    expect(view.headline).toBe('5 of 12 invoices keyed in');
  });
});

describe('deriveEntryCoverage — warnings about what is being keyed in', () => {
  it('says a whole-company entry closes none of the site invoices', () => {
    const view = derive(dto(), { locationId: '' });
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    // The honest form of the thing that made a tester read green as "done".
    expect(view.warnings[0]).toContain('closes none of the 12 site invoices');
    // No site is selected, so there is no row of months to show.
    expect(view.selected).toBeNull();
  });

  it('warns before a month is recorded twice', () => {
    const view = derive(
      dto({ categories: [category({ companyLevelMonths: ['january'] })] }),
      { periodValue: 'January' },
    );
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    // Nothing downstream deduplicates and the uniqueness index cannot catch it
    // (different location_id), so this sentence is the only guard on the screen
    // where the record is actually written.
    expect(view.warnings[0]).toContain('count that month twice');
    expect(view.warnings[0]).toContain('January 2026');
  });

  it('does not warn about a month recorded company-wide for a different month', () => {
    const view = derive(
      dto({ categories: [category({ companyLevelMonths: ['march'] })] }),
      { periodValue: 'January' },
    );
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.warnings).toEqual([]);
  });

  it('says a quarterly entry closes no slot', () => {
    const view = derive(dto(), { reportingPeriod: 'quarterly', periodValue: 'Q1' });
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.warnings[0]).toContain('closes no invoice slot');
  });

  it('explains a site that this year does not count, instead of showing nothing', () => {
    // A site created after the year ended has no row in the response. Rendering
    // it as "no months" would look identical to a whole-company entry — the one
    // case where an empty panel is correct.
    const view = derive(dto(), { locationId: 'loc-new' });
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.warnings[0]).toContain('created after that year ended');
    expect(view.selected).toBeNull();
  });
});

describe('deriveEntryCoverage — the selected site', () => {
  it('returns that site s own twelve months, in the four states', () => {
    const view = derive(
      dto({
        categories: [
          category({
            covered: 2,
            awaitingReviewSlots: 1,
            companyLevelMonths: ['march'],
            locations: [
              {
                locationId: 'loc-1',
                locationName: 'Ankara Power Plant',
                months: months(['January'], ['February']),
              },
              {
                locationId: 'loc-2',
                locationName: 'Izmir Depot',
                months: months(MONTHS),
              },
            ],
          }),
        ],
      }),
    );

    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.selected?.locationName).toBe('Ankara Power Plant');
    const state = (m: string) =>
      view.selected?.months.find((x) => x.month === m)?.state;
    expect(state('January')).toBe('accepted');
    expect(state('February')).toBe('awaiting');
    expect(state('March')).toBe('company');
    expect(state('April')).toBe('open');
    // The other site's row must not leak into the panel for this one.
    expect(view.selected?.months).toHaveLength(12);
  });
});
