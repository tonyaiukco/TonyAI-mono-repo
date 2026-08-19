import { describe, it, expect } from 'vitest';
import {
  VOID_REASON_MAX_LENGTH,
  VOID_REASON_MIN_LENGTH,
  canOfferVoid,
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
  anomalyFlag: false,
  varianceReason: null,
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  voidReason: null,
  voidedBy: null,
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
  });

  it('holds the maximum exactly', () => {
    expect(voidReasonError('a'.repeat(VOID_REASON_MAX_LENGTH))).toBeNull();
    expect(voidReasonError('a'.repeat(VOID_REASON_MAX_LENGTH + 1))).not.toBeNull();
  });
});

describe('voidConsequence', () => {
  it('names the tonnage that is about to leave the inventory', () => {
    const { headline } = voidConsequence(record());
    // The number is the point of the confirmation. A generic "are you sure?"
    // gives the user nothing to check the click against.
    expect(headline).toContain('56.144');
    expect(headline).toContain('tCO₂e');
  });

  it('does not claim a figure for an entry that never had one', () => {
    const { headline } = voidConsequence(
      record({ category: 'Water', calculation: uncalculated }),
    );
    // "removes 0 tCO₂e" would read as "nothing happens", which is false — the
    // entry still leaves the completeness counts.
    expect(headline).not.toContain('0 tCO₂e');
    expect(headline).toContain('no tCO₂e figure');
  });

  it('tells the user the period reopens, naming it', () => {
    // This is the half of the feature that is invisible on screen: the partial
    // unique index excludes voided rows, so the slot genuinely frees up. A user
    // who does not know that will assume the month is now unusable.
    const { effects } = voidConsequence(record({ periodValue: 'March' }));
    expect(effects.join(' ')).toContain('March 2026');
  });

  it('states that it cannot be undone', () => {
    const { effects } = voidConsequence(record());
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
