import { describe, it, expect } from 'vitest';
import type { CalculationResultV2, UncalculatedSnapshot } from '@tonyai/shared-types';
import { compareSnapshots } from './snapshot-staleness';

/**
 * K11's comparison (Decisions 2026-10-11 (second), P6): the stored snapshot
 * against the one the engine computes now from the record's stored inputs.
 * The values are labelled fixtures — not factors from any publication.
 */
const RECOMPUTED: CalculationResultV2 = {
  snapshotSchema: 2,
  category: 'Natural Gas',
  geographyCode: 'GB',
  reportingYear: 2031,
  scope: 1,
  inputValue: 250,
  inputUnit: 'cubic_metres',
  normalizedValue: 2840,
  normalizedUnit: 'kWh',
  conversionApplied: true,
  conversionFactor: 11.36,
  conversionBasis: 'fixture conversion (not a real publication)',
  kgCo2e: 520,
  tCo2e: 0.52,
  factorId: 'factor-fixture',
  factorValue: 0.1831,
  factorUnit: 'kgCO2e/kWh',
  methodology: 'fixture',
  source: 'fixture publisher',
  version: '2031-fixture',
  activityType: 'natural_gas',
  gas: 'CO2e',
  gasCoverage: 'co2e_total',
  calorificBasis: 'gross',
  scope2Method: null,
  dataYear: 2031,
  yearPolicy: 'same_year',
  factorRelease: {
    id: 'release-fixture',
    publisher: 'fixture',
    title: 'Fixture release',
    edition: '2031-fixture',
    ordinal: 1,
    status: 'active',
    sourceUrl: null,
    licence: null,
    publishedAt: null,
    gwpSet: null,
  },
  conversion: {
    id: 'conversion-fixture',
    fromUnit: 'm3',
    toUnit: 'kWh',
    multiplier: 11.36,
    calorificBasis: 'gross',
    referenceConditions: null,
    basis: 'fixture conversion (not a real publication)',
    dataYear: 2031,
    release: {
      id: 'release-fixture',
      publisher: 'fixture',
      title: 'Fixture release',
      edition: '2031-fixture',
      ordinal: 1,
      status: 'active',
      sourceUrl: null,
      licence: null,
      publishedAt: null,
      gwpSet: null,
    },
  },
} as unknown as CalculationResultV2;

/** The snapshot as `calculation` (jsonb) hands it back: a parsed copy, keys reordered. */
function stored(snapshot: object): unknown {
  const copy = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(copy).reverse());
}

const UNCALCULATED: UncalculatedSnapshot = {
  snapshotSchema: 1,
  category: 'Water',
  geographyCode: 'GB',
  reportingYear: 2031,
  scope: 3,
  inputValue: 100,
  inputUnit: 'cubic_metres',
  reasonCode: 'no_emission_factor',
  reason: 'No emission factor is available for "Water" (GB, 2031), …',
};

describe('compareSnapshots — K11 (P6)', () => {
  it('a stored copy of the recomputed snapshot is fresh, whatever its key order', () => {
    expect(compareSnapshots(stored(RECOMPUTED), RECOMPUTED)).toEqual({
      stale: false,
      classes: [],
      legacy: false,
    });
  });

  it('the unit as entered and as stored is one unit (inputUnit compared canonically)', () => {
    const entered = { ...RECOMPUTED, inputUnit: 'm3' };
    expect(compareSnapshots(stored(entered), RECOMPUTED).stale).toBe(false);
    const kwh = { ...RECOMPUTED, inputUnit: 'kWh' };
    expect(compareSnapshots(stored({ ...kwh, inputUnit: 'kwh' }), kwh).stale).toBe(false);
  });

  it('a different unit is an input mismatch, not a spelling', () => {
    const r = compareSnapshots(stored({ ...RECOMPUTED, inputUnit: 'kWh' }), RECOMPUTED);
    expect(r).toEqual({ stale: true, classes: ['input'], legacy: false });
  });

  it.each([
    ['figure', { tCo2e: 0.0001 }],
    ['figure', { kgCo2e: 0.1 }],
    ['factor', { factorValue: 0.2 }],
    ['factor', { factorId: 'factor-other' }],
    ['factor', { yearPolicy: 'fallback_prior_year' }],
    ['conversion', { normalizedValue: 2500 }],
    ['conversion', { conversionFactor: 10 }],
    ['conversion', { conversionApplied: false }],
    ['input', { inputValue: 251 }],
    ['input', { geographyCode: 'TR' }],
    ['input', { reportingYear: 2030 }],
    ['input', { category: 'Fuel' }],
    ['input', { activityType: 'diesel' }],
  ] as const)('classifies a changed field as %s (%o)', (cls, change) => {
    const r = compareSnapshots(stored({ ...RECOMPUTED, ...change }), RECOMPUTED);
    expect(r).toEqual({ stale: true, classes: [cls], legacy: false });
  });

  // `security-rls` re-review P2-A: `Infinity - x` is Infinity, and
  // `Infinity <= Infinity` — a recompute that overflowed (an absurd activity
  // value a direct writer stored) compared equal to any stored figure.
  it('a finite number and an infinite one are never the same; the two infinities are not either', () => {
    const overflowed = { ...RECOMPUTED, normalizedValue: Infinity, kgCo2e: Infinity, tCo2e: Infinity };
    expect(compareSnapshots(stored(RECOMPUTED), overflowed as CalculationResultV2).classes).toEqual(['conversion', 'figure']);
    expect(compareSnapshots({ ...(stored(RECOMPUTED) as object), tCo2e: Infinity }, RECOMPUTED).classes).toEqual(['figure']);
    expect(compareSnapshots({ ...(stored(RECOMPUTED) as object), tCo2e: -Infinity }, { ...RECOMPUTED, tCo2e: Infinity }).stale).toBe(true);
  });

  // Codex's B9 review of B2, P3 (1): `a === b` ran before the finiteness
  // check, so Infinity matched Infinity. No figure the engine computes is
  // infinite (it refuses an overflow), so this is the rule made true, not a
  // reachable exploit: a non-finite number is the same as nothing, itself
  // included — at the top level, nested, and under an exact key.
  it.each([
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN', NaN],
  ])('%s is never the same number, even as itself — top level, nested, exact key', (_label, value) => {
    const top = { ...RECOMPUTED, tCo2e: value };
    expect(compareSnapshots({ ...(stored(RECOMPUTED) as object), tCo2e: value }, top)).toEqual({
      stale: true,
      classes: ['figure'],
      legacy: false,
    });
    // Two copies, as a stored snapshot and a recomputed one always are…
    const nested = () => ({ ...RECOMPUTED, conversion: { ...RECOMPUTED.conversion!, multiplier: value } });
    expect(compareSnapshots(nested(), nested() as CalculationResultV2).classes).toEqual(['conversion']);
    const exact = () => ({ ...RECOMPUTED, factorRelease: { ...RECOMPUTED.factorRelease, ordinal: value } });
    expect(compareSnapshots(exact(), exact() as CalculationResultV2).classes).toEqual(['factor']);
    const schema = () => ({ ...RECOMPUTED, snapshotSchema: value });
    expect(compareSnapshots(schema(), schema() as unknown as CalculationResultV2).classes).toEqual(['factor']);
    // …and one object handed as both: no reference shortcut skips the rule.
    const same = nested();
    expect(compareSnapshots(same, same as CalculationResultV2).classes).toEqual(['conversion']);
  });

  // Codex's B9 review of B2, P3 (2): below about 2e-311, 10^-12 of a number
  // is less than the gap between two adjacent doubles (Number.MIN_VALUE,
  // 5e-324), so the relative tolerance underflowed to zero and an honest
  // one-step rounding difference was refused. Modelled as Codex did: the
  // database's rounding to 16 significant digits, then the recompute from the
  // rounded input, priced at the placeholder Electricity factor 0.2071.
  it('an honest rounding difference of a subnormal figure is the same number', () => {
    const toDb = (x: number) => Number(x.toPrecision(16));
    const entered = 1.0020650006883337e-308;
    const saved = { ...RECOMPUTED, inputValue: toDb(entered), normalizedValue: toDb(entered), kgCo2e: toDb(entered * 0.2071), tCo2e: toDb((entered * 0.2071) / 1000) };
    const input = saved.inputValue;
    const recomputed = { ...RECOMPUTED, inputValue: input, normalizedValue: input, kgCo2e: input * 0.2071, tCo2e: (input * 0.2071) / 1000 };
    expect(saved.tCo2e).not.toBe(recomputed.tCo2e);
    expect(compareSnapshots(stored(saved), recomputed)).toEqual({ stale: false, classes: [], legacy: false });
    expect(compareSnapshots(stored({ ...RECOMPUTED, tCo2e: 2.075276616423e-312 }), { ...RECOMPUTED, tCo2e: 2.07527661643e-312 }).stale).toBe(false);
  });

  it('the subnormal allowance is four steps between two non-zero numbers of one sign — never across zero', () => {
    const step = Number.MIN_VALUE;
    const at = (stored_: number, recomputed: number) =>
      compareSnapshots(stored({ ...RECOMPUTED, tCo2e: stored_ }), { ...RECOMPUTED, tCo2e: recomputed }).stale;
    expect(at(2e-312, 2e-312 + 4 * step)).toBe(false);
    expect(at(2e-312, 2e-312 + 5 * step)).toBe(true);
    expect(at(2e-312, 4e-312)).toBe(true);
    expect(at(0, step)).toBe(true);
    expect(at(step, 0)).toBe(true);
    expect(at(step, -step)).toBe(true);
    expect(at(3 * step, -step)).toBe(true);
    // An identity stays exact at any magnitude.
    expect(compareSnapshots(stored({ ...RECOMPUTED, dataYear: step }), { ...RECOMPUTED, dataYear: 2 * step } as CalculationResultV2).stale).toBe(true);
  });

  // `security-rls` re-review P3-A: an identity is not a measurement — a
  // schema version, a scope, a year or a release ordinal is equal or not.
  it.each([
    ['snapshotSchema', (s: Record<string, any>) => ({ ...s, snapshotSchema: 2.000000000001 }), ['factor']],
    ['scope', (s: Record<string, any>) => ({ ...s, scope: 1.0000000000001 }), ['factor']],
    ['reportingYear', (s: Record<string, any>) => ({ ...s, reportingYear: 2031.000000001 }), ['input']],
    ['dataYear', (s: Record<string, any>) => ({ ...s, dataYear: 2031.000000001 }), ['factor']],
    ['factorRelease.ordinal', (s: Record<string, any>) => ({ ...s, factorRelease: { ...s.factorRelease, ordinal: 1.0000000000001 } }), ['factor']],
    ['conversion.dataYear', (s: Record<string, any>) => ({ ...s, conversion: { ...s.conversion, dataYear: 2031.000000001 } }), ['conversion']],
    ['conversion.release.ordinal', (s: Record<string, any>) => ({ ...s, conversion: { ...s.conversion, release: { ...s.conversion.release, ordinal: 1.0000000000001 } } }), ['conversion']],
  ] as const)('%s compares exactly, without the tolerance', (_key, change, classes) => {
    expect(compareSnapshots(change(stored(RECOMPUTED) as Record<string, any>), RECOMPUTED)).toEqual({ stale: true, classes, legacy: false });
  });

  it('a nested key only the recomputed snapshot has is a mismatch', () => {
    const recomputed = { ...RECOMPUTED, factorRelease: { ...RECOMPUTED.factorRelease, newField: 'x' } };
    expect(compareSnapshots(stored(RECOMPUTED), recomputed as unknown as CalculationResultV2).classes).toEqual(['factor']);
  });

  it('a nested change classifies by its top-level field', () => {
    const erratum = {
      ...RECOMPUTED,
      factorRelease: { ...RECOMPUTED.factorRelease, ordinal: 2 },
      conversion: { ...RECOMPUTED.conversion!, multiplier: 10.5 },
    };
    expect(compareSnapshots(stored(erratum), RECOMPUTED)).toEqual({
      stale: true,
      classes: ['conversion', 'factor'],
      legacy: false,
    });
  });

  it('a figure rewritten together with its factor names both, in a fixed order', () => {
    const forged = { ...RECOMPUTED, tCo2e: 0.0001, kgCo2e: 0.1, factorValue: 0.0000002, inputValue: 9 };
    expect(compareSnapshots(stored(forged), RECOMPUTED).classes).toEqual(['input', 'figure', 'factor']);
  });

  it('an extra or a missing key is a mismatch; an unknown key counts with the factor', () => {
    expect(compareSnapshots(stored({ ...RECOMPUTED, note: 'x' }), RECOMPUTED).classes).toEqual(['factor']);
    const { conversionBasis: _drop, ...without } = RECOMPUTED;
    expect(compareSnapshots(stored(without), RECOMPUTED).classes).toEqual(['conversion']);
  });

  it('a pre-LP3-03 snapshot (no snapshotSchema) is stale, even with the same figure', () => {
    const legacy = { ...RECOMPUTED } as Record<string, unknown>;
    delete legacy.snapshotSchema;
    const r = compareSnapshots(stored(legacy), RECOMPUTED);
    expect(r.stale).toBe(true);
    expect(r.legacy).toBe(true);
    // Equal in every field the old shape had: legacy alone makes it stale.
    const sameLegacy = compareSnapshots(stored(legacy), legacy as unknown as CalculationResultV2);
    expect(sameLegacy).toEqual({ stale: true, classes: [], legacy: true });
  });

  it('the integration harness placeholder is a legacy figure', () => {
    const r = compareSnapshots({ tCo2e: 0, factorId: 'int-test-placeholder' }, RECOMPUTED);
    expect(r.stale).toBe(true);
    expect(r.legacy).toBe(true);
  });

  it('an uncalculated record compares as uncalculated', () => {
    expect(compareSnapshots(stored(UNCALCULATED), UNCALCULATED).stale).toBe(false);
    // A factor loaded since: the recompute has a figure now.
    const nowPriced = compareSnapshots(stored(UNCALCULATED), RECOMPUTED);
    expect(nowPriced.stale).toBe(true);
    expect(nowPriced.legacy).toBe(false);
    // And back: a stored figure whose factor is gone.
    expect(compareSnapshots(stored(RECOMPUTED), UNCALCULATED).stale).toBe(true);
  });

  it('the code-authored reason is compared too (C5-A)', () => {
    const reworded = { ...UNCALCULATED, reason: 'Another sentence' };
    expect(compareSnapshots(stored(reworded), UNCALCULATED)).toEqual({
      stale: true,
      classes: ['factor'],
      legacy: false,
    });
  });

  it.each([null, undefined, 'x', 42, [], [RECOMPUTED]])('a stored value that is no snapshot (%o) is stale', (value) => {
    const r = compareSnapshots(value, RECOMPUTED);
    expect(r.stale).toBe(true);
    expect(r.classes).toEqual(['input', 'conversion', 'figure', 'factor']);
  });

  // `qa-auditor` P0 (B2 review): Prisma's write path rounds a double to 16
  // significant digits, in a float8 column and in jsonb (measured), so an
  // honest save comes back from the database a few units in its last digit
  // away from the recompute. Exact comparison refused it — forever.
  it.each([
    [0.3, 0.30000000000000004],
    [2147.28, 2147.2799999999997],
    [277.7777777777778, 277.77777777777777],
    [2.4932928, 2.4932928000000003],
  ])('a number the database rounded (%s, recomputed %s) is the same number', (storedValue, recomputedValue) => {
    const recomputed = { ...RECOMPUTED, kgCo2e: recomputedValue, normalizedValue: recomputedValue };
    const r = compareSnapshots(stored({ ...recomputed, kgCo2e: storedValue, normalizedValue: storedValue }), recomputed);
    expect(r).toEqual({ stale: false, classes: [], legacy: false });
  });

  it('a change of one part in a hundred billion is a mismatch; one part in ten trillion is rounding', () => {
    const t = RECOMPUTED.tCo2e;
    expect(compareSnapshots(stored({ ...RECOMPUTED, tCo2e: t * (1 + 1e-11) }), RECOMPUTED).classes).toEqual(['figure']);
    expect(compareSnapshots(stored({ ...RECOMPUTED, tCo2e: t * (1 + 1e-13) }), RECOMPUTED).stale).toBe(false);
    // Relative, not absolute: a small figure is held to the same share of itself.
    const small = { ...RECOMPUTED, tCo2e: 1e-9 };
    expect(compareSnapshots(stored({ ...small, tCo2e: 1.0001e-9 }), small).classes).toEqual(['figure']);
    expect(compareSnapshots(stored({ ...RECOMPUTED, conversionFactor: 0 }), { ...RECOMPUTED, conversionFactor: 1e-300 }).stale).toBe(true);
  });

  // `security-rls` P2-2 (B2 review): a key named after an `Object.prototype`
  // member looked up a class — or a value — through the prototype, so an
  // honest snapshot carrying `toString` or `__proto__` compared fresh.
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'an extra key named %s is a mismatch, at the top level and nested',
    (key) => {
      const withKey = (json: string) => JSON.parse(json) as Record<string, unknown>;
      const top = withKey(`{"${key}": "x"}`);
      expect(compareSnapshots({ ...(stored(RECOMPUTED) as object), ...top }, RECOMPUTED)).toEqual({
        stale: true,
        classes: ['factor'],
        legacy: false,
      });
      const objectValued = withKey(`{"${key}": {}}`);
      expect(compareSnapshots({ ...(stored(RECOMPUTED) as object), ...objectValued }, RECOMPUTED).stale).toBe(true);
      const nested = stored(RECOMPUTED) as Record<string, Record<string, unknown>>;
      nested.factorRelease = { ...nested.factorRelease, ...withKey(`{"${key}": {}}`) };
      expect(compareSnapshots(nested, RECOMPUTED)).toEqual({ stale: true, classes: ['factor'], legacy: false });
    },
  );

  it('a number stored as text is a mismatch', () => {
    const r = compareSnapshots(stored({ ...RECOMPUTED, tCo2e: '0.52' }), RECOMPUTED);
    expect(r.classes).toEqual(['figure']);
  });
});
