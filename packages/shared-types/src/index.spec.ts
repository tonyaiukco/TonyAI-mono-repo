import { describe, it, expect } from 'vitest';
import {
  ANOMALY_BASELINE_PERIODS,
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

  it('is false for a blocked unit — it is refused before any arithmetic', () => {
    expect(appliesUnitConversion('standard_cubic_metres', 'Natural Gas')).toBe(false);
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
    // with the constant redefined to 'Whole organisation' — which means
    // something else entirely (the holding, in the report scope filter).
    expect(WHOLE_COMPANY_ENTITY_LABEL).toBe('Whole company');
    expect(UNNAMED_SITE_ENTITY_LABEL).toBe('Site (name unavailable)');
  });

  it('prints the site name when the record is attributed to one', () => {
    expect(entityLabel({ locationId: 'loc-1', locationName: 'Istanbul HQ' })).toBe('Istanbul HQ');
  });

  it('falls back to the whole company for a subsidiary-level record', () => {
    expect(entityLabel({ locationId: null, locationName: null })).toBe('Whole company');
    expect(entityLabel({})).toBe('Whole company');
  });

  it('says a site is involved even when its NAME did not come back', () => {
    // The case a name-only helper gets wrong: `locationName` is optional on the
    // contract because it rides on an `include` some queries do not ask for, so
    // keying on the name alone calls a SITE row "the whole company" the first
    // time a caller passes a record loaded without the join. That is a
    // misstatement of the reporting entity in an artifact an auditor keeps.
    expect(entityLabel({ locationId: 'loc-1' })).toBe('Site (name unavailable)');
    expect(entityLabel({ locationId: 'loc-1', locationName: '   ' })).toBe(
      'Site (name unavailable)',
    );
  });

  it('treats a blank name as no name — a ledger cell must never be empty', () => {
    // '   ' is truthy. Without the trim this prints an empty cell in an
    // audit-ready export, which reads as a missing value, not as a level.
    expect(entityLabel({ locationName: '   ' })).toBe('Whole company');
    expect(entityLabel({ locationId: 'l', locationName: '  Izmir Plant  ' })).toBe('Izmir Plant');
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

  describe('isAnomalyEvaluated', () => {
    const evaluated = { anomalyBaselinePriorCount: 3, anomalyBaselineTCo2e: 41.2 };

    it('is true only on a full window with a usable divisor', () => {
      expect(isAnomalyEvaluated(evaluated)).toBe(true);
    });

    it('is false when the pool was never queried', () => {
      expect(
        isAnomalyEvaluated({ anomalyBaselinePriorCount: null, anomalyBaselineTCo2e: null }),
      ).toBe(false);
    });

    it.each([0, 1, 2])('is false on a window of %i priors', (priors) => {
      expect(
        isAnomalyEvaluated({ anomalyBaselinePriorCount: priors, anomalyBaselineTCo2e: null }),
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
      // Equality, not `>=`: a count above the window means the rule that
      // produced it disagrees with the one reading it, and "evaluated" would be
      // the wrong thing to conclude from a contradiction.
      expect(
        isAnomalyEvaluated({ anomalyBaselinePriorCount: 4, anomalyBaselineTCo2e: 41.2 }),
      ).toBe(false);
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

  it.each([[[10, 10]], [[10]], [[]]])(
    'does not run on a window of %j — the count is reported, the baseline is not',
    (priors) => {
      const v = computeAnomalyVerdict(19.8, priors as number[]);
      expect(v.anomalous).toBe(false);
      expect(v.priorCount).toBe((priors as number[]).length);
      expect(v.baseline).toBeNull();
    },
  );

  it('lets a figureless prior consume a slot rather than reaching past it', () => {
    // Four comparable periods exist, one of them without a figure. The window
    // is still three, so two figures remain and the rule does not run — it does
    // NOT reach back to the fourth to refill the window.
    const v = computeAnomalyVerdict(19.8, [null, 10, 10, 10]);
    expect(v.priorCount).toBe(2);
    expect(v.anomalous).toBe(false);
  });

  it('reports a full window that averages zero instead of hiding it', () => {
    expect(computeAnomalyVerdict(500, [0, 0, 0])).toEqual({
      anomalous: false,
      priorCount: 3,
      baseline: 0,
    });
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
