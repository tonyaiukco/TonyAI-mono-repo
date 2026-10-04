import { describe, it, expect } from 'vitest';
import {
  ACTIVITY_UNITS,
  BILLED_ENERGY_CALORIFIC_BASIS,
  CALCULATION_GAS,
  CALCULATION_REFUSAL_CODES,
  CALCULATION_REFUSAL_STATUS,
  CATEGORIES,
  CATEGORY_ACTIVITY_TYPES,
  CATEGORY_SCOPE_MAP,
  CATEGORY_UNITS,
  CONVERSION_IDENTITY_FIELDS,
  CONVERSION_TARGETS,
  DIMENSION_BASE_UNIT,
  FACTOR_GASES,
  FACTOR_IMPORT_TEXT_LIMITS,
  FACTOR_IDENTITY_FIELDS,
  FACTOR_STATUSES,
  FACTOR_STATUS_RANK,
  STANDARD_REFERENCE_CONDITIONS,
  UNIT_DIMENSIONS,
  UNSPECIFIED_ACTIVITY_TYPE,
  directCalorificBasisFor,
  factorActivityTypeFor,
  factorUnitFor,
  resolveFactorPath,
  identityKey,
  isAuthoritativeSnapshot,
  isCalculated,
  isProvenanceSnapshot,
  isRecordActivityTypeAllowed,
  recordActivityTypesFor,
  scope2MethodFor,
  selectByRelease,
  validateFactorReleaseImport,
  yearPolicyOf,
  type CalculationResult,
  type CalculationResultV2,
  type ConversionPathCandidate,
  type FactorPathCandidate,
  type Category,
  type FactorImportRow,
  type FactorReleaseImport,
  type FactorStatus,
  type ReleaseRanked,
  type UncalculatedSnapshot,
  type UnitConversionImportRow,
} from './index';

// Every number below is a STRUCTURAL test value, chosen to be recognisably not
// a real factor. LP3-03 holds no factor value; LP4-02 loads the real ones.
const TEST_RELEASE: FactorReleaseImport['release'] = {
  publisher: 'Structural Test Publisher',
  title: 'Structural test release — not a real publication',
  edition: '2026 test',
  ordinal: 1,
  status: 'authoritative',
  sourceUrl: 'https://example.invalid/structural-test-release',
  licence: 'Test licence',
  publishedAt: '2026-06-01',
  gwpSet: 'AR5',
  reviewedBy: 'Structural test reviewer (role)',
  reviewedAt: '2026-06-15',
  notes: null,
};

function factorRow(over: Partial<FactorImportRow> = {}): FactorImportRow {
  return {
    category: 'Natural Gas',
    activityType: 'natural_gas',
    gas: 'CO2e',
    gasCoverage: 'all_ghg',
    geographyCode: 'UK',
    reportingYear: 2026,
    dataYear: 2026,
    scope: 1,
    factorValue: 1,
    factorUnit: 'kgCO2e/kWh',
    normalizedUnit: 'kWh',
    calorificBasis: 'gross',
    scope2Method: 'not_applicable',
    methodology: 'Structural test methodology',
    source: 'Structural test row',
    ...over,
  };
}

function conversionRow(
  over: Partial<UnitConversionImportRow> = {},
): UnitConversionImportRow {
  return {
    category: 'Natural Gas',
    activityType: 'natural_gas',
    geographyCode: 'UK',
    reportingYear: 2026,
    dataYear: 2026,
    fromUnit: 'cubic_metres',
    toUnit: 'kWh',
    multiplier: 2,
    calorificBasis: 'gross',
    referenceConditions: '15 °C, 1013.25 mbar (test)',
    basis: 'Structural test derivation',
    ...over,
  };
}

function release(
  over: Partial<FactorReleaseImport> & {
    meta?: Partial<FactorReleaseImport['release']>;
  } = {},
): FactorReleaseImport {
  return {
    release: { ...TEST_RELEASE, ...over.meta },
    factors: over.factors ?? [factorRow()],
    conversions: over.conversions ?? [],
  };
}

function issuesAt(input: FactorReleaseImport): string[] {
  return validateFactorReleaseImport(input).map((issue) => issue.path);
}

describe('units for the factor model (LP3-03)', () => {
  it('gives every unit a definitional family', () => {
    for (const unit of ACTIVITY_UNITS) {
      expect(UNIT_DIMENSIONS).toContain(unit.dimension);
    }
  });

  it('keeps metered and standard cubic metres in different families', () => {
    // Sm³ and m³ are different quantities; one family would let a conversion
    // between them pass as "definitional".
    const dimension = (value: string) =>
      ACTIVITY_UNITS.find((u) => u.value === value)?.dimension;
    expect(dimension('cubic_metres')).toBe('metered_volume');
    expect(dimension('standard_cubic_metres')).toBe('standard_volume');
    expect(dimension('kWh')).toBe('energy');
  });

  it('adds kg for refrigerants, as a mass', () => {
    expect(ACTIVITY_UNITS.find((u) => u.value === 'kg')).toMatchObject({
      target: 'kg',
      dimension: 'mass',
    });
    expect(CATEGORY_UNITS.Refrigerants).toEqual(['kg']);
  });

  it('measures mobile combustion in fuel volumes only (fuel-based, T4)', () => {
    // Litres of liquid fuel, kilograms of CNG — never a distance yet.
    expect(CATEGORY_UNITS['Mobile Combustion']).toEqual([
      'litres',
      'uk_gallons',
      'us_gallons',
      'kg',
    ]);
  });

  it('constrains the units of every Scope 1 and Scope 2 category', () => {
    for (const category of CATEGORIES) {
      if (CATEGORY_SCOPE_MAP[category] === 3) continue;
      const units = CATEGORY_UNITS[category];
      expect(units, category).toBeDefined();
      for (const unit of units ?? []) {
        expect(ACTIVITY_UNITS.map((u) => u.value), `${category}: ${unit}`).toContain(unit);
      }
    }
  });
});

describe('activity types (K1 = A1)', () => {
  it('lists each token once per category, never the unspecified one', () => {
    for (const [category, spec] of Object.entries(CATEGORY_ACTIVITY_TYPES)) {
      const values = spec!.types.map((t) => t.value);
      expect(new Set(values).size, category).toBe(values.length);
      expect(values, category).not.toContain(UNSPECIFIED_ACTIVITY_TYPE);
    }
  });

  it('names an implicit type that is its category’s only type', () => {
    for (const [category, spec] of Object.entries(CATEGORY_ACTIVITY_TYPES)) {
      if (spec!.implicit === undefined) continue;
      expect(spec!.types.map((t) => t.value), category).toEqual([spec!.implicit]);
    }
  });

  it('covers every Scope 1 and Scope 2 category', () => {
    for (const category of CATEGORIES) {
      if (CATEGORY_SCOPE_MAP[category] === 3) continue;
      expect(CATEGORY_ACTIVITY_TYPES[category], category).toBeDefined();
    }
  });

  it('types the categories whose factors differ by fuel or gas', () => {
    for (const category of ['Fuel', 'Mobile Combustion', 'Refrigerants'] as const) {
      expect(CATEGORY_ACTIVITY_TYPES[category]?.implicit, category).toBeUndefined();
      expect(recordActivityTypesFor(category).length, category).toBeGreaterThan(1);
    }
  });

  it('lets an implicit category’s record name nothing — not even its own type', () => {
    // A typed and an untyped Electricity record would be two keys to the
    // unique index: two "different" records for one meter.
    expect(recordActivityTypesFor('Electricity')).toEqual([]);
    expect(isRecordActivityTypeAllowed('Electricity', null)).toBe(true);
    expect(isRecordActivityTypeAllowed('Electricity', 'grid_electricity')).toBe(false);
  });

  it('lets a typed category’s record name one of its own types, or none', () => {
    expect(isRecordActivityTypeAllowed('Mobile Combustion', 'diesel')).toBe(true);
    expect(isRecordActivityTypeAllowed('Mobile Combustion', undefined)).toBe(true);
    expect(isRecordActivityTypeAllowed('Mobile Combustion', 'R-410A')).toBe(false);
    expect(isRecordActivityTypeAllowed('Refrigerants', 'diesel')).toBe(false);
    expect(isRecordActivityTypeAllowed('Fuel', UNSPECIFIED_ACTIVITY_TYPE)).toBe(false);
    expect(isRecordActivityTypeAllowed('Waste', 'diesel')).toBe(false);
  });

  it('resolves the factor lookup’s activity type', () => {
    expect(factorActivityTypeFor('Mobile Combustion', 'petrol')).toBe('petrol');
    expect(factorActivityTypeFor('Electricity', null)).toBe('grid_electricity');
    expect(factorActivityTypeFor('Natural Gas', undefined)).toBe('natural_gas');
    expect(factorActivityTypeFor('Fuel', null)).toBe(UNSPECIFIED_ACTIVITY_TYPE);
    expect(factorActivityTypeFor('Waste', null)).toBe(UNSPECIFIED_ACTIVITY_TYPE);
  });
});

describe('scope2MethodFor (D08)', () => {
  it('is location-based for Scope 2 and not applicable elsewhere', () => {
    expect(scope2MethodFor('Electricity')).toBe('location');
    expect(scope2MethodFor('Natural Gas')).toBe('not_applicable');
    expect(scope2MethodFor('Water')).toBe('not_applicable');
  });
});

describe('factor identity — the contract tells every dimension apart', () => {
  const base = {
    releaseId: 'release-a',
    category: 'Natural Gas',
    activityType: 'natural_gas',
    gas: 'CO2e',
    geographyCode: 'UK',
    reportingYear: 2026,
    scope2Method: 'not_applicable',
    calorificBasis: 'gross',
    normalizedUnit: 'kWh',
  };
  const changed: Record<(typeof FACTOR_IDENTITY_FIELDS)[number], unknown> = {
    releaseId: 'release-b',
    category: 'Fuel',
    activityType: 'diesel',
    gas: 'CH4',
    geographyCode: 'TR',
    reportingYear: 2025,
    scope2Method: 'location',
    calorificBasis: 'net',
    normalizedUnit: 'cubic_metres',
  };

  it.each(FACTOR_IDENTITY_FIELDS.map((field) => [field]))(
    'a different %s is a different factor',
    (field) => {
      expect(identityKey({ ...base, [field]: changed[field] }, FACTOR_IDENTITY_FIELDS)).not.toBe(
        identityKey(base, FACTOR_IDENTITY_FIELDS),
      );
    },
  );

  it('pins the identity to exactly these dimensions', () => {
    // The table above is generated from the constant, so a field dropped from
    // it would drop its own test too; this list is written out by hand.
    expect([...FACTOR_IDENTITY_FIELDS].sort()).toEqual(
      [
        'activityType',
        'calorificBasis',
        'category',
        'gas',
        'geographyCode',
        'normalizedUnit',
        'releaseId',
        'reportingYear',
        'scope2Method',
      ].sort(),
    );
    expect([...CONVERSION_IDENTITY_FIELDS].sort()).toEqual(
      [
        'activityType',
        'calorificBasis',
        'category',
        'fromUnit',
        'geographyCode',
        'releaseId',
        'reportingYear',
        'toUnit',
      ].sort(),
    );
  });

  it('the same values are the same factor', () => {
    expect(identityKey({ ...base }, FACTOR_IDENTITY_FIELDS)).toBe(
      identityKey(base, FACTOR_IDENTITY_FIELDS),
    );
  });

  it('keys conversions on unit pair and basis, not on gas', () => {
    expect(CONVERSION_IDENTITY_FIELDS).toEqual(
      expect.arrayContaining(['fromUnit', 'toUnit', 'calorificBasis', 'reportingYear']),
    );
    expect(CONVERSION_IDENTITY_FIELDS).not.toContain('gas');
  });
});

describe('yearPolicyOf (D07)', () => {
  it('is exact only when the data year is the activity year', () => {
    expect(yearPolicyOf(2026, 2026)).toBe('exact');
    expect(yearPolicyOf(2026, 2025)).toBe('declared_fallback');
  });
});

describe('selectByRelease', () => {
  const candidate = (
    status: FactorStatus,
    ordinal: number,
    publisher = 'P',
    id = `${publisher}-${ordinal}-${status}`,
  ): ReleaseRanked & { id: string } => ({ id, release: { status, ordinal, publisher } });
  const allow = { allowPlaceholders: true };
  const deny = { allowPlaceholders: false };

  it('orders by ordinal, never by edition text — 10 outranks 2 (F01)', () => {
    // As text, '2024.2' sorts after '2024.10'; the ordinal is what is compared.
    const older = candidate('authoritative', 2);
    const newer = candidate('authoritative', 10);
    Object.assign(older.release, { edition: '2024.2' });
    Object.assign(newer.release, { edition: '2024.10' });
    expect(selectByRelease([older, newer], deny)).toEqual({ ok: true, selected: newer });
    expect(selectByRelease([newer, older], deny)).toEqual({ ok: true, selected: newer });
  });

  it('lets an authoritative release beat a placeholder with a higher ordinal', () => {
    const real = candidate('authoritative', 1, 'DESNZ');
    const demo = candidate('placeholder', 99, 'Prototype');
    expect(selectByRelease([demo, real], allow)).toEqual({ ok: true, selected: real });
  });

  it('ranks a placeholder above a fixture', () => {
    const demo = candidate('placeholder', 1, 'Prototype');
    const fixture = candidate('fixture', 50, 'Test');
    expect(selectByRelease([fixture, demo], allow)).toEqual({ ok: true, selected: demo });
    expect(FACTOR_STATUS_RANK.placeholder).toBeGreaterThan(FACTOR_STATUS_RANK.fixture);
  });

  it('refuses placeholders and fixtures where they are not allowed', () => {
    expect(selectByRelease([candidate('placeholder', 1)], deny)).toEqual({
      ok: false,
      reason: 'placeholder_refused',
    });
    expect(selectByRelease([candidate('fixture', 1)], deny)).toEqual({
      ok: false,
      reason: 'placeholder_refused',
    });
    expect(selectByRelease([candidate('placeholder', 1)], allow).ok).toBe(true);
  });

  it('never resolves a withdrawn release, even the newest', () => {
    const kept = candidate('authoritative', 1);
    const withdrawn = candidate('withdrawn', 2);
    expect(selectByRelease([withdrawn, kept], deny)).toEqual({ ok: true, selected: kept });
    expect(selectByRelease([withdrawn], allow)).toEqual({ ok: false, reason: 'none' });
  });

  it('answers none with no candidates at all', () => {
    expect(selectByRelease([], allow)).toEqual({ ok: false, reason: 'none' });
  });

  it('refuses two publishers at the top rank instead of picking one', () => {
    expect(
      selectByRelease(
        [candidate('authoritative', 5, 'DESNZ'), candidate('authoritative', 1, 'Other')],
        deny,
      ),
    ).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('refuses a tie on ordinal', () => {
    expect(
      selectByRelease(
        [candidate('authoritative', 3, 'P', 'a'), candidate('authoritative', 3, 'P', 'b')],
        deny,
      ),
    ).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('is not confused by a lower-ranked second publisher', () => {
    const real = candidate('authoritative', 1, 'DESNZ');
    expect(
      selectByRelease([real, candidate('placeholder', 7, 'Prototype')], allow),
    ).toEqual({ ok: true, selected: real });
  });

  it('ranks every status', () => {
    for (const status of FACTOR_STATUSES) {
      expect(Number.isFinite(FACTOR_STATUS_RANK[status])).toBe(true);
    }
  });
});

describe('snapshot v2', () => {
  const v1: CalculationResult = {
    category: 'Natural Gas',
    geographyCode: 'UK',
    reportingYear: 2026,
    scope: 1,
    inputValue: 10,
    inputUnit: 'kWh',
    normalizedValue: 10,
    normalizedUnit: 'kWh',
    conversionApplied: false,
    kgCo2e: 10,
    tCo2e: 0.01,
    factorId: 'factor-1',
    factorValue: 1,
    factorUnit: 'kgCO2e/kWh',
    methodology: 'test',
    source: 'test',
    version: 'test',
  };
  const v2: CalculationResultV2 = {
    ...v1,
    snapshotSchema: 2,
    activityType: 'natural_gas',
    gas: CALCULATION_GAS,
    gasCoverage: 'all_ghg',
    calorificBasis: 'gross',
    scope2Method: 'not_applicable',
    dataYear: 2026,
    yearPolicy: 'exact',
    factorRelease: {
      id: 'release-1',
      publisher: 'Structural Test Publisher',
      title: 'Structural test release',
      edition: '2026 test',
      ordinal: 1,
      status: 'placeholder',
      sourceUrl: null,
      licence: null,
      publishedAt: null,
      gwpSet: null,
    },
    conversion: null,
  };
  const uncalculated: UncalculatedSnapshot = {
    snapshotSchema: 1,
    category: 'Water',
    geographyCode: 'UK',
    reportingYear: 2026,
    scope: 3,
    inputValue: 5,
    inputUnit: 'cubic_metres',
    reasonCode: 'no_emission_factor',
    reason: 'test',
  };

  it('reads a v2 snapshot as calculated, so every v1 reader keeps working', () => {
    expect(isCalculated(v2)).toBe(true);
  });

  it('tells v2 from the untagged v1 and from the uncalculated shape', () => {
    expect(isProvenanceSnapshot(v2)).toBe(true);
    expect(isProvenanceSnapshot(v1)).toBe(false);
    // Schema 1 is the uncalculated shape: a tag alone is not provenance.
    expect(isProvenanceSnapshot(uncalculated)).toBe(false);
    expect(isProvenanceSnapshot(null)).toBe(false);
  });

  it('calls a snapshot authoritative only when every link is', () => {
    const real = { ...v2.factorRelease, status: 'authoritative' as const };
    const step = {
      id: 'c',
      fromUnit: 'cubic_metres',
      toUnit: 'kWh',
      multiplier: 2,
      calorificBasis: 'gross' as const,
      referenceConditions: 'test',
      basis: 'test',
      dataYear: 2026,
      release: real,
    };
    expect(isAuthoritativeSnapshot({ ...v2, factorRelease: real })).toBe(true);
    expect(isAuthoritativeSnapshot({ ...v2, factorRelease: real, conversion: step })).toBe(true);
    expect(
      isAuthoritativeSnapshot({
        ...v2,
        factorRelease: real,
        conversion: { ...step, release: { ...real, status: 'placeholder' } },
      }),
    ).toBe(false);
    expect(isAuthoritativeSnapshot(v2)).toBe(false);
    expect(isAuthoritativeSnapshot(v1)).toBe(false);
    expect(isAuthoritativeSnapshot(uncalculated)).toBe(false);
    expect(isAuthoritativeSnapshot(null)).toBe(false);
  });

  it('needs a real figure as well as the tag', () => {
    expect(isProvenanceSnapshot({ ...v2, factorId: '' })).toBe(false);
    expect(isProvenanceSnapshot({ ...v2, tCo2e: Number.NaN })).toBe(false);
  });
});

describe('calculation refusals', () => {
  it('gives every code a status, and coverage gaps a 404', () => {
    for (const code of CALCULATION_REFUSAL_CODES) {
      expect([400, 404, 409]).toContain(CALCULATION_REFUSAL_STATUS[code]);
    }
    for (const code of ['no_factor', 'placeholder_refused', 'no_conversion'] as const) {
      expect(CALCULATION_REFUSAL_STATUS[code]).toBe(404);
    }
    expect(CALCULATION_REFUSAL_STATUS.ambiguous_factor).toBe(409);
  });
});

describe('validateFactorReleaseImport', () => {
  it('accepts a complete authoritative release', () => {
    expect(
      validateFactorReleaseImport(
        release({
          factors: [
            factorRow(),
            factorRow({ gas: 'CH4', gasCoverage: null, factorValue: 0.1 }),
            factorRow({
              category: 'Electricity',
              activityType: 'grid_electricity',
              scope: 2,
              scope2Method: 'location',
              calorificBasis: 'not_applicable',
            }),
            factorRow({
              category: 'Refrigerants',
              activityType: 'R-410A',
              normalizedUnit: 'kg',
              factorUnit: 'kgCO2e/kg',
              calorificBasis: 'not_applicable',
            }),
            factorRow({
              category: 'Mobile Combustion',
              activityType: 'diesel',
              normalizedUnit: 'litres',
              factorUnit: 'kgCO2e/L',
              calorificBasis: 'not_applicable',
            }),
          ],
          conversions: [conversionRow()],
        }),
      ),
    ).toEqual([]);
  });

  it('requires an authoritative release to carry its provenance', () => {
    const paths = issuesAt(
      release({
        meta: {
          sourceUrl: null,
          licence: null,
          publishedAt: null,
          gwpSet: null,
          reviewedBy: null,
          reviewedAt: null,
        },
      }),
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        'release.sourceUrl',
        'release.licence',
        'release.publishedAt',
        'release.gwpSet',
        'release.reviewedBy',
        'release.reviewedAt',
      ]),
    );
  });

  it('lets a placeholder release go without provenance', () => {
    expect(
      issuesAt(
        release({
          meta: {
            status: 'placeholder',
            sourceUrl: null,
            licence: null,
            publishedAt: null,
            gwpSet: null,
            reviewedBy: null,
            reviewedAt: null,
          },
        }),
      ),
    ).toEqual([]);
  });

  it('refuses a release loaded as withdrawn, an unordered one and an empty one', () => {
    expect(issuesAt(release({ meta: { status: 'withdrawn' } }))).toContain('release.status');
    expect(issuesAt(release({ meta: { ordinal: 0 } }))).toContain('release.ordinal');
    expect(issuesAt(release({ meta: { ordinal: 1.5 } }))).toContain('release.ordinal');
    expect(issuesAt(release({ factors: [], conversions: [] }))).toContain('release');
  });

  it('refuses a malformed date, a non-https source and an unknown GWP set', () => {
    expect(issuesAt(release({ meta: { publishedAt: '2026-02-30' } }))).toContain('release.publishedAt');
    expect(issuesAt(release({ meta: { sourceUrl: 'http://example.invalid/x' } }))).toContain(
      'release.sourceUrl',
    );
    expect(issuesAt(release({ meta: { gwpSet: 'SAR' } }))).toContain('release.gwpSet');
  });

  it('keeps the unspecified activity type out of an authoritative release', () => {
    const row = factorRow({
      category: 'Fuel',
      activityType: UNSPECIFIED_ACTIVITY_TYPE,
      normalizedUnit: 'litres',
      factorUnit: 'kgCO2e/L',
      calorificBasis: 'not_applicable',
    });
    expect(issuesAt(release({ factors: [row] }))).toContain('factors[0].activityType');
    expect(issuesAt(release({ meta: { status: 'placeholder' }, factors: [row] }))).toEqual([]);
  });

  it('refuses a fuel or gas its category does not have', () => {
    expect(
      issuesAt(release({ factors: [factorRow({ category: 'Refrigerants', activityType: 'diesel', normalizedUnit: 'kg', calorificBasis: 'not_applicable' })] })),
    ).toContain('factors[0].activityType');
  });

  it('pins scope to the category', () => {
    expect(issuesAt(release({ factors: [factorRow({ scope: 2 })] }))).toContain('factors[0].scope');
  });

  it('demands a calorific basis exactly where a fuel is quoted per unit of energy', () => {
    expect(
      issuesAt(release({ factors: [factorRow({ calorificBasis: 'not_applicable' })] })),
    ).toContain('factors[0].calorificBasis');
    expect(
      issuesAt(
        release({
          factors: [
            factorRow({
              category: 'Fuel',
              activityType: 'diesel',
              normalizedUnit: 'litres',
              calorificBasis: 'gross',
            }),
          ],
        }),
      ),
    ).toContain('factors[0].calorificBasis');
  });

  it('demands a Scope 2 method on Scope 2 factors only', () => {
    const electricity = {
      category: 'Electricity',
      activityType: 'grid_electricity',
      scope: 2,
      calorificBasis: 'not_applicable',
    };
    expect(
      issuesAt(release({ factors: [factorRow({ ...electricity, scope2Method: 'not_applicable' })] })),
    ).toContain('factors[0].scope2Method');
    expect(
      issuesAt(release({ factors: [factorRow({ scope2Method: 'location' })] })),
    ).toContain('factors[0].scope2Method');
  });

  it('refuses a unit the category is not measured in', () => {
    expect(
      issuesAt(release({ factors: [factorRow({ normalizedUnit: 'litres', calorificBasis: 'not_applicable' })] })),
    ).toContain('factors[0].normalizedUnit');
  });

  it('refuses a negative or non-finite factor value', () => {
    expect(issuesAt(release({ factors: [factorRow({ factorValue: -1 })] }))).toContain(
      'factors[0].factorValue',
    );
    expect(issuesAt(release({ factors: [factorRow({ factorValue: Number.NaN })] }))).toContain(
      'factors[0].factorValue',
    );
  });

  it('refuses a data year later than the year it is declared for', () => {
    expect(issuesAt(release({ factors: [factorRow({ dataYear: 2027 })] }))).toContain(
      'factors[0].dataYear',
    );
    // An earlier data year is a declared fallback (D07), which a release may make.
    expect(issuesAt(release({ factors: [factorRow({ dataYear: 2025 })] }))).toEqual([]);
  });

  it('refuses the same factor twice in one file', () => {
    expect(issuesAt(release({ factors: [factorRow(), factorRow()] }))).toContain('factors[1].gas');
  });

  it('accepts the same fuel per kWh and per Sm³, and on both bases', () => {
    expect(
      issuesAt(
        release({
          factors: [
            factorRow(),
            factorRow({ calorificBasis: 'net' }),
            factorRow({
              normalizedUnit: 'standard_cubic_metres',
              calorificBasis: 'not_applicable',
              factorUnit: 'kgCO2e/Sm³',
            }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('refuses a per-gas breakdown with no CO2e total beside it', () => {
    expect(
      issuesAt(release({ factors: [factorRow({ gas: 'N2O', gasCoverage: null })] })),
    ).toContain('factors[0].gas');
  });

  it('refuses a definitional step disguised as a sourced conversion', () => {
    expect(
      issuesAt(release({ conversions: [conversionRow({ fromUnit: 'MWh', toUnit: 'kWh' })] })),
    ).toContain('conversions[0].toUnit');
  });

  it('demands a basis and reference conditions on a gas-volume-to-energy step', () => {
    expect(
      issuesAt(release({ conversions: [conversionRow({ calorificBasis: 'not_applicable' })] })),
    ).toContain('conversions[0].calorificBasis');
    expect(
      issuesAt(release({ conversions: [conversionRow({ referenceConditions: null })] })),
    ).toContain('conversions[0].referenceConditions');
  });

  it('refuses a non-positive multiplier and a duplicate conversion', () => {
    expect(issuesAt(release({ conversions: [conversionRow({ multiplier: 0 })] }))).toContain(
      'conversions[0].multiplier',
    );
    expect(
      issuesAt(release({ conversions: [conversionRow(), conversionRow()] })),
    ).toContain('conversions[1].toUnit');
  });

  it('refuses an unknown category, gas or geography', () => {
    expect(issuesAt(release({ factors: [factorRow({ category: 'Steam' })] }))).toContain(
      'factors[0].category',
    );
    expect(issuesAt(release({ factors: [factorRow({ gas: 'SF6' })] }))).toContain('factors[0].gas');
    expect(issuesAt(release({ factors: [factorRow({ geographyCode: 'FR' })] }))).toContain(
      'factors[0].geographyCode',
    );
  });
});

describe('the pilot categories can be expressed end to end', () => {
  it('has, for every Scope 1/2 category, a unit and an activity type a factor can name', () => {
    for (const category of CATEGORIES as readonly Category[]) {
      if (CATEGORY_SCOPE_MAP[category] === 3) continue;
      expect(CATEGORY_UNITS[category]?.length, category).toBeGreaterThan(0);
      expect(CATEGORY_ACTIVITY_TYPES[category]?.types.length, category).toBeGreaterThan(0);
    }
  });
});

describe('review round 1 — units and identities', () => {
  it('names one base unit per family, each a unit of that family', () => {
    for (const [dimension, unit] of Object.entries(DIMENSION_BASE_UNIT)) {
      expect(ACTIVITY_UNITS.find((u) => u.value === unit)?.dimension, dimension).toBe(dimension);
    }
  });

  it('writes a factor unit as kg CO2e per one base unit', () => {
    expect(factorUnitFor('kWh')).toBe('kgCO2e/kWh');
    expect(factorUnitFor('litres')).toBe('kgCO2e/L');
    expect(factorUnitFor('standard_cubic_metres')).toBe('kgCO2e/Sm³');
  });

  it('keeps biogenic CO2 as its own, never-summed gas', () => {
    expect(FACTOR_GASES).toContain('CO2_biogenic');
  });

  it('answers an inherited key as an unknown category, never by throwing', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(recordActivityTypesFor(key)).toEqual([]);
      expect(isRecordActivityTypeAllowed(key, 'diesel')).toBe(false);
      expect(factorActivityTypeFor(key, null)).toBe(UNSPECIFIED_ACTIVITY_TYPE);
    }
  });

  it('refuses a new untyped record in a typed category with its own code', () => {
    expect(CALCULATION_REFUSAL_CODES).toContain('activity_type_required');
    expect(CALCULATION_REFUSAL_STATUS.activity_type_required).toBe(400);
  });
});

describe('selectByRelease — unknown statuses', () => {
  it('never ranks a status the contract does not know, even with placeholders allowed', () => {
    const typo = { release: { status: 'Authoritative' as FactorStatus, ordinal: 9, publisher: 'P' } };
    const real = { release: { status: 'placeholder' as FactorStatus, ordinal: 1, publisher: 'P' } };
    expect(selectByRelease([typo, real], { allowPlaceholders: true })).toEqual({
      ok: true,
      selected: real,
    });
    expect(selectByRelease([typo], { allowPlaceholders: true })).toEqual({ ok: false, reason: 'none' });
  });
});

describe('resolveFactorPath', () => {
  type F = FactorPathCandidate & { id: string };
  type C = ConversionPathCandidate & { id: string };
  const rel = (status: FactorStatus, ordinal = 1, publisher = 'P') => ({ status, ordinal, publisher });
  const factor = (id: string, normalizedUnit: string, calorificBasis: string, status: FactorStatus = 'authoritative', publisher = 'P', ordinal = 1): F => ({
    id,
    normalizedUnit,
    calorificBasis,
    release: rel(status, ordinal, publisher),
  });
  const conversion = (id: string, fromUnit: string, toUnit: string, calorificBasis: string, status: FactorStatus = 'authoritative'): C => ({
    id,
    fromUnit,
    toUnit,
    calorificBasis,
    release: rel(status),
  });
  const resolve = (
    category: string,
    inputUnit: string,
    factors: F[],
    conversions: C[] = [],
    allowPlaceholders = false,
  ) => resolveFactorPath({ category, inputUnit, factors, conversions, allowPlaceholders });
  const picked = (r: ReturnType<typeof resolve>) =>
    r.ok ? [r.factor.id, r.conversion?.id ?? null] : r.code;

  it('prices billed gas energy with the gross factor, directly', () => {
    const gross = factor('kwh-gross', 'kWh', 'gross');
    const net = factor('kwh-net', 'kWh', 'net');
    expect(picked(resolve('Natural Gas', 'kWh', [net, gross]))).toEqual(['kwh-gross', null]);
    // A definitional step (MWh → kWh) needs no conversion row.
    expect(picked(resolve('Natural Gas', 'MWh', [gross]))).toEqual(['kwh-gross', null]);
    expect(directCalorificBasisFor('Natural Gas', 'kWh')).toBe('gross');
    expect(directCalorificBasisFor('Electricity', 'kWh')).toBe('not_applicable');
  });

  it('refuses billed energy when only net factors exist', () => {
    expect(picked(resolve('Natural Gas', 'kWh', [factor('kwh-net', 'kWh', 'net')]))).toBe(
      'calorific_basis_mismatch',
    );
  });

  it('prices electricity, which has no calorific basis', () => {
    expect(
      picked(resolve('Electricity', 'kWh', [factor('grid', 'kWh', 'not_applicable')])),
    ).toEqual(['grid', null]);
  });

  it('reaches a per-kWh factor from metered m³ only through a conversion on its basis', () => {
    const gross = factor('kwh-gross', 'kWh', 'gross');
    expect(picked(resolve('Natural Gas', 'cubic_metres', [gross]))).toBe('no_conversion');
    expect(
      picked(resolve('Natural Gas', 'cubic_metres', [gross], [conversion('m3-kwh-net', 'cubic_metres', 'kWh', 'net')])),
    ).toBe('calorific_basis_mismatch');
    expect(
      picked(resolve('Natural Gas', 'cubic_metres', [gross], [conversion('m3-kwh', 'cubic_metres', 'kWh', 'gross')])),
    ).toEqual(['kwh-gross', 'm3-kwh']);
  });

  it('prefers a direct factor to a converted one at the same rank', () => {
    const perSm3 = factor('sm3', 'standard_cubic_metres', 'not_applicable');
    const perKwh = factor('kwh', 'kWh', 'gross');
    const step = conversion('sm3-kwh', 'standard_cubic_metres', 'kWh', 'gross');
    expect(picked(resolve('Natural Gas', 'standard_cubic_metres', [perKwh, perSm3], [step]))).toEqual([
      'sm3',
      null,
    ]);
  });

  it('prefers the earlier conversion family when two converted paths tie', () => {
    expect(CONVERSION_TARGETS.metered_volume).toEqual(['energy', 'standard_volume']);
    const perKwh = factor('kwh', 'kWh', 'gross');
    const perSm3 = factor('sm3', 'standard_cubic_metres', 'not_applicable');
    expect(
      picked(
        resolve(
          'Natural Gas',
          'cubic_metres',
          [perSm3, perKwh],
          [
            conversion('m3-sm3', 'cubic_metres', 'standard_cubic_metres', 'not_applicable'),
            conversion('m3-kwh', 'cubic_metres', 'kWh', 'gross'),
          ],
        ),
      ),
    ).toEqual(['kwh', 'm3-kwh']);
  });

  it('ranks across every path first — authoritative converted beats placeholder direct', () => {
    const demoDirect = factor('demo-sm3', 'standard_cubic_metres', 'not_applicable', 'placeholder', 'Prototype');
    const realKwh = factor('real-kwh', 'kWh', 'gross');
    const realStep = conversion('real-step', 'standard_cubic_metres', 'kWh', 'gross');
    expect(
      picked(resolve('Natural Gas', 'standard_cubic_metres', [demoDirect, realKwh], [realStep], true)),
    ).toEqual(['real-kwh', 'real-step']);
  });

  it('is only as authoritative as its weakest link', () => {
    const realKwh = factor('real-kwh', 'kWh', 'gross');
    const demoStep = conversion('demo-step', 'cubic_metres', 'kWh', 'gross', 'placeholder');
    expect(picked(resolve('Natural Gas', 'cubic_metres', [realKwh], [demoStep]))).toBe(
      'placeholder_refused',
    );
    expect(picked(resolve('Natural Gas', 'cubic_metres', [realKwh], [demoStep], true))).toEqual([
      'real-kwh',
      'demo-step',
    ]);
  });

  it('uses a conversion only from the base unit of the record’s own family', () => {
    const perKwh = factor('kwh', 'kWh', 'gross');
    // An Sm³ → kWh step cannot price a metered m³ reading: that would skip the
    // volume correction.
    const fromSm3 = conversion('sm3-kwh', 'standard_cubic_metres', 'kWh', 'gross');
    expect(picked(resolve('Natural Gas', 'cubic_metres', [perKwh], [fromSm3]))).toBe('no_conversion');
  });

  it('ranks a path by its weakest link even where placeholders are allowed', () => {
    // Authoritative factor + placeholder step ranks as a placeholder, so it
    // ties with a placeholder direct factor — and direct wins the tie.
    const demoDirect = factor('demo-sm3', 'standard_cubic_metres', 'not_applicable', 'placeholder', 'Prototype');
    const realKwh = factor('real-kwh', 'kWh', 'gross');
    const demoStep = conversion('demo-step', 'standard_cubic_metres', 'kWh', 'gross', 'placeholder');
    expect(
      picked(resolve('Natural Gas', 'standard_cubic_metres', [realKwh, demoDirect], [demoStep], true)),
    ).toEqual(['demo-sm3', null]);
  });

  it('never uses a withdrawn link', () => {
    const realKwh = factor('real-kwh', 'kWh', 'gross');
    const withdrawnStep = conversion('old-step', 'cubic_metres', 'kWh', 'gross', 'withdrawn');
    // The gap is the conversion, so that is what a coverage report must say.
    expect(picked(resolve('Natural Gas', 'cubic_metres', [realKwh], [withdrawnStep], true))).toBe(
      'no_conversion',
    );
    const unknownStep = conversion('odd-step', 'cubic_metres', 'kWh', 'gross', 'Authoritative' as FactorStatus);
    expect(picked(resolve('Natural Gas', 'cubic_metres', [realKwh], [unknownStep], true))).toBe(
      'no_conversion',
    );
  });

  it('refuses two publishers instead of picking one', () => {
    expect(
      picked(
        resolve('Electricity', 'kWh', [
          factor('a', 'kWh', 'not_applicable', 'authoritative', 'A'),
          factor('b', 'kWh', 'not_applicable', 'authoritative', 'B'),
        ]),
      ),
    ).toBe('ambiguous_factor');
  });

  it('takes the newest release of one publisher', () => {
    expect(
      picked(
        resolve('Electricity', 'kWh', [
          factor('v2', 'kWh', 'not_applicable', 'authoritative', 'P', 2),
          factor('v10', 'kWh', 'not_applicable', 'authoritative', 'P', 10),
        ]),
      ),
    ).toEqual(['v10', null]);
  });

  it('has no path from a litre to a per-kWh factor, and none from an unknown unit', () => {
    expect(picked(resolve('Fuel', 'litres', [factor('kwh', 'kWh', 'gross')]))).toBe('no_factor');
    expect(picked(resolve('Fuel', 'furlongs', []))).toBe('unit_unknown');
    expect(picked(resolve('Fuel', 'litres', []))).toBe('no_factor');
  });
});

describe('validateFactorReleaseImport — review round 1', () => {
  const RLO = String.fromCharCode(0x202e);
  const ZWSP = String.fromCharCode(0x200b);
  const NUL = String.fromCharCode(0);

  it('reports a malformed file instead of throwing', () => {
    for (const bad of [
      null,
      42,
      [],
      {},
      { release: {}, factors: null, conversions: [] },
      { release: {}, factors: [], conversions: null },
      { release: null, factors: [], conversions: [] },
    ]) {
      expect(validateFactorReleaseImport(bad)).toEqual([
        { path: '', message: expect.stringContaining('release, factors[] and conversions[]') },
      ]);
    }
    expect(issuesAt({ ...release(), factors: [null as unknown as FactorImportRow] })).toContain('factors[0]');
  });

  it('checks value types, not just meanings', () => {
    expect(
      issuesAt(release({ factors: [factorRow({ reportingYear: '2026' as unknown as number })] })),
    ).toContain('factors[0].reportingYear');
    expect(
      issuesAt(release({ factors: [factorRow({ factorValue: '1' as unknown as number })] })),
    ).toContain('factors[0].factorValue');
    expect(
      issuesAt(
        release({
          meta: { status: 'placeholder', sourceUrl: ['https://x'] as unknown as string },
        }),
      ),
    ).toContain('release.sourceUrl');
  });

  it('never echoes an unrecognised status', () => {
    const status = `${RLO}${'x'.repeat(10_000)}`;
    const issues = validateFactorReleaseImport(
      release({ meta: { status }, factors: [factorRow({ activityType: 'diesel' })] }),
    );
    expect(issues.map((i) => i.path)).toContain('release.status');
    for (const { message } of issues) {
      expect(message).not.toContain(RLO);
      expect(message.length).toBeLessThan(200);
    }
  });

  it('refuses invisible, control and oversized text', () => {
    expect(issuesAt(release({ meta: { publisher: `DESNZ${ZWSP}` } }))).toContain('release.publisher');
    expect(issuesAt(release({ meta: { title: `A ${RLO}title` } }))).toContain('release.title');
    expect(issuesAt(release({ meta: { sourceUrl: `https://example.invalid/${RLO}x` } }))).toContain(
      'release.sourceUrl',
    );
    expect(issuesAt(release({ factors: [factorRow({ source: `row${NUL}` })] }))).toContain(
      'factors[0].source',
    );
    expect(
      issuesAt(release({ meta: { licence: 'x'.repeat(FACTOR_IMPORT_TEXT_LIMITS.licence + 1) } })),
    ).toContain('release.licence');
    expect(issuesAt(release({ meta: { publisher: ' DESNZ' } }))).toContain('release.publisher');
    // Default-ignorable and surrogate code points: a Hangul filler, a
    // combining grapheme joiner, a soft hyphen, a lone surrogate.
    for (const code of [0x3164, 0x034f, 0x00ad, 0xd800]) {
      expect(
        issuesAt(release({ meta: { publisher: `DESNZ${String.fromCharCode(code)}` } })),
        code.toString(16),
      ).toContain('release.publisher');
    }
    // Turkish letters and an internal no-break space are text, not tricks.
    expect(
      issuesAt(release({ meta: { title: `Enerji ve Tabii Kaynaklar Bakanl${String.fromCharCode(0x131)}${String.fromCharCode(0xa0)}2026` } })),
    ).toEqual([]);
    expect(issuesAt(release({ meta: { notes: `note${RLO}` } }))).toContain('release.notes');
    expect(issuesAt(release({ meta: { reviewedBy: `Reviewer${ZWSP}` } }))).toContain('release.reviewedBy');
    expect(issuesAt(release({ meta: { title: 'Café' } }))).toContain('release.title');
  });

  it('requires a review no earlier than the publication, as a real date', () => {
    expect(issuesAt(release({ meta: { reviewedAt: '2026-05-31' } }))).toContain('release.reviewedAt');
    expect(issuesAt(release({ meta: { reviewedAt: 'not a date' } }))).toContain('release.reviewedAt');
    expect(issuesAt(release({ meta: { reviewedAt: '2026-06-01' } }))).toEqual([]);
  });

  it('quotes every factor per its family base unit', () => {
    expect(
      issuesAt(release({ factors: [factorRow({ normalizedUnit: 'MWh', factorUnit: 'kgCO2e/MWh' })] })),
    ).toContain('factors[0].normalizedUnit');
    expect(
      issuesAt(
        release({
          factors: [
            factorRow({
              category: 'Mobile Combustion',
              activityType: 'diesel',
              normalizedUnit: 'uk_gallons',
              factorUnit: 'kgCO2e/UK gal',
              calorificBasis: 'not_applicable',
            }),
          ],
        }),
      ),
    ).toContain('factors[0].normalizedUnit');
    expect(issuesAt(release({ factors: [factorRow({ factorUnit: 'tCO2/TJ' })] }))).toContain(
      'factors[0].factorUnit',
    );
  });

  it('reads a combustion factor per cubic metre as per STANDARD cubic metre', () => {
    expect(
      issuesAt(
        release({
          factors: [factorRow({ normalizedUnit: 'cubic_metres', factorUnit: 'kgCO2e/m³', calorificBasis: 'not_applicable' })],
        }),
      ),
    ).toContain('factors[0].normalizedUnit');
    // Water is no combustion: its meter volume is the activity itself.
    expect(
      issuesAt(
        release({
          meta: { status: 'placeholder' },
          factors: [
            factorRow({
              category: 'Water',
              activityType: 'water_supply',
              scope: 3,
              normalizedUnit: 'cubic_metres',
              factorUnit: 'kgCO2e/m³',
              calorificBasis: 'not_applicable',
            }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('states what a CO2e total covers, and only on the total', () => {
    expect(issuesAt(release({ factors: [factorRow({ gasCoverage: null })] }))).toContain(
      'factors[0].gasCoverage',
    );
    expect(
      issuesAt(release({ factors: [factorRow(), factorRow({ gas: 'CO2', gasCoverage: 'all_ghg', factorValue: 0.5 })] })),
    ).toContain('factors[1].gasCoverage');
    const refrigerant = {
      category: 'Refrigerants',
      activityType: 'R-410A',
      normalizedUnit: 'kg',
      factorUnit: 'kgCO2e/kg',
      calorificBasis: 'not_applicable',
    };
    expect(issuesAt(release({ factors: [factorRow({ ...refrigerant, gasCoverage: 'co2_only' })] }))).toContain(
      'factors[0].gasCoverage',
    );
    expect(
      issuesAt(
        release({
          factors: [factorRow(refrigerant), factorRow({ ...refrigerant, gas: 'CH4', gasCoverage: null, factorValue: 0.1 })],
        }),
      ),
    ).toContain('factors[1].gas');
  });

  it('keeps per-gas rows consistent with their total', () => {
    expect(
      issuesAt(release({ factors: [factorRow(), factorRow({ gas: 'CO2', gasCoverage: null, factorValue: 5 })] })),
    ).toContain('factors[1].gas');
    expect(
      issuesAt(
        release({
          factors: [
            factorRow({ gasCoverage: 'co2_only' }),
            factorRow({ gas: 'N2O', gasCoverage: null, factorValue: 0.1 }),
          ],
        }),
      ),
    ).toContain('factors[1].gas');
    // Biogenic CO2 sits outside the total and may exceed it.
    expect(
      issuesAt(release({ factors: [factorRow(), factorRow({ gas: 'CO2_biogenic', gasCoverage: null, factorValue: 5 })] })),
    ).toEqual([]);
  });

  it('needs no GWP set for a release that covers CO2 alone', () => {
    const grid = factorRow({
      category: 'Electricity',
      activityType: 'grid_electricity',
      scope: 2,
      scope2Method: 'location',
      calorificBasis: 'not_applicable',
      gasCoverage: 'co2_only',
    });
    expect(issuesAt(release({ meta: { gwpSet: null }, factors: [grid] }))).toEqual([]);
    expect(
      issuesAt(release({ meta: { gwpSet: null }, factors: [grid, factorRow()] })),
    ).toContain('release.gwpSet');
    // A CH4 or N2O row is GWP-weighted whatever its total claims.
    expect(
      issuesAt(
        release({
          meta: { gwpSet: null },
          factors: [factorRow({ gasCoverage: 'co2_only' }), factorRow({ gas: 'CH4', gasCoverage: null, factorValue: 0.1 })],
        }),
      ),
    ).toContain('release.gwpSet');
  });

  it('checks optional reference conditions on a step with no gas volume', () => {
    const density = {
      category: 'Mobile Combustion',
      activityType: 'cng',
      fromUnit: 'litres',
      toUnit: 'kg',
      calorificBasis: 'not_applicable',
    };
    expect(issuesAt(release({ conversions: [conversionRow({ ...density, referenceConditions: null })] }))).toEqual([]);
    expect(
      issuesAt(release({ conversions: [conversionRow({ ...density, referenceConditions: `15 °C${RLO}` })] })),
    ).toContain('conversions[0].referenceConditions');
  });

  it('pins a standard cubic metre to ISO 13443 on every step that touches one', () => {
    expect(STANDARD_REFERENCE_CONDITIONS).toBe('15 °C, 101.325 kPa (ISO 13443)');
    // A "normal" m³ at 0 °C is about 5.5% more gas: loaded as Sm³ it overstates.
    for (const over of [
      { fromUnit: 'standard_cubic_metres', referenceConditions: '0 °C, 101.325 kPa' },
      { toUnit: 'standard_cubic_metres', calorificBasis: 'not_applicable', referenceConditions: '0 °C, 101.325 kPa' },
    ]) {
      expect(issuesAt(release({ conversions: [conversionRow(over)] })), JSON.stringify(over)).toContain(
        'conversions[0].referenceConditions',
      );
    }
    // A metered → kWh step states its own conditions; nothing pins them.
    expect(issuesAt(release({ conversions: [conversionRow({ referenceConditions: '0 °C, 101.325 kPa' })] }))).toEqual([]);
  });

  it('keeps conversions between base units', () => {
    expect(
      issuesAt(release({ conversions: [conversionRow({ fromUnit: 'cubic_metres', toUnit: 'gj' })] })),
    ).toContain('conversions[0].toUnit');
    expect(
      issuesAt(release({ conversions: [conversionRow({ referenceConditions: `15 °C${RLO}` })] })),
    ).toContain('conversions[0].referenceConditions');
  });
});

describe('review round 1 — pinned tables (qa-auditor)', () => {
  it('bills fuel energy on the gross basis', () => {
    expect(BILLED_ENERGY_CALORIFIC_BASIS).toBe('gross');
  });

  it('pins every refusal status', () => {
    expect(CALCULATION_REFUSAL_STATUS).toEqual({
      unit_unknown: 400,
      unit_blocked: 400,
      unit_not_for_category: 400,
      activity_type_not_for_category: 400,
      activity_type_required: 400,
      no_factor: 404,
      placeholder_refused: 404,
      ambiguous_factor: 409,
      factor_scope_mismatch: 409,
      no_conversion: 404,
      calorific_basis_mismatch: 404,
    });
  });

  it('pins every unit to its family', () => {
    expect(Object.fromEntries(ACTIVITY_UNITS.map((u) => [u.value, u.dimension]))).toEqual({
      kWh: 'energy',
      MWh: 'energy',
      cubic_metres: 'metered_volume',
      standard_cubic_metres: 'standard_volume',
      therms: 'energy',
      gj: 'energy',
      litres: 'fuel_volume',
      uk_gallons: 'fuel_volume',
      us_gallons: 'fuel_volume',
      kilometres: 'distance',
      passenger_kilometres: 'passenger_distance',
      tonnes: 'mass',
      kg: 'mass',
    });
  });

  it('pins the storage tokens — they are never renamed', () => {
    expect(UNSPECIFIED_ACTIVITY_TYPE).toBe('unspecified');
    expect(
      Object.fromEntries(
        Object.entries(CATEGORY_ACTIVITY_TYPES).map(([category, spec]) => [
          category,
          { implicit: spec!.implicit, values: spec!.types.map((t) => t.value) },
        ]),
      ),
    ).toEqual({
      Electricity: { implicit: 'grid_electricity', values: ['grid_electricity'] },
      'Natural Gas': { implicit: 'natural_gas', values: ['natural_gas'] },
      Water: { implicit: 'water_supply', values: ['water_supply'] },
      Fuel: { implicit: undefined, values: ['diesel', 'gas_oil', 'fuel_oil', 'burning_oil', 'lpg'] },
      'Mobile Combustion': { implicit: undefined, values: ['diesel', 'petrol', 'lpg', 'cng'] },
      Refrigerants: {
        implicit: undefined,
        values: ['R-32', 'R-134a', 'R-404A', 'R-407C', 'R-407F', 'R-410A', 'R-448A', 'R-449A', 'R-1234yf'],
      },
    });
  });

  it('never accepts an empty activity type — it would be a second key for one meter', () => {
    expect(isRecordActivityTypeAllowed('Electricity', '')).toBe(false);
    expect(isRecordActivityTypeAllowed('Fuel', '')).toBe(false);
  });

  it('keys identity on values, not on a joined string that could collide', () => {
    const a = { ...Object.fromEntries(FACTOR_IDENTITY_FIELDS.map((f) => [f, 'x'])), activityType: 'a|b', gas: 'c' };
    const b = { ...a, activityType: 'a', gas: 'b|c' };
    expect(identityKey(a, FACTOR_IDENTITY_FIELDS)).not.toBe(identityKey(b, FACTOR_IDENTITY_FIELDS));
  });

  it('survives a very long candidate list', () => {
    const many = Array.from({ length: 300_000 }, (_, i) => ({
      release: { status: 'authoritative' as FactorStatus, ordinal: i + 1, publisher: 'P' },
    }));
    const pick = selectByRelease(many, { allowPlaceholders: false });
    expect(pick.ok && pick.selected.release.ordinal).toBe(300_000);
  });
});

describe('validateFactorReleaseImport — every rule has a negative and a positive case (qa-auditor)', () => {
  const clean = () => release({ conversions: [conversionRow()] });

  it('starts from a clean release', () => {
    expect(issuesAt(clean())).toEqual([]);
  });

  it('requires the release text, and real text', () => {
    for (const field of ['publisher', 'title', 'edition'] as const) {
      expect(issuesAt(release({ meta: { [field]: '' } })), field).toContain(`release.${field}`);
      expect(issuesAt(release({ meta: { [field]: '   ' } })), field).toContain(`release.${field}`);
    }
  });

  it('requires a full https URL and a full ISO date', () => {
    expect(issuesAt(release({ meta: { sourceUrl: 'https://' } }))).toContain('release.sourceUrl');
    // A user part makes the host the part after `@`; a backslash reads as a slash.
    for (const url of [
      'https://www.gov.uk@evil.example/x',
      'https://user:pw@www.gov.uk/x',
      'https://evil.example\\@www.gov.uk/x',
      'https://www.gov.uk\\x',
    ]) {
      expect(issuesAt(release({ meta: { sourceUrl: url } })), url).toContain('release.sourceUrl');
    }
    for (const url of ['https://www.gov.uk', 'https://www.gov.uk/x?y=1#z', 'https://example.invalid/@handle']) {
      expect(issuesAt(release({ meta: { sourceUrl: url } })), url).toEqual([]);
    }
    expect(issuesAt(release({ meta: { publishedAt: '2026-06' } }))).toContain('release.publishedAt');
  });

  it('checks formats on non-authoritative releases too, but asks them for no provenance', () => {
    const bare = { sourceUrl: null, licence: null, publishedAt: null, gwpSet: null, reviewedBy: null, reviewedAt: null };
    for (const status of ['placeholder', 'fixture']) {
      expect(issuesAt(release({ meta: { status, ...bare } })), status).toEqual([]);
      expect(issuesAt(release({ meta: { status, gwpSet: 'SAR' } })), status).toContain('release.gwpSet');
      expect(issuesAt(release({ meta: { status, publishedAt: '2026-13-01' } })), status).toContain(
        'release.publishedAt',
      );
    }
  });

  it('lets a fixture release carry the unspecified activity type', () => {
    expect(
      issuesAt(
        release({
          meta: { status: 'fixture' },
          factors: [
            factorRow({
              category: 'Fuel',
              activityType: UNSPECIFIED_ACTIVITY_TYPE,
              normalizedUnit: 'litres',
              factorUnit: 'kgCO2e/L',
              calorificBasis: 'not_applicable',
            }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('bounds the years: integers from 1990 to 2100', () => {
    for (const year of [1990, 2100]) {
      expect(issuesAt(release({ factors: [factorRow({ reportingYear: year, dataYear: year })] }))).toEqual([]);
    }
    for (const year of [1989, 2101, 2026.5]) {
      expect(issuesAt(release({ factors: [factorRow({ reportingYear: year })] })), String(year)).toContain(
        'factors[0].reportingYear',
      );
    }
  });

  it('accepts a zero factor and refuses an infinite one', () => {
    expect(issuesAt(release({ factors: [factorRow({ factorValue: 0 })] }))).toEqual([]);
    expect(issuesAt(release({ factors: [factorRow({ factorValue: Infinity })] }))).toContain(
      'factors[0].factorValue',
    );
  });

  it('requires each row’s text fields', () => {
    for (const field of ['methodology', 'source', 'factorUnit'] as const) {
      expect(issuesAt(release({ factors: [factorRow({ [field]: '' })] })), field).toContain(`factors[0].${field}`);
    }
  });

  it('loads a market-based Scope 2 row, which is stored though never resolved', () => {
    expect(
      issuesAt(
        release({
          factors: [
            factorRow({
              category: 'Electricity',
              activityType: 'grid_electricity',
              scope: 2,
              scope2Method: 'market',
              calorificBasis: 'not_applicable',
            }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('refuses any factor of a category with no unit contract', () => {
    expect(
      issuesAt(
        release({
          meta: { status: 'fixture' },
          factors: [
            factorRow({
              category: 'Waste',
              activityType: UNSPECIFIED_ACTIVITY_TYPE,
              scope: 3,
              normalizedUnit: 'kg',
              factorUnit: 'kgCO2e/kg',
              calorificBasis: 'not_applicable',
            }),
          ],
        }),
      ),
    ).toContain('factors[0].normalizedUnit');
  });

  it('groups a per-gas row with its own total only', () => {
    const perGas = { gas: 'CH4', gasCoverage: null, factorValue: 0.1 };
    expect(issuesAt(release({ factors: [factorRow(), factorRow(perGas)] }))).toEqual([]);
    for (const other of [
      { geographyCode: 'TR' },
      { reportingYear: 2025, dataYear: 2025 },
      { calorificBasis: 'net' },
      { normalizedUnit: 'standard_cubic_metres', factorUnit: 'kgCO2e/Sm³', calorificBasis: 'not_applicable' },
    ]) {
      expect(
        issuesAt(release({ factors: [factorRow(), factorRow({ ...perGas, ...other })] })),
        JSON.stringify(other),
      ).toContain('factors[1].gas');
    }
  });

  it('groups by unit alone when nothing else differs', () => {
    const mobile = {
      category: 'Mobile Combustion',
      activityType: 'diesel',
      calorificBasis: 'not_applicable',
    };
    const perLitre = factorRow({ ...mobile, normalizedUnit: 'litres', factorUnit: 'kgCO2e/L' });
    const ch4PerKg = factorRow({
      ...mobile,
      normalizedUnit: 'kg',
      factorUnit: 'kgCO2e/kg',
      gas: 'CH4',
      gasCoverage: null,
      factorValue: 0.1,
    });
    expect(issuesAt(release({ factors: [perLitre, ch4PerKg] }))).toContain('factors[1].gas');
  });

  it('checks every conversion rule', () => {
    const cases: [Partial<UnitConversionImportRow>, string][] = [
      [{ activityType: 'diesel' }, 'activityType'],
      [{ geographyCode: 'FR' }, 'geographyCode'],
      [{ dataYear: 2027 }, 'dataYear'],
      [{ reportingYear: 1989 }, 'reportingYear'],
      [{ category: 'Electricity', activityType: 'grid_electricity' }, 'fromUnit'],
      [{ multiplier: Infinity }, 'multiplier'],
      [{ multiplier: -1 }, 'multiplier'],
      [{ basis: '' }, 'basis'],
      [{ fromUnit: 'kWh', toUnit: 'cubic_metres', calorificBasis: 'not_applicable' }, 'calorificBasis'],
      [{ toUnit: 'standard_cubic_metres', calorificBasis: 'gross' }, 'calorificBasis'],
      [{ fromUnit: 'standard_cubic_metres', referenceConditions: null }, 'referenceConditions'],
    ];
    for (const [over, field] of cases) {
      expect(issuesAt(release({ conversions: [conversionRow(over)] })), JSON.stringify(over)).toContain(
        `conversions[0].${field}`,
      );
    }
    // The positive controls for the two that are allowed.
    expect(
      issuesAt(
        release({
          conversions: [
            conversionRow({
              toUnit: 'standard_cubic_metres',
              calorificBasis: 'not_applicable',
              referenceConditions: STANDARD_REFERENCE_CONDITIONS,
            }),
            conversionRow({ fromUnit: 'standard_cubic_metres', referenceConditions: STANDARD_REFERENCE_CONDITIONS }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('keys duplicate conversions on basis and geography too', () => {
    expect(
      issuesAt(release({ conversions: [conversionRow(), conversionRow({ calorificBasis: 'net' })] })),
    ).toEqual([]);
    expect(
      issuesAt(release({ conversions: [conversionRow(), conversionRow({ geographyCode: 'TR' })] })),
    ).toEqual([]);
  });
});
