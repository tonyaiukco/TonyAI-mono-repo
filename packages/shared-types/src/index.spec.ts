import { describe, it, expect } from 'vitest';
import {
  CATEGORIES,
  EVIDENCE_REQUIRED_CATEGORIES,
  FACTORLESS_RECORDABLE_CATEGORIES,
  INVOICE_TRACKED_CATEGORIES,
  isCalculated,
  isEvidenceRequired,
  isInvoiceTracked,
  isRecordableWithoutFactor,
  isUncalculated,
  unitsForCategory,
  type CalculationResult,
  type UncalculatedSnapshot,
} from './index';

/**
 * The first tests in this package.
 *
 * They exist because `isCalculated()` is the predicate the whole WP17 change
 * rests on — every total, every export cell and every screen branches on it —
 * and it had no direct coverage at all: `packages/shared-types` had no `test`
 * script, so `pnpm test` ran nothing for it and mutating the predicate stayed
 * green across all 400-odd API tests.
 */

const calculated: CalculationResult = {
  category: 'Electricity',
  geographyCode: 'TR',
  reportingYear: 2026,
  scope: 2,
  inputValue: 1000,
  inputUnit: 'kWh',
  normalizedValue: 1000,
  normalizedUnit: 'kWh',
  conversionApplied: false,
  kgCo2e: 440,
  tCo2e: 0.44,
  factorId: 'factor-1',
  factorValue: 0.44,
  factorUnit: 'kgCO2e/kWh',
  methodology: 'location-based',
  source: 'demo',
  version: '2026.1',
};

const uncalculated: UncalculatedSnapshot = {
  snapshotSchema: 1,
  category: 'Water',
  geographyCode: 'TR',
  reportingYear: 2026,
  scope: 3,
  inputValue: 250,
  inputUnit: 'cubic_metres',
  reasonCode: 'no_emission_factor',
  reason: 'No emission factor is available for "Water"',
};

describe('isCalculated', () => {
  it('accepts a full factor-backed snapshot', () => {
    expect(isCalculated(calculated)).toBe(true);
  });

  it('rejects the uncalculated shape', () => {
    expect(isCalculated(uncalculated)).toBe(false);
  });

  it('rejects null and undefined rather than throwing', () => {
    expect(isCalculated(null)).toBe(false);
    expect(isCalculated(undefined)).toBe(false);
  });

  it('rejects an empty factorId', () => {
    // The `.length > 0` leg: `typeof '' === 'string'` is true, so without it a
    // snapshot carrying an empty id would narrow to "calculated".
    expect(isCalculated({ ...calculated, factorId: '' })).toBe(false);
  });

  it('rejects a factorId that is not a string', () => {
    expect(
      isCalculated({ ...calculated, factorId: 42 } as unknown as CalculationResult),
    ).toBe(false);
  });

  it('fails SAFE on a snapshot with a factor but no usable figure', () => {
    // How this occurs in practice: `NaN` and `Infinity` have no JSON
    // representation and serialise to `null` on the way into the column. The
    // predicate must not hand such a row to a formatter that will render "NaN"
    // to a user or throw on it.
    expect(isCalculated({ ...calculated, tCo2e: null } as unknown as CalculationResult)).toBe(false);
    expect(isCalculated({ ...calculated, tCo2e: NaN })).toBe(false);
    expect(isCalculated({ ...calculated, tCo2e: Infinity })).toBe(false);
  });
});

describe('isUncalculated', () => {
  it('recognises the explicit no-figure shape', () => {
    expect(isUncalculated(uncalculated)).toBe(true);
  });

  it('is not simply the negation of isCalculated', () => {
    // A malformed snapshot is neither: the display paths need to tell "the API
    // recorded why" from "this row is broken", and folding them together would
    // make a broken row render a confident, empty explanation.
    const malformed = { category: 'Water' } as unknown as UncalculatedSnapshot;
    expect(isCalculated(malformed)).toBe(false);
    expect(isUncalculated(malformed)).toBe(false);
  });

  it('rejects a calculated snapshot', () => {
    expect(isUncalculated(calculated)).toBe(false);
  });
});

describe('category rule sets', () => {
  it('every listed category is a real category', () => {
    for (const list of [
      EVIDENCE_REQUIRED_CATEGORIES,
      INVOICE_TRACKED_CATEGORIES,
      FACTORLESS_RECORDABLE_CATEGORIES,
    ]) {
      for (const category of list) {
        expect(CATEGORIES).toContain(category);
      }
    }
  });

  it('holds the invariant the stored reason string depends on', () => {
    // `compute()` writes a frozen sentence saying the entry is kept for
    // invoice-level completeness. That sentence is only true while everything
    // recordable-without-a-factor is also invoice-tracked.
    for (const category of FACTORLESS_RECORDABLE_CATEGORIES) {
      expect(isInvoiceTracked(category)).toBe(true);
    }
  });

  it('keeps the evidence gate and the completeness denominator distinct', () => {
    // Fuel is the case that proves they are different questions: it needs a
    // fuel log to be submitted, but it is not a metered utility and must not
    // inherit a `locations × 12 months` denominator.
    expect(isEvidenceRequired('Fuel')).toBe(true);
    expect(isInvoiceTracked('Fuel')).toBe(false);
  });

  it('requires evidence for every invoice-tracked category', () => {
    // Water is the one that was missed: with no factor there is no figure and
    // no anomaly check, so the invoice is its only verification.
    for (const category of INVOICE_TRACKED_CATEGORIES) {
      expect(isEvidenceRequired(category)).toBe(true);
    }
  });

  it('only Water may be recorded without a factor', () => {
    expect(isRecordableWithoutFactor('Water')).toBe(true);
    // The categories the product deliberately keeps unreportable until Phase 4
    // supplies cited factor values (round-1 DE-4 and DE-5).
    expect(isRecordableWithoutFactor('Refrigerants')).toBe(false);
    expect(isRecordableWithoutFactor('Mobile Combustion')).toBe(false);
    expect(isRecordableWithoutFactor('Electricity')).toBe(false);
  });
});

describe('unitsForCategory', () => {
  it('offers exactly one unit for Water', () => {
    const units = unitsForCategory('Water');
    expect(units.map((u) => u.value)).toEqual(['cubic_metres']);
  });

  it('never labels the shared m³ token as a natural-gas unit', () => {
    // The same token is the ONLY option for Water, where "(natural gas)" read
    // as a mislabelled field rather than a shared unit.
    const [m3] = unitsForCategory('Water');
    expect(m3.label).not.toMatch(/natural gas/i);
  });

  it('leaves a category with no rule unconstrained but never offers a blocked unit', () => {
    const units = unitsForCategory('Business Travel');
    expect(units.length).toBeGreaterThan(1);
    expect(units.every((u) => !u.blocked)).toBe(true);
  });
});
