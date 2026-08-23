import { describe, it, expect } from 'vitest';
import {
  deriveEntryCoverage,
  duplicateNote,
  duplicatedMonths,
  reviewBadge,
  reviewNote,
  reviewSentence,
  shortfallReasons,
  slotState,
  unreviewedRecordsNote,
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
    // The server's verdict. Defaulted to `incomplete` because that is what the
    // API returns for the fixture's shape (0 of 12 covered) — a fixture that
    // silently defaulted to `complete` would let a test assert green for the
    // wrong reason.
    status: 'incomplete',
    required: 12,
    covered: 0,
    unattributedRecords: 0,
    nonMonthlyRecords: 0,
    missingEvidenceRecords: 0,
    outOfScopeRecords: 0,
    awaitingReviewSlots: 0,
    awaitingReviewRecords: 0,
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
    // Most cases here are about what the panel says while an entry is being
    // keyed, so the fixture assumes one. The gate itself is tested explicitly.
    hasEntry: true,
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
    // The verb matters too — this line used to read "1 entry is with no
    // invoice attached", because one helper supplied a verb to four sentences
    // that do not all take the same one.
    expect(reasons[1]).toBe('1 entry has no invoice attached.');
  });

  it('names a stray non-monthly entry, so a shortfall beside 12 records is accounted for', () => {
    expect(shortfallReasons(category({ nonMonthlyRecords: 2 }), 2026)).toEqual([
      '2 entries are not reported as a single month, so none of them stands in for a monthly invoice.',
    ]);
  });

  it('names records at a site the year does not cover, with that year in the sentence', () => {
    // The year is interpolated, so the sentence is wrong for every year but one
    // if the argument is ever dropped.
    expect(shortfallReasons(category({ outOfScopeRecords: 1 }), 2024)[0]).toBe(
      '1 entry is at a site that did not exist yet at the end of 2024, so there is no row for them.',
    );
  });

  it('says nothing when every committed record closed its slot', () => {
    expect(shortfallReasons(category({ covered: 12 }), 2026)).toEqual([]);
  });
});

describe('duplicatedMonths', () => {
  const both = (over = {}) =>
    category({
      companyLevelMonths: ['january'],
      locations: [
        {
          locationId: 'loc-1',
          locationName: 'Ankara Power Plant',
          months: months(['January']),
        },
      ],
      ...over,
    });

  it('names a month recorded at a site AND for the whole company', () => {
    // Both rows feed the emissions total and nothing deduplicates them, so this
    // month is already counted twice. Reachable on the seeded database.
    expect(duplicatedMonths(both())).toEqual(['January']);
    expect(duplicateNote(['January'])).toContain('already counted twice');
  });

  it('says nothing when the site slot is still open', () => {
    // Here the company-level entry means the site slot renders `company` and
    // the grid warns that keying it WOULD double-count. Nothing has yet.
    expect(
      duplicatedMonths(
        both({
          locations: [
            { locationId: 'loc-1', locationName: 'Ankara Power Plant', months: months() },
          ],
        }),
      ),
    ).toEqual([]);
    expect(duplicateNote([])).toBeNull();
  });

  it('counts a month once even when several sites hold it', () => {
    const c = both({
      locations: [
        { locationId: 'loc-1', locationName: 'Ankara Power Plant', months: months(['January']) },
        { locationId: 'loc-2', locationName: 'Izmir Depot', months: months(['January']) },
      ],
    });
    expect(duplicatedMonths(c)).toEqual(['January']);
  });
});

describe('reviewNote', () => {
  it('explains a yellow status that the shortfall lines cannot account for', () => {
    // The cell can read 24 of 24 and still be yellow. Without this line there is
    // nothing on screen saying why.
    //
    // Pinned WHOLE, not by its opening clause. Substring assertions let the
    // operative half be rewritten to say the opposite — "so this category is
    // finished and needs nothing further" passed every check here — and the
    // operative half is the only part that tells a user to act.
    expect(reviewNote(6)).toBe(
      '6 invoices are keyed in but still waiting for review, so this category is not finished yet.',
    );
    expect(reviewNote(1)).toBe(
      '1 invoice is keyed in but still waiting for review, so this category is not finished yet.',
    );
  });

  it('is absent when nothing is queued', () => {
    expect(reviewNote(0)).toBeNull();
    expect(reviewNote(-1)).toBeNull();
  });
});

describe('unreviewedRecordsNote', () => {
  it('explains an amber cell that has no invoice counters to explain it', () => {
    // WP19's branch counts RECORDS, has no denominator and no shortfall lines,
    // so this sentence is the entire explanation such a cell can offer — which
    // is why it is pinned whole rather than by substring. Asserting only the
    // opening clause let the ending be reversed to "so this category is
    // finished and needs nothing further" with the suite still green.
    expect(unreviewedRecordsNote(3)).toBe(
      '3 entries are keyed in but nobody has reviewed them yet, so this category is not finished.',
    );
    expect(unreviewedRecordsNote(1)).toBe(
      '1 entry is keyed in but nobody has reviewed it yet, so this category is not finished.',
    );
  });

  it('is absent when nothing is waiting', () => {
    expect(unreviewedRecordsNote(0)).toBeNull();
    expect(unreviewedRecordsNote(-1)).toBeNull();
  });

  it('makes both halves of its claim, and neither of the wrong ones', () => {
    // Two things have to be true at once and each guards a different mistake.
    // "The data is in" stops a user who keyed a full year being sent to look
    // for work that does not exist; "not finished" is what tells them there is
    // still something to do. Assert both — the second half was unguarded, and a
    // sentence claiming the category WAS finished passed the whole suite.
    const note = unreviewedRecordsNote(4)!;
    expect(note).not.toMatch(/missing|no data|not entered/i);
    expect(note).toContain('keyed in');
    expect(note).toContain('is not finished');
    expect(note).not.toMatch(/needs nothing|is finished and|nothing further/i);
  });

  it('counts a different thing from reviewNote and says so in its own words', () => {
    // Records here, invoices there. A reader who saw the same noun twice would
    // reasonably subtract one from the other; the units do not allow it.
    expect(unreviewedRecordsNote(2)).not.toContain('invoice');
    expect(reviewNote(2)).toContain('invoices');
  });
});

describe('reviewSentence — one unit per cell, never two', () => {
  it('speaks in invoices when months are waiting', () => {
    expect(reviewSentence({ awaitingReviewSlots: 3, awaitingReviewRecords: 4 })).toContain(
      '3 invoices are keyed in',
    );
  });

  it('falls back to entries when no month is waiting but a record is', () => {
    // The case the slot count cannot see: every month closed AND accepted,
    // with a whole-company record behind them still unreviewed. Without this
    // arm the cell is amber and nothing on screen accounts for it.
    expect(reviewSentence({ awaitingReviewSlots: 0, awaitingReviewRecords: 1 })).toContain(
      '1 entry is keyed in',
    );
  });

  it('speaks in entries for a cell that has no denominator at all', () => {
    expect(reviewSentence({ awaitingReviewRecords: 2 })).toContain('2 entries are keyed in');
  });

  it('says nothing when nothing is waiting', () => {
    expect(reviewSentence({ awaitingReviewSlots: 0, awaitingReviewRecords: 0 })).toBeNull();
    expect(reviewSentence({ awaitingReviewRecords: 0 })).toBeNull();
  });

  it('never emits both units at once', () => {
    // Records and slots count different things. A cell printing "3 invoices are
    // keyed in…" beside a record count invites a reader to subtract one from
    // the other and find a discrepancy that is not there.
    const s = reviewSentence({ awaitingReviewSlots: 3, awaitingReviewRecords: 4 })!;
    expect(s).not.toContain('4');
    expect(s).not.toContain('entries');
  });
});

describe('reviewBadge — the same choice, compressed', () => {
  it('carries its unit, in both arms', () => {
    // "1 awaiting review" beside a face reading "3/24" reads as one of those
    // invoices. The unit is the whole point of the word.
    expect(reviewBadge({ awaitingReviewSlots: 1, awaitingReviewRecords: 9 })).toBe(
      '1 invoice awaiting review',
    );
    expect(reviewBadge({ awaitingReviewSlots: 2, awaitingReviewRecords: 9 })).toBe(
      '2 invoices awaiting review',
    );
    expect(reviewBadge({ awaitingReviewRecords: 1 })).toBe('1 entry awaiting review');
    expect(reviewBadge({ awaitingReviewRecords: 3 })).toBe('3 entries awaiting review');
  });

  it('agrees with reviewSentence about which unit this cell speaks', () => {
    // They are rendered together — the badge in the accessible name, the
    // sentence in the tooltip. Disagreeing told a screen-reader user a
    // different number from the one on screen, in a different unit.
    const input = { awaitingReviewSlots: 3, awaitingReviewRecords: 4 };
    expect(reviewBadge(input)).toContain('invoice');
    expect(reviewSentence(input)).toContain('invoice');
    const records = { awaitingReviewSlots: 0, awaitingReviewRecords: 4 };
    expect(reviewBadge(records)).toContain('entries');
    expect(reviewSentence(records)).toContain('entries');
  });

  it('says nothing when nothing is waiting', () => {
    expect(reviewBadge({ awaitingReviewSlots: 0, awaitingReviewRecords: 0 })).toBeNull();
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

  it('still names the records that exist when no site is in scope', () => {
    // Highly reachable: every seeded location was created in 2026, so every
    // earlier year in the picker lands here. An earlier cut answered "there are
    // no invoices to track" and silently dropped twelve real entries.
    const view = derive(
      dto({ categories: [category({ required: 0, locations: [], outOfScopeRecords: 12 })] }),
    );
    if (view.kind !== 'no_locations') throw new Error(`expected no_locations, got ${view.kind}`);
    expect(view.reasons.some((r) => r.includes('12 entries are at a site'))).toBe(true);
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
  it('reports the numbers behind an invoice still waiting for review', () => {
    const view = derive(
      dto({
        categories: [
          category({
            status: 'incomplete',
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
    expect(view.status).toBe('incomplete');
    expect(view.accepted).toBe(10);
    expect(view.reasons.some((r) => r.includes('waiting for review'))).toBe(true);
  });

  it('NEVER promotes the server’s verdict, even with every slot approved', () => {
    // The case that made this a blocker in review. The server says `incomplete`
    // because of a draft, or an anomaly flag — neither of which corresponds to
    // any field in this response. A client deriving its own verdict from
    // `covered >= required` badges "Complete" over a cell the dashboard is
    // showing amber, for the same subsidiary, category and year. That is DE-2's
    // own failure (a green that overstates) one level up, and it is permanent:
    // approving a record does not clear its anomaly flag.
    const view = derive(
      dto({
        categories: [
          category({
            status: 'incomplete',
            covered: 12,
            awaitingReviewSlots: 0,
            locations: [
              { locationId: 'loc-1', locationName: 'Ankara Power Plant', months: months(MONTHS) },
            ],
          }),
        ],
      }),
    );

    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.accepted).toBe(12);
    expect(view.status).toBe('incomplete');
  });

  it('is complete when — and only when — the server says so', () => {
    const view = derive(
      dto({
        categories: [
          category({
            status: 'complete',
            covered: 12,
            awaitingReviewSlots: 0,
            locations: [
              { locationId: 'loc-1', locationName: 'Ankara Power Plant', months: months(MONTHS) },
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

  it('carries a missing cell through as missing, rather than renaming it', () => {
    // The dashboard calls this cell Missing. An earlier cut of the panel called
    // the same cell "In progress" — two names for one state, on two screens a
    // tester moves between.
    const view = derive(dto({ categories: [category({ status: 'missing' })] }));
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.status).toBe('missing');
    expect(view.headline).toBe('0 of 12 invoices keyed in');
  });

  it('never reports more approved than keyed in, even if the contract breaks', () => {
    // `awaitingReviewSlots` is a subset of `covered` by construction on the
    // server, so this is unreachable today — but the panel subtracts them, and
    // "-3 of those approved" is the kind of number that ends up in a screenshot.
    const view = derive(
      dto({ categories: [category({ covered: 0, awaitingReviewSlots: 3 })] }),
    );
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.accepted).toBe(0);
  });

  it('names a month already counted twice, in the present tense', () => {
    const view = derive(
      dto({
        categories: [
          category({
            covered: 1,
            companyLevelMonths: ['january'],
            locations: [
              {
                locationId: 'loc-1',
                locationName: 'Ankara Power Plant',
                months: months(['January']),
              },
            ],
          }),
        ],
      }),
    );
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    // A statement about existing data, so it belongs with the reasons and is
    // NOT gated on an entry being in progress. The future tense was the only
    // wording here, and it was wrong for exactly this case — warning that a
    // month "would" be counted twice while it already was.
    expect(view.reasons.some((r) => r.includes('already counted twice'))).toBe(true);
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

  it('writes "An annual entry", not "A annual entry"', () => {
    // `annual` is a real ReportingPeriod value, so this sentence renders.
    const view = derive(dto(), { reportingPeriod: 'annual', periodValue: '2026' });
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.warnings[0]).toContain('An annual entry');
  });

  it('stays silent until there is actually an entry', () => {
    // Every warning is a claim about "this entry". Ungated, a freshly-loaded
    // screen opened an amber alert about an entry nobody had begun — and showed
    // it again immediately after a successful submit, because the form resets
    // before the panel refetches.
    const view = derive(dto(), { locationId: '', hasEntry: false });
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.warnings).toEqual([]);
    // The rest of the card describes recorded data and must survive the gate.
    expect(view.headline).toBe('0 of 12 invoices keyed in');
  });

  it('still warns about the double count when the site is outside the year', () => {
    // These used to be one else-if chain, so picking a site created after the
    // year ended swallowed the duplicate warning — while the duplicate stayed
    // real, because the emissions total counts every committed record whatever
    // the denominator covers.
    const view = derive(
      dto({ categories: [category({ companyLevelMonths: ['january'] })] }),
      { locationId: 'loc-new', periodValue: 'January' },
    );
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.warnings.some((w) => w.includes('created after that year ended'))).toBe(true);
    expect(view.warnings.some((w) => w.includes('count that month twice'))).toBe(true);
  });

  it('does NOT warn about a double count when that record is the one being moved', () => {
    // The regression WP18 PR 1 introduced into a WP17 sentence. While the
    // client abandoned the edit on a location change, "keying a site invoice
    // for it as well" was guaranteed to create a second row and the warning was
    // true. Now the save MOVES the record out of the whole-company slot, so the
    // duplicate it warns about is the one the save is about to remove.
    const view = derive(
      dto({ categories: [category({ companyLevelMonths: ['january'] })] }),
      { periodValue: 'January', locationId: 'loc-1', movingFrom: '' },
    );
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.warnings.every((w) => !w.includes('count that month twice'))).toBe(true);
  });

  it('does NOT warn when a site record is being moved back to the whole company', () => {
    const view = derive(
      dto({
        categories: [
          category({
            covered: 1,
            locations: [
              {
                locationId: 'loc-1',
                locationName: 'Ankara Power Plant',
                months: months(['January']),
              },
            ],
          }),
        ],
      }),
      { locationId: '', periodValue: 'January', movingFrom: 'loc-1' },
    );
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.warnings.every((w) => !w.includes('would count it twice'))).toBe(true);
  });

  it('STILL warns when a record moves between two SITES over a company-held month', () => {
    // The exclusion must be "the record is leaving company level", not merely
    // "a move is pending". Ankara → Izmir still lands a site invoice on a month
    // the whole company already holds, so the double count is real and the
    // warning has to survive. Written because the looser predicate
    // (`movingFrom !== null`) passed every other test in this file.
    const view = derive(
      dto({ categories: [category({ companyLevelMonths: ['january'] })] }),
      { locationId: 'loc-2', movingFrom: 'loc-1', periodValue: 'January' },
    );
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.warnings.some((w) => w.includes('count that month twice'))).toBe(true);
  });

  it('STILL warns about a different site that holds the month, during a move', () => {
    // The move must be excluded from the duplicate check, not the check
    // suppressed. Moving loc-1's January to the whole company genuinely does
    // create a duplicate when loc-2 also holds January.
    const view = derive(
      dto({
        categories: [
          category({
            covered: 2,
            locations: [
              { locationId: 'loc-1', locationName: 'Ankara Power Plant', months: months(['January']) },
              { locationId: 'loc-2', locationName: 'Izmir Depot', months: months(['January']) },
            ],
          }),
        ],
      }),
      { locationId: '', periodValue: 'January', movingFrom: 'loc-1' },
    );
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    const warning = view.warnings.find((w) => w.includes('would count it twice'));
    expect(warning).toContain('Izmir Depot');
    // ...and must not accuse the site the record is leaving.
    expect(warning).not.toContain('Ankara Power Plant');
  });

  it('warns in the other direction too — a company entry over a month a site already holds', () => {
    // Key the site invoice first and the company record second and nothing
    // warned at all, though the month is double-counted either way round.
    const view = derive(
      dto({
        categories: [
          category({
            covered: 1,
            locations: [
              {
                locationId: 'loc-1',
                locationName: 'Ankara Power Plant',
                months: months(['January']),
              },
            ],
          }),
        ],
      }),
      { locationId: '', periodValue: 'January' },
    );
    if (view.kind !== 'tracked') throw new Error(`expected tracked, got ${view.kind}`);
    expect(view.warnings.some((w) => w.includes('Ankara Power Plant'))).toBe(true);
    expect(view.warnings.some((w) => w.includes('would count it twice'))).toBe(true);
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
