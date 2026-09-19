import { describe, it, expect } from 'vitest';
import {
  VOID_REASON_MAX_LENGTH,
  VOID_REASON_MIN_LENGTH,
  canOfferVoid,
  entityLabel,
  voidConsequence,
  voidReasonError,
  voidSuccessMessage,
} from './void-view';
import type {
  ActivityCalculationSnapshot,
  ActivityRecordDTO,
  ActivityRecordStatus,
} from './types';

/**
 * Void is the only irreversible mutation in the product: the API has no route
 * back from `voided`, and `audit_log` is append-only, so a wrong click cannot
 * be tidied away afterwards. The warning and the seat check are therefore the
 * whole safety story on this side of the wire, and both are asserted here
 * rather than trusted to a screen.
 */

const calculated = (tCo2e: number): ActivityCalculationSnapshot => ({
  category: 'Electricity',
  geographyCode: 'TR',
  reportingYear: 2026,
  scope: 2,
  inputValue: 127_600,
  inputUnit: 'kWh',
  normalizedValue: 127_600,
  normalizedUnit: 'kWh',
  conversionApplied: false,
  kgCo2e: tCo2e * 1000,
  tCo2e,
  factorId: 'factor-1',
  factorValue: 0.44,
  factorUnit: 'kgCO2e/kWh',
  methodology: 'location-based',
  source: 'Demo factor set',
  version: '2026.1',
});

/** The shape a category with no factor writes instead of a figure. */
const uncalculated: ActivityCalculationSnapshot = {
  snapshotSchema: 1,
  category: 'Water',
  geographyCode: 'TR',
  reportingYear: 2026,
  scope: 3,
  inputValue: 500,
  inputUnit: 'm3',
  reasonCode: 'no_emission_factor',
  reason: 'No emission factor is published for Water in TR for 2026.',
};

const record = (over: Partial<ActivityRecordDTO> = {}): ActivityRecordDTO => ({
  id: 'rec-1',
  importBatchId: null,
  subsidiaryId: 'sub-1',
  locationId: null,
  reportingYear: 2026,
  reportingPeriod: 'monthly',
  periodValue: 'January',
  category: 'Electricity',
  scope: 2,
  status: 'approved',
  activityValue: 127_600,
  activityUnit: 'kWh',
  input: null,
  calculation: calculated(56.144),
  createdBy: 'user-1',
  createdByName: 'Entry User',
  reviewedByName: null,
  submittedAt: null,
  anomalyFlag: false,
  anomalyBaselinePriorCount: 3,
  anomalyBaselineTCo2e: 54.2,
  varianceReason: null,
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  voidReason: null,
  voidedBy: null,
  voidedByName: null,
  voidedAt: null,
  evidenceCount: 1,
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  ...over,
});

describe('canOfferVoid', () => {
  it('offers the control only to a super_admin', () => {
    expect(canOfferVoid({ status: 'approved' }, true)).toBe(true);
    // A consultant may take a record into review and send it back, but the
    // service refuses their void with a 403. Rendering a button that always
    // fails would teach the seat to distrust the screen.
    expect(canOfferVoid({ status: 'approved' }, false)).toBe(false);
  });

  it('offers it on approved records and nothing else', () => {
    // `approved` is the only status the service accepts. The rest each have
    // their own route — and `locked` in particular must be unlocked first, so
    // offering void there would send the user down a path the API rejects.
    const refused: ActivityRecordStatus[] = [
      'draft',
      'submitted',
      'under_review',
      'rejected',
      'locked',
      'voided',
    ];
    for (const status of refused) {
      expect(canOfferVoid({ status }, true)).toBe(false);
    }
    expect(canOfferVoid({ status: 'approved' }, true)).toBe(true);
  });
});

describe('voidReasonError', () => {
  it('rejects whitespace that only looks like an explanation', () => {
    // The DTO trims before it measures. A client that counted raw length would
    // enable the button on twelve spaces and let the request 400.
    expect(voidReasonError('            ')).not.toBeNull();
    expect(voidReasonError('')).not.toBeNull();
  });

  it('holds the minimum the server enforces, exactly', () => {
    // The VALUES, not just the boundary. Pinning `'a'.repeat(MIN)` against MIN
    // is pinning a constant to itself: a mutant that raised the maximum to
    // 20,000 passed the whole suite, and would have let a user type 3,000
    // characters into a box the DTO refuses. Both constants now come from
    // shared-types, and these two lines are what makes changing them
    // deliberate on both sides of the wire at once.
    expect(VOID_REASON_MIN_LENGTH).toBe(10);
    expect(VOID_REASON_MAX_LENGTH).toBe(2000);

    const nine = 'a'.repeat(VOID_REASON_MIN_LENGTH - 1);
    const ten = 'a'.repeat(VOID_REASON_MIN_LENGTH);
    expect(voidReasonError(nine)).not.toBeNull();
    expect(voidReasonError(ten)).toBeNull();
    // Padding must not buy length: this trims to nine.
    expect(voidReasonError(`   ${nine}   `)).not.toBeNull();
  });

  it('counts progress towards the minimum so the user is not guessing', () => {
    // The message is the only feedback on a disabled button; without the count
    // "at least 10 characters" reads as a rule, not as a distance.
    expect(voidReasonError('abcd')).toContain('4 so far');
    // And it counts what the SERVER will count. Reporting the untrimmed length
    // put "(13 so far)" beside a button disabled for being under ten — the
    // message contradicting the control it explains.
    expect(voidReasonError('   abcdefg   ')).toContain('7 so far');
  });

  it('holds the maximum exactly, and says something different about it', () => {
    expect(voidReasonError('a'.repeat(VOID_REASON_MAX_LENGTH))).toBeNull();
    const tooLong = voidReasonError('a'.repeat(VOID_REASON_MAX_LENGTH + 1));
    expect(tooLong).not.toBeNull();
    // Three rejection branches, three messages that are ABOUT their branch.
    // Asserting only `not.toBeNull()` let the over-maximum case return the
    // under-minimum text, so a 2,500-character reason read "at least 10
    // characters (2500 so far)" — and merely asserting the three differ did not
    // catch it either, because the embedded count made them differ anyway.
    expect(tooLong).toContain(String(VOID_REASON_MAX_LENGTH).slice(0, 1));
    expect(tooLong).toMatch(/cannot run past/i);
    expect(tooLong).not.toMatch(/at least/i);
    expect(voidReasonError('short')).toMatch(/at least/i);
    expect(voidReasonError('')).not.toMatch(/at least|cannot run past/i);
  });
});

describe('entityLabel', () => {
  it('names the site, or says the row is the whole company', () => {
    expect(entityLabel({ locationId: 'loc-1', locationName: 'Istanbul HQ' })).toBe('Istanbul HQ');
    expect(entityLabel({ locationId: null, locationName: null })).toBe('Whole company');
    // Whitespace is not a name. A blank label here would read as a site whose
    // name failed to load, on the field the reader uses to tell a pair apart.
    expect(entityLabel({ locationId: null, locationName: '   ' })).toBe('Whole company');
  });

  it('does not call a SITE row the whole company when the name is missing', () => {
    // `locationName` rides on an `include`; `locationId` is the fact. This is
    // the dialog that precedes an irreversible write, so getting the entity
    // wrong here is worse than getting it vague.
    expect(entityLabel({ locationId: 'loc-1', locationName: null })).toBe(
      'Site (name unavailable)',
    );
  });
});

describe('voidConsequence', () => {
  it('names WHICH record is about to be withdrawn', () => {
    // The blocker this exists for: the first live use of the void endpoint
    // withdrew the wrong half of a duplicate pair. The two rows differ only in
    // the reporting entity, and a dialog reading "this entity" gives the reader
    // nothing to check the click against.
    const site = voidConsequence(
      record({ locationName: 'Istanbul HQ' }),
      'TonyAI Energy',
    );
    expect(site.subject).toContain('Istanbul HQ');
    expect(site.subject).toContain('TonyAI Energy');
    expect(site.subject).toContain('Electricity');
    expect(site.subject).toContain('January 2026');

    // And its twin must not read identically — that is the whole point.
    const company = voidConsequence(record(), 'TonyAI Energy');
    expect(company.subject).toContain('Whole company');
    expect(company.subject).not.toBe(site.subject);
  });

  it('names the tonnage that is about to leave the inventory', () => {
    const { headline } = voidConsequence(record(), 'TonyAI Energy');
    // The number is the point of the confirmation. A generic "are you sure?"
    // gives the user nothing to check the click against.
    expect(headline).toContain('56.144');
    expect(headline).toContain('tCO₂e');
  });

  it('does not claim a figure for an entry that never had one', () => {
    const { headline } = voidConsequence(
      record({ category: 'Water', calculation: uncalculated }),
      'TonyAI Energy',
    );
    // "removes 0 tCO₂e" would read as "nothing happens", which is false — the
    // entry still leaves the completeness counts.
    expect(headline).not.toContain('0 tCO₂e');
    expect(headline).toContain('no tCO₂e figure');
  });

  // Each consequence asserted on its own. Checking only that the period string
  // appeared somewhere let a mutant invert the sentence — "March 2026 stays
  // closed, no corrected figure can be entered" satisfied it — and deleting
  // either of the first two lines outright broke nothing in the whole repo.
  it('says the figure stops counting', () => {
    const { effects } = voidConsequence(record(), 'TonyAI Energy');
    expect(effects.some((e) => /stops counting/i.test(e))).toBe(true);
  });

  it('says the period reopens for that entity, and that a figure can replace it', () => {
    // The half of the feature that is invisible on screen: the partial unique
    // index excludes voided rows, so the slot genuinely frees up. A user who
    // does not know that will assume the month is now unusable.
    const { effects } = voidConsequence(
      record({ periodValue: 'March', locationName: 'Istanbul HQ' }),
      'TonyAI Energy',
    );
    const reopening = effects.find((e) => e.includes('March 2026'));
    expect(reopening).toBeDefined();
    expect(reopening).toMatch(/reopens/i);
    expect(reopening).toContain('Istanbul HQ');
    expect(reopening).toMatch(/can be entered/i);
  });

  it('says the entry survives, with the reason, in the audit log', () => {
    const { effects } = voidConsequence(record(), 'TonyAI Energy');
    const kept = effects.find((e) => /stays on record/i.test(e));
    expect(kept).toBeDefined();
    expect(kept).toMatch(/audit log/i);
  });

  it('warns that the reason leaves the product inside every export', () => {
    // The reason is free text, uncorrectable, and since WP20 it is printed
    // verbatim into PDFs, spreadsheets and CSVs that go to third parties. A
    // dialog that only promises "stays on record" invites someone to write
    // something they would not put in front of an auditor.
    const { effects } = voidConsequence(record(), 'TonyAI Energy');
    const published = effects.find((e) => /printed verbatim/i.test(e));
    expect(published).toBeDefined();
    expect(published).toMatch(/PDF/);
    expect(published).toMatch(/Excel/);
    expect(published).toMatch(/CSV/);
    expect(published).toMatch(/cannot be edited/i);
  });

  it('states that it cannot be undone', () => {
    const { effects } = voidConsequence(record(), 'TonyAI Energy');
    expect(effects.some((e) => /cannot be undone/i.test(e))).toBe(true);
  });
});

describe('voidSuccessMessage', () => {
  it('reports how far the inventory moved', () => {
    expect(voidSuccessMessage(record())).toContain('56.144');
  });

  it('says something true when there was no figure', () => {
    const message = voidSuccessMessage(
      record({ category: 'Water', calculation: uncalculated }),
    );
    expect(message).not.toContain('NaN');
    expect(message).toContain('no longer counts');
  });
});
