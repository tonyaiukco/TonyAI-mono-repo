import { describe, it, expect } from 'vitest';
import {
  isProvenanceSnapshot,
  normalizeRecordParameters,
  API_ERROR_PARAMS,
  API_ERROR_STATUS,
  CATEGORY_SCOPE_MAP,
  mayAuthorRecords,
  mayEditRecord,
  mayRecallRecord,
  mayCopyVoidedRecord,
  isRecallable,
  RECALLABLE_STATUSES,
  EDITABLE_RECORD_STATUSES,
  AUDIT_ACTIONS,
  acceptsBulkSubmit,
  BULK_SUBMITTABLE_STATUSES,
  isSubmittable,
  needsEvidenceBeforeSubmit,
  SUBMITTABLE_STATUSES,
  ANOMALY_BASELINE_PERIODS,
  ANOMALY_MIN_PRIORS,
  anomalyBasis,
  isLegacyShortWindowVerdict,
  anomalyNotEvaluated,
  computeAnomalyVerdict,
  ANOMALY_THRESHOLD,
  isAnomalyEvaluated,
  ACTIVITY_RECORD_STATUSES,
  entityLabel,
  UNNAMED_SITE_ENTITY_LABEL,
  WHOLE_COMPANY_ENTITY_LABEL,
  ACTIVITY_UNITS,
  canonicalPeriodValue,
  MONTH_NAMES,
  PERIOD_VALUES,
  REPORTING_PERIODS,
  COUNTED_STATUSES,
  PENDING_REVIEW_STATUSES,
  appliesUnitConversion,
  CATEGORIES,
  EVIDENCE_REQUIRED_CATEGORIES,
  FACTORLESS_RECORDABLE_CATEGORIES,
  INVOICE_TRACKED_CATEGORIES,
  isCalculated,
  isEvidenceRequired,
  isInvoiceTracked,
  isRecordableWithoutFactor,
  isUncalculated,
  TRACKING_GRANULARITIES,
  unitSymbol,
  unitsForCategory,
  type CalculationResult,
  type UncalculatedSnapshot,
  BULK_EQUIPMENT_COLUMNS,
  BULK_GAS_PARAMETER_COLUMNS,
  BULK_UPLOAD_COLUMNS,
  BULK_UPLOAD_REQUIRED_COLUMNS,
  BULK_UPLOAD_ERROR_CODES,
  BULK_UPLOAD_WARNING_CODES,
  BULK_SUBMIT_ISSUE_CODES,
  BULK_SUBMIT_MAX_IDS,
  BULK_UPLOAD_MAX_ROWS,
  EVIDENCE_MAX_LINKED_RECORDS,
  ENGLISH_ENTITY_WORDS,
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

  it('requires evidence for every Scope 1 and Scope 2 category (K3)', () => {
    // The gap BUG-R2-02 found: Mobile Combustion, Refrigerants and Fugitive Gas
    // became calculable after the list was written and were never added. A new
    // Scope 1–2 category fails here until someone decides its evidence rule.
    const scope12 = CATEGORIES.filter((c) => CATEGORY_SCOPE_MAP[c] !== 3);
    expect(scope12.length).toBeGreaterThan(0);
    for (const category of scope12) {
      expect(isEvidenceRequired(category)).toBe(true);
    }
    for (const category of ['Mobile Combustion', 'Refrigerants', 'Fugitive Gas']) {
      expect(isEvidenceRequired(category)).toBe(true);
    }
  });

  it('requires evidence for Water alone among Scope 3 categories', () => {
    const scope3Required = CATEGORIES.filter(
      (c) => CATEGORY_SCOPE_MAP[c] === 3 && isEvidenceRequired(c),
    );
    expect(scope3Required).toEqual(['Water']);
    expect(isEvidenceRequired('Waste')).toBe(false);
    expect(isEvidenceRequired('Business Travel')).toBe(false);
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

describe('TRACKING_GRANULARITIES', () => {
  it('offers exactly the two the Prisma enum declares', () => {
    // The DTO validates against this list, and deleting the `@IsIn` that reads
    // it was a surviving mutant — any string was accepted as a granularity.
    expect([...TRACKING_GRANULARITIES]).toEqual(['subsidiary', 'location']);
  });
});

describe('unitSymbol', () => {
  it('writes the m³ token as a unit, not as a storage key', () => {
    // "Recorded as 250 cubic_metres" reached three screens. The token is how
    // the value is stored; it is not how a unit is written next to a number.
    expect(unitSymbol('cubic_metres')).toBe('m³');
    expect(unitSymbol('standard_cubic_metres')).toBe('Sm³');
    expect(unitSymbol('uk_gallons')).toBe('UK gal');
    expect(unitSymbol('passenger_kilometres')).toBe('p-km');
  });

  it('never leaves an underscore in a symbol', () => {
    for (const unit of ACTIVITY_UNITS) {
      expect(unit.symbol).not.toMatch(/_/);
      expect(unit.symbol.length).toBeGreaterThan(0);
    }
  });

  it('falls back to the raw token for an unknown unit', () => {
    // Preferable to rendering nothing at all beside a number.
    expect(unitSymbol('furlongs')).toBe('furlongs');
  });
});

describe('appliesUnitConversion', () => {
  it('is true for natural gas in m³ — the ×11.36 case the note describes', () => {
    expect(appliesUnitConversion('cubic_metres', 'Natural Gas')).toBe(true);
  });

  it('is FALSE for water in m³, which is the bug this predicate exists for', () => {
    // Keyed on the unit alone, Data Entry told the user their water meter had
    // been converted to kWh at the natural-gas calorific value. Nothing about a
    // water reading is converted: with no factor there is nothing to convert
    // towards, and the stored snapshot carries the raw input by design.
    expect(appliesUnitConversion('cubic_metres', 'Water')).toBe(false);
  });

  it('is false when the unit is already the base unit', () => {
    expect(appliesUnitConversion('kWh', 'Electricity')).toBe(false);
    expect(appliesUnitConversion('litres', 'Fuel')).toBe(false);
  });

  it('is true for standard_cubic_metres on Natural Gas — unblocked by LP4-02 PR2', () => {
    // standard_cubic_metres was blocked before LP4-02 PR2 (no sourced NCV);
    // now unblocked: only a sourced row of a release prices or converts it (D5).
    expect(appliesUnitConversion('standard_cubic_metres', 'Natural Gas')).toBe(true);
  });

  it('is false for a unit this build does not know', () => {
    expect(appliesUnitConversion('furlongs', 'Natural Gas')).toBe(false);
  });

  it('never claims a conversion for any factor-less category', () => {
    // The invariant, rather than one example: whatever ends up on the
    // factor-less list, no unit may be described as converting for it.
    for (const category of FACTORLESS_RECORDABLE_CATEGORIES) {
      for (const unit of ACTIVITY_UNITS) {
        expect(appliesUnitConversion(unit.value, category)).toBe(false);
      }
    }
  });
});

describe('COUNTED_STATUSES — what the inventory counts', () => {
  it('is an allow-list: nothing uncommitted, and nothing withdrawn', () => {
    // This list is the reason a new status is safe to add — it counts towards
    // nothing until someone opts it in here. That property is invisible to the
    // compiler (`satisfies` only proves membership of the enum), so it is
    // asserted rather than assumed.
    expect(COUNTED_STATUSES).not.toContain('draft');
    expect(COUNTED_STATUSES).not.toContain('rejected');
    expect(COUNTED_STATUSES).not.toContain('voided');
    expect([...COUNTED_STATUSES]).toEqual([
      'submitted',
      'under_review',
      'approved',
      'locked',
    ]);
  });

  it('contains every status the review queue is made of', () => {
    // A real invariant, not a tautology: a submitted record BOTH counts towards
    // the inventory and sits in the queue. If these two lists ever disagreed,
    // the reviewer's queue and the reported totals would describe different
    // records, and neither screen would show the discrepancy.
    for (const status of PENDING_REVIEW_STATUSES) {
      expect(COUNTED_STATUSES).toContain(status);
    }
  });

  it('is a subset of the statuses that exist', () => {
    for (const status of COUNTED_STATUSES) {
      expect(ACTIVITY_RECORD_STATUSES).toContain(status);
    }
  });

  it('splits into awaiting-review and accepted, with no third kind', () => {
    // WP19's review gate is exactly the complement of "accepted" within this
    // list, and the completeness verdict reads it on both of its branches. A
    // new counted status that is neither pending nor accepted would land
    // silently on the accepted side and turn a cell green without anyone
    // deciding it should — so the partition is asserted here, where the list
    // lives, instead of being inferred at the call sites that consume it.
    const pending = new Set<string>(PENDING_REVIEW_STATUSES);
    const accepted = COUNTED_STATUSES.filter((s) => !pending.has(s));
    expect(accepted).toEqual(['approved', 'locked']);
    expect(accepted.length + PENDING_REVIEW_STATUSES.length).toBe(
      COUNTED_STATUSES.length,
    );
  });
});

describe('the periodValue vocabulary', () => {
  it('covers every granularity, and nothing else', () => {
    expect(Object.keys(PERIOD_VALUES).sort()).toEqual([...REPORTING_PERIODS].sort());
    expect(PERIOD_VALUES.monthly).toHaveLength(12);
    expect(PERIOD_VALUES.quarterly).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    // `annual` is a fixed token, NOT the year. The year has its own column, and
    // a periodValue that sometimes held it would make the uniqueness key mean
    // two different things.
    expect(PERIOD_VALUES.annual).toEqual(['Annual']);
    expect(MONTH_NAMES[0]).toBe('January');
    expect(MONTH_NAMES[11]).toBe('December');
  });

  it('is already canonical — every listed value round-trips to itself', () => {
    // If this ever failed, the list and the canonicaliser would disagree about
    // what "canonical" means, and every write would normalise to a spelling the
    // dropdowns do not offer.
    for (const period of REPORTING_PERIODS) {
      for (const value of PERIOD_VALUES[period]) {
        expect(canonicalPeriodValue(period, value)).toBe(value);
      }
    }
  });

  it('accepts any casing and any surrounding space, and answers with one spelling', () => {
    // This asymmetry IS the fix. Validation was already case-insensitive, which
    // is exactly how `"january"` got in; what was missing was storing the
    // answer rather than the question.
    expect(canonicalPeriodValue('monthly', 'january')).toBe('January');
    expect(canonicalPeriodValue('monthly', 'JANUARY')).toBe('January');
    expect(canonicalPeriodValue('monthly', '  JaNuArY  ')).toBe('January');
    expect(canonicalPeriodValue('quarterly', 'q4')).toBe('Q4');
    expect(canonicalPeriodValue('annual', ' annual ')).toBe('Annual');
  });

  it('refuses a value that names no period, rather than guessing', () => {
    // Canonicalising must never become "accept anything and pick something".
    expect(canonicalPeriodValue('monthly', 'Mar')).toBeNull();
    expect(canonicalPeriodValue('monthly', '2024-03')).toBeNull();
    expect(canonicalPeriodValue('monthly', '')).toBeNull();
    // Right token, wrong granularity — the pair is what identifies a period.
    expect(canonicalPeriodValue('quarterly', 'January')).toBeNull();
    expect(canonicalPeriodValue('monthly', 'Q1')).toBeNull();
    expect(canonicalPeriodValue('annual', 'January')).toBeNull();
    // An unknown granularity must not throw on the index lookup.
    expect(canonicalPeriodValue('weekly', 'January')).toBeNull();
  });

  it('pins the calendar in order, because the order is what attributes quarters', () => {
    // Not decoration. This list drives month -> quarter attribution
    // (`quarterOf`), the monthly trend sort key and label, and the anomaly
    // baseline's period ordering. Swapping June and July puts June in Q3 and
    // July in Q2 — and before this assertion existed that mutant passed all
    // 643 tests, because the only quarter-attribution fixture uses Jan/Feb/Apr.
    // Length-and-endpoints was never enough.
    expect([...MONTH_NAMES]).toEqual([
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ]);
  });

  it('cannot be reshaped by a consumer at runtime', () => {
    // `readonly` is compile-time only, and this list now decides record
    // identity — a consumer that pushed onto it would silently re-mean every
    // stored period.
    expect(Object.isFrozen(PERIOD_VALUES)).toBe(true);
    expect(Object.isFrozen(PERIOD_VALUES.monthly)).toBe(true);
    expect(() => {
      (PERIOD_VALUES.monthly as unknown as string[]).push('Smarch');
    }).toThrow();
    expect(MONTH_NAMES).toHaveLength(12);
  });

  it('answers null, never throws, for a granularity off Object.prototype', () => {
    // `PERIOD_VALUES` inherits `Object.prototype`, so a truthiness guard let
    // these through to `.find` and died with a TypeError — where the predicate
    // this replaced simply returned false. `reporting_period` is a plain text
    // column, so this is reachable from data, not just from a hostile caller.
    for (const key of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      '__proto__',
    ]) {
      expect(canonicalPeriodValue(key, 'January')).toBeNull();
    }
  });
});

describe('entityLabel — one phrase for the reporting entity', () => {
  it('is the phrase the app and every export print, spelled out here', () => {
    // Pinned against the LITERAL, not against itself: asserting
    // `entityLabel(x) === WHOLE_COMPANY_ENTITY_LABEL` passes just as happily
    // with the constant redefined to 'Whole parent company' — which means
    // something else entirely (the holding, in the report scope filter).
    expect(WHOLE_COMPANY_ENTITY_LABEL).toBe('Whole subsidiary');
    expect(UNNAMED_SITE_ENTITY_LABEL).toBe('Facility (name unavailable)');
  });

  it('prints the site name when the record is attributed to one', () => {
    expect(entityLabel({ locationId: 'loc-1', locationName: 'Istanbul HQ' })).toBe('Istanbul HQ');
  });

  it('falls back to the whole company for a subsidiary-level record', () => {
    expect(entityLabel({ locationId: null, locationName: null })).toBe('Whole subsidiary');
    expect(entityLabel({})).toBe('Whole subsidiary');
  });

  it('says a site is involved even when its NAME did not come back', () => {
    // The case a name-only helper gets wrong: `locationName` is optional on the
    // contract because it rides on an `include` some queries do not ask for, so
    // keying on the name alone calls a SITE row "the whole company" the first
    // time a caller passes a record loaded without the join. That is a
    // misstatement of the reporting entity in an artifact an auditor keeps.
    expect(entityLabel({ locationId: 'loc-1' })).toBe('Facility (name unavailable)');
    expect(entityLabel({ locationId: 'loc-1', locationName: '   ' })).toBe(
      'Facility (name unavailable)',
    );
  });

  it('treats a blank name as no name — a ledger cell must never be empty', () => {
    // '   ' is truthy. Without the trim this prints an empty cell in an
    // audit-ready export, which reads as a missing value, not as a level.
    expect(entityLabel({ locationName: '   ' })).toBe('Whole subsidiary');
    expect(entityLabel({ locationId: 'l', locationName: '  Izmir Plant  ' })).toBe('Izmir Plant');
  });

  it("takes a screen's own two phrases, by the same rule", () => {
    const words = { wholeCompany: 'W', unnamedSite: 'U' };
    expect(entityLabel({}, words)).toBe('W');
    expect(entityLabel({ locationId: 'loc-1' }, words)).toBe('U');
    expect(entityLabel({ locationId: 'loc-1', locationName: ' Izmir ' }, words)).toBe('Izmir');
    expect(ENGLISH_ENTITY_WORDS).toEqual({ wholeCompany: 'Whole subsidiary', unnamedSite: 'Facility (name unavailable)' });
  });
});

describe('the anomaly rule (VAR §4)', () => {
  // These two numbers were module-private inside `activity-records.service.ts`
  // until WP21 moved them here so a screen could state the same rule. Promoting
  // a constant into the contract package means any package can now import it,
  // so a one-character edit reaches everything — and nothing in this package
  // said what the numbers were. The suite constrained the threshold only to the
  // open interval (0.32, 0.98), incidentally, through API fixtures.
  it('is 50% deviation from a 3-period rolling average', () => {
    expect(ANOMALY_THRESHOLD).toBe(0.5);
    expect(ANOMALY_BASELINE_PERIODS).toBe(3);
  });

  it('runs on as little as one earlier period (BUG-R2-07, 2026-11-11)', () => {
    // Pinned for the same reason as the two above: raising this to 2 or 3
    // silently takes every first-year series back out of the gate.
    expect(ANOMALY_MIN_PRIORS).toBe(1);
  });

  describe('isAnomalyEvaluated', () => {
    const evaluated = { anomalyBaselinePriorCount: 3, anomalyBaselineTCo2e: 41.2 };

    it('is true on a full window with a usable divisor', () => {
      expect(isAnomalyEvaluated(evaluated)).toBe(true);
    });

    it.each([1, 2])('is true on a limited window of %i priors with an average', (priors) => {
      expect(
        isAnomalyEvaluated({ anomalyBaselinePriorCount: priors, anomalyBaselineTCo2e: 41.2 }),
      ).toBe(true);
    });

    it('is false when the pool was never queried', () => {
      expect(
        isAnomalyEvaluated({ anomalyBaselinePriorCount: null, anomalyBaselineTCo2e: null }),
      ).toBe(false);
    });

    it('is false with no earlier period', () => {
      expect(
        isAnomalyEvaluated({ anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null }),
      ).toBe(false);
    });

    it.each([1, 2])(
      'is false on a verdict of %i priors written before the short-history check',
      (priors) => {
        // Count without an average: the old rule's "not evaluated". It stays
        // not evaluated — the record is not re-scored because the rule changed.
        expect(
          isAnomalyEvaluated({ anomalyBaselinePriorCount: priors, anomalyBaselineTCo2e: null }),
        ).toBe(false);
      },
    );

    it.each([1, 2])('is false when a limited window of %i averages to zero', (priors) => {
      expect(
        isAnomalyEvaluated({ anomalyBaselinePriorCount: priors, anomalyBaselineTCo2e: 0 }),
      ).toBe(false);
    });

    it('is false when a full window averages to zero', () => {
      // The subtlest of the four: three priors, an average, and still no ratio.
      // A hand-written `priorCount === 3` check at a call site would call this
      // evaluated and render 500 tCO₂e against three zero priors as clean.
      expect(
        isAnomalyEvaluated({ anomalyBaselinePriorCount: 3, anomalyBaselineTCo2e: 0 }),
      ).toBe(false);
    });

    it('is false when a full window somehow carries no average', () => {
      expect(
        isAnomalyEvaluated({ anomalyBaselinePriorCount: 3, anomalyBaselineTCo2e: null }),
      ).toBe(false);
    });

    it('does not treat a count above the window as evaluated', () => {
      // Bounded above: a count above the window means the rule that
      // produced it disagrees with the one reading it, and "evaluated" would be
      // the wrong thing to conclude from a contradiction.
      expect(
        isAnomalyEvaluated({ anomalyBaselinePriorCount: 4, anomalyBaselineTCo2e: 41.2 }),
      ).toBe(false);
    });
  });

  // Design D4's table, row by row: what the three stored columns mean.
  describe('anomalyBasis and isLegacyShortWindowVerdict', () => {
    it.each([
      // [count, average, basis, legacy]
      [null, null, null, false], // no figure of its own
      [0, null, null, false], // no earlier period
      [1, null, null, true], // scored before the short-history check
      [2, null, null, true],
      [1, 0, null, false], // zero average
      [2, 0, null, false],
      [1, 10, 'limited', false],
      [2, 10, 'limited', false],
      [3, 0, null, false],
      [3, null, null, false], // a full window with no average is not legacy
      [3, 10, 'full', false],
      [4, 10, null, false], // a count the rule cannot produce
    ] as const)('count %s, average %s → basis %s, legacy %s', (count, average, basis, legacy) => {
      const record = { anomalyBaselinePriorCount: count, anomalyBaselineTCo2e: average };
      expect(anomalyBasis(record)).toBe(basis);
      expect(isLegacyShortWindowVerdict(record)).toBe(legacy);
    });
  });
});

describe('computeAnomalyVerdict', () => {
  // The fold moved here in WP21 PR 3 so `pnpm anomaly:recompute` and the API
  // could not produce different verdicts for one record. These cases are the
  // rule itself; the service's own spec covers SELECTING the pool.
  it('flags a value more than the threshold away from a full window', () => {
    expect(computeAnomalyVerdict(19.8, [10, 10, 10])).toEqual({
      anomalous: true,
      priorCount: 3,
      baseline: 10,
    });
  });

  it('does not flag a deviation of exactly the threshold (§4.2 says MORE than)', () => {
    // Binary-exact on purpose: 15, 10 and the 5 between them are representable,
    // so this is the boundary and not a value near it.
    expect(computeAnomalyVerdict(15, [10, 10, 10]).anomalous).toBe(false);
  });

  it('does not run with no earlier period — the count is reported, the baseline is not', () => {
    expect(computeAnomalyVerdict(19.8, [])).toEqual({
      anomalous: false,
      priorCount: 0,
      baseline: null,
    });
  });

  // BUG-R2-07: one or two earlier periods are a limited-history verdict, under
  // the same threshold. Binary-exact values, so each is the boundary itself.
  it.each([
    [16, true],
    [15, false], // exactly 50% above: §4.2 says MORE than
    [5, false], // exactly 50% below
    [4, true],
  ])('judges %d against ONE prior of 10 → anomalous %s', (current, anomalous) => {
    expect(computeAnomalyVerdict(current, [10])).toEqual({
      anomalous,
      priorCount: 1,
      baseline: 10,
    });
  });

  it('averages TWO priors', () => {
    expect(computeAnomalyVerdict(14, [8, 12])).toEqual({
      anomalous: false,
      priorCount: 2,
      baseline: 10,
    });
    expect(computeAnomalyVerdict(19.8, [8, 12]).anomalous).toBe(true);
  });

  it('lets a figureless prior consume a slot rather than reaching past it', () => {
    // Four comparable periods exist, one of them without a figure. The window
    // is still three, so two figures remain and the verdict is on limited
    // history — it does NOT reach back to the fourth to refill the window. The
    // fourth is 40 here so that reaching it would move the average to 20.
    expect(computeAnomalyVerdict(19.8, [10, null, 10, 40])).toEqual({
      anomalous: true,
      priorCount: 2,
      baseline: 10,
    });
  });

  it('does not run on a window of figureless priors only', () => {
    expect(computeAnomalyVerdict(19.8, [null, null, null, 10])).toEqual({
      anomalous: false,
      priorCount: 0,
      baseline: null,
    });
  });

  it('reports a full window that averages zero instead of hiding it', () => {
    expect(computeAnomalyVerdict(500, [0, 0, 0])).toEqual({
      anomalous: false,
      priorCount: 3,
      baseline: 0,
    });
  });

  it('reports a single zero prior the same way: no ratio, no flag', () => {
    const v = computeAnomalyVerdict(500, [0]);
    expect(v).toEqual({ anomalous: false, priorCount: 1, baseline: 0 });
    expect(
      isAnomalyEvaluated({ anomalyBaselinePriorCount: v.priorCount, anomalyBaselineTCo2e: v.baseline }),
    ).toBe(false);
  });

  it('ignores priors beyond the window', () => {
    // A fourth, much larger prior must not move the average.
    expect(computeAnomalyVerdict(19.8, [10, 10, 10, 1000]).baseline).toBe(10);
  });

  it('flags a value far BELOW its baseline, not only above', () => {
    // VAR §4.2 is an absolute deviation; a collapse in consumption is as much
    // an anomaly as a spike, and a one-sided comparison would miss a meter
    // that stopped reporting.
    expect(computeAnomalyVerdict(1, [10, 10, 10]).anomalous).toBe(true);
  });
});

describe('anomalyNotEvaluated', () => {
  it('defaults to a null count — the pool was never queried', () => {
    expect(anomalyNotEvaluated()).toEqual({
      anomalous: false,
      priorCount: null,
      baseline: null,
    });
  });

  it('carries how close it came when a pool WAS queried', () => {
    expect(anomalyNotEvaluated(2).priorCount).toBe(2);
  });
});

describe('bulk upload — the column contract', () => {
  /**
   * Pinned element by element, for the same reason `MONTH_NAMES` is: this list
   * IS the template's column order, PR 3 generates the downloadable template
   * from it, and swapping two entries survived the entire 819-test API suite.
   * A user filling in a template whose `activityValue` and `activityUnit` had
   * quietly traded places would have every row refused — or worse, not.
   */
  it('is exactly these columns, in this order', () => {
    expect([...BULK_UPLOAD_COLUMNS]).toEqual([
      'subsidiaryId',
      'locationId',
      'reportingYear',
      'reportingPeriod',
      'periodValue',
      'category',
      'activityType',
      'activityValue',
      'activityUnit',
      'varianceReason',
      'ncvKcalPerSm3',
      'billedGcvKcalPerSm3',
      'volumeCorrectionFactor',
      'equipmentType',
      'capacityKg',
      'refillKg',
      'leakRateChoice',
    ]);
  });

  it('requires everything except the columns that mean something when blank', () => {
    // A blank `locationId` is the whole company — a real reporting entity, not
    // a missing value — most records carry no variance reason at all, and an
    // untyped category (Electricity, Natural Gas, Water) names no activity
    // type: the header may omit it, so an older template still imports.
    const optional = BULK_UPLOAD_COLUMNS.filter(
      (c) => !(BULK_UPLOAD_REQUIRED_COLUMNS as readonly string[]).includes(c),
    );
    // The calculation inputs (LP4-02 PR4) are blank on every row whose
    // category takes none, and absent from an older template.
    expect(optional).toEqual([
      'locationId', 'activityType', 'varianceReason',
      ...BULK_GAS_PARAMETER_COLUMNS, ...BULK_EQUIPMENT_COLUMNS,
    ]);
  });

  it('keeps errors and warnings disjoint', () => {
    // They live in one report under two keys, and a single union let
    // `errors[]` legally carry `formula_lead` — a row that imported fine.
    const overlap = BULK_UPLOAD_ERROR_CODES.filter((c) =>
      (BULK_UPLOAD_WARNING_CODES as readonly string[]).includes(c),
    );
    expect(overlap).toEqual([]);
  });

  it('refuses a comma and an over-bound value with their own codes (LP4-04)', () => {
    // A row and a single record over the bound say the same thing, so they
    // share one name; a comma has no record-API twin (the web refuses it first).
    expect(BULK_UPLOAD_ERROR_CODES).toContain('wrong_decimal_separator');
    expect(BULK_UPLOAD_ERROR_CODES).toContain('activity_value_too_large');
    expect(API_ERROR_STATUS.activity_value_too_large).toBe(400);
    expect(API_ERROR_PARAMS.activity_value_too_large).toBeUndefined();
  });
});

describe('approval_evidence_missing (K3)', () => {
  it('is a 400 naming the category, as evidence_required is', () => {
    expect(API_ERROR_STATUS.approval_evidence_missing).toBe(400);
    expect(API_ERROR_PARAMS.approval_evidence_missing).toEqual(['category']);
  });

  it('is not a bulk-submit outcome — bulk submit never approves', () => {
    expect(BULK_SUBMIT_ISSUE_CODES as readonly string[]).not.toContain('approval_evidence_missing');
  });
});

describe('bulk submit — the code list', () => {
  it('covers submit preconditions and the reserved LP4-05 deadline outcome', () => {
    // One code per refusal gate. PR A publishes the deadline gate before PR B
    // enables it; this vocabulary must not collapse distinct refusal reasons.
    expect([...BULK_SUBMIT_ISSUE_CODES]).toEqual([
      'not_found',
      'not_submittable',
      'not_author',
      'period_locked',
      'evidence_required',
      'calculation_stale',
      'variance_reason_required',
      'unexpected',
      'not_processed_deadline',
    ]);
  });

  it('has no warning half, unlike the import’s', () => {
    // The import needed one because a row could be written and still be
    // unusable. A submit either moves the record or does not.
    expect(BULK_SUBMIT_ISSUE_CODES).not.toContain('formula_lead');
    expect(BULK_SUBMIT_ISSUE_CODES).not.toContain('would_block_submit');
  });

  it('caps ids separately from the import’s rows, at the same number', () => {
    // Two budgets that coincide — a file's rows and a JSON array's length —
    // and deliberately not aliases, so raising either for its own reason
    // cannot silently raise the other.
    expect(BULK_SUBMIT_MAX_IDS).toBe(1000);
    expect(BULK_UPLOAD_MAX_ROWS).toBe(1000);
  });

  it('lets one evidence file back as many records as the selection it is picked from', () => {
    // The multi-record upload is made from the bulk-submit selection list; a
    // lower cap would refuse a selection the list itself allowed.
    expect(EVIDENCE_MAX_LINKED_RECORDS).toBe(BULK_SUBMIT_MAX_IDS);
  });
});


describe('the two submittable gates', () => {
  it('pins what a BULK submit accepts, at the source', () => {
    // The product's narrowest lifecycle gate, and until now it was asserted
    // only downstream — by an API service spec and a web view spec. Widening
    // it should go red HERE, in the contract's own suite, because widening it
    // turns the route into a mass reviewer-decision-reversal endpoint.
    expect(BULK_SUBMITTABLE_STATUSES).toEqual(['draft']);
    expect(SUBMITTABLE_STATUSES).toEqual(['draft', 'rejected']);
  });

  it('keeps the narrow gate narrower than the wide one', () => {
    // `rejected` is the whole difference, and the whole point.
    expect(isSubmittable('rejected')).toBe(true);
    expect(acceptsBulkSubmit('rejected')).toBe(false);
    expect(acceptsBulkSubmit('draft')).toBe(true);
    for (const status of ['submitted', 'under_review', 'approved', 'locked', 'voided']) {
      expect(acceptsBulkSubmit(status)).toBe(false);
      expect(isSubmittable(status)).toBe(false);
    }
  });

  it('fails closed on anything that is not a status', () => {
    for (const junk of ['', 'Draft', ' draft', 'DRAFT']) {
      expect(acceptsBulkSubmit(junk)).toBe(false);
      expect(isSubmittable(junk)).toBe(false);
    }
  });
});

describe('needsEvidenceBeforeSubmit', () => {
  it('is category AND file count — the copy that was wrong for two work packages', () => {
    expect(needsEvidenceBeforeSubmit({ category: 'Electricity', evidenceCount: 0 })).toBe(true);
    // The case the category-only copy refused forever.
    expect(needsEvidenceBeforeSubmit({ category: 'Electricity', evidenceCount: 1 })).toBe(false);
    expect(needsEvidenceBeforeSubmit({ category: 'Business Travel', evidenceCount: 0 })).toBe(false);
  });

  it.each(['Mobile Combustion', 'Refrigerants', 'Fugitive Gas'])(
    'holds back %s with no file and lets it through with one (K3)',
    (category) => {
      expect(needsEvidenceBeforeSubmit({ category, evidenceCount: 0 })).toBe(true);
      expect(needsEvidenceBeforeSubmit({ category, evidenceCount: 1 })).toBe(false);
    },
  );

  it('covers every evidence-required category and nothing else', () => {
    for (const category of EVIDENCE_REQUIRED_CATEGORIES) {
      expect(needsEvidenceBeforeSubmit({ category, evidenceCount: 0 })).toBe(true);
    }
    for (const category of CATEGORIES.filter((c) => !EVIDENCE_REQUIRED_CATEGORIES.includes(c))) {
      expect(needsEvidenceBeforeSubmit({ category, evidenceCount: 0 })).toBe(false);
    }
  });
});

describe('mayAuthorRecords — the one record-write rule', () => {
  it.each([
    ['data_entry', true],
    ['super_admin', true],
    ['consultant', false],
    ['executive_viewer', false],
    ['DATA_ENTRY', false],
    ['', false],
  ])('%s → %s', (role, allowed) => {
    expect(mayAuthorRecords({ role })).toBe(allowed);
  });

  it('refuses a signed-out shell', () => {
    expect(mayAuthorRecords(null)).toBe(false);
    expect(mayAuthorRecords(undefined)).toBe(false);
  });
});

describe('record edit, recall and copy (BUG-R2-03)', () => {
  const author = { id: 'u-author', role: 'data_entry' };
  const admin = { id: 'u-admin', role: 'super_admin' };
  const consultant = { id: 'u-consultant', role: 'consultant' };
  const ALL = ['draft', 'submitted', 'under_review', 'approved', 'rejected', 'locked', 'voided'];

  it('pins the edit and recall sets at the source', () => {
    expect(EDITABLE_RECORD_STATUSES).toEqual(['draft', 'rejected']);
    expect(RECALLABLE_STATUSES).toEqual(['submitted']);
    expect(isRecallable('submitted')).toBe(true);
    for (const status of ALL.filter((s) => s !== 'submitted')) expect(isRecallable(status)).toBe(false);
    for (const junk of ['', 'Submitted', ' submitted']) expect(isRecallable(junk)).toBe(false);
  });

  it('lets only the author edit, in an editable status — super_admin is not exempt', () => {
    for (const status of ALL) {
      const editable = status === 'draft' || status === 'rejected';
      expect(mayEditRecord(author, { status, createdBy: author.id })).toBe(editable);
      expect(mayEditRecord(admin, { status, createdBy: author.id })).toBe(false);
    }
    expect(mayEditRecord(admin, { status: 'draft', createdBy: admin.id })).toBe(true);
    expect(mayEditRecord(consultant, { status: 'draft', createdBy: consultant.id })).toBe(false);
    expect(mayEditRecord(null, { status: 'draft', createdBy: author.id })).toBe(false);
    expect(mayEditRecord(author, { status: 'draft', createdBy: null })).toBe(false);
  });

  it('lets only the author recall, and only while submitted', () => {
    for (const status of ALL) {
      expect(mayRecallRecord(author, { status, createdBy: author.id })).toBe(status === 'submitted');
      expect(mayRecallRecord(admin, { status, createdBy: author.id })).toBe(false);
    }
    expect(mayRecallRecord(consultant, { status: 'submitted', createdBy: consultant.id })).toBe(false);
  });

  it('offers copy on a voided record to its author and to super_admin only', () => {
    expect(mayCopyVoidedRecord(author, { status: 'voided', createdBy: author.id })).toBe(true);
    expect(mayCopyVoidedRecord(admin, { status: 'voided', createdBy: author.id })).toBe(true);
    expect(mayCopyVoidedRecord({ id: 'u-other', role: 'data_entry' }, { status: 'voided', createdBy: author.id })).toBe(false);
    expect(mayCopyVoidedRecord(consultant, { status: 'voided', createdBy: consultant.id })).toBe(false);
    for (const status of ALL.filter((s) => s !== 'voided')) {
      expect(mayCopyVoidedRecord(author, { status, createdBy: author.id })).toBe(false);
    }
  });

  it('records a recall as its own audit verb', () => {
    expect(AUDIT_ACTIONS).toContain('recall');
    expect(AUDIT_ACTIONS).not.toContain('withdraw');
  });

  it('registers the two new refusals with their params', () => {
    expect(API_ERROR_STATUS.record_not_recallable).toBe(400);
    expect(API_ERROR_PARAMS.record_not_recallable).toEqual(['status']);
    expect(API_ERROR_STATUS.evidence_detach_required).toBe(400);
    expect(API_ERROR_PARAMS.evidence_detach_required).toEqual(['linked']);
  });
});

describe('normalizeRecordParameters (LP4-02, D11)', () => {
  it('reads {}, an all-null object, a scalar and an array as no parameters', () => {
    for (const value of [null, undefined, {}, { ncvKcalPerSm3: null }, 'x', 1, []]) {
      expect(normalizeRecordParameters(value)).toBeNull();
    }
  });

  it('drops a null field and keeps the rest', () => {
    expect(normalizeRecordParameters({ ncvKcalPerSm3: 8100, billedGcvKcalPerSm3: null })).toEqual({ ncvKcalPerSm3: 8100 });
  });

  it('keeps equipment lines as they are', () => {
    const equipment = [{ equipmentType: 'chiller', capacityKg: 0, refillKg: 1, leakRateChoice: 'default' }];
    expect(normalizeRecordParameters({ equipment })).toEqual({ equipment });
  });
});

describe('isProvenanceSnapshot (LP4-02, D11)', () => {
  const figure = { factorId: 'f-1', tCo2e: 1 };
  it('reads schemas 2 and 3 as provenance, and an untagged figure as not', () => {
    expect(isProvenanceSnapshot({ ...figure, snapshotSchema: 2 } as never)).toBe(true);
    expect(isProvenanceSnapshot({ ...figure, snapshotSchema: 3 } as never)).toBe(true);
    expect(isProvenanceSnapshot(figure as never)).toBe(false);
  });
});
