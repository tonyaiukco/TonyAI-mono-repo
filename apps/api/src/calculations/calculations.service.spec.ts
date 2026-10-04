import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CalculationInputError, FactorLibraryConflictError, NoEmissionFactorError } from './errors';
import type { EmissionFactor, FactorRelease, UnitConversion } from '@tonyai/db';
import {
  ACTIVITY_UNITS,
  DIMENSION_BASE_UNIT,
  directCalorificBasisFor,
  factorActivityTypeFor,
  isAuthoritativeSnapshot,
  isCalculated,
  isProvenanceSnapshot,
  scope2MethodFor,
  unitDimensionOf,
  type ActivityCalculationSnapshot,
  type CalculationResult,
  type CalculationResultV2,
  type UncalculatedSnapshot,
} from '@tonyai/shared-types';
import { CalculationsService, FACTOR_CANDIDATE_CAP } from './calculations.service';
import { CALLER_TEXT_QUOTE_MAX_LENGTH } from '../common/caller-text';
import { PrismaService } from '../prisma/prisma.service';
import {
  blockedUnitReason,
  canonicalUnit,
  isKnownUnit,
  normalize,
  UNIT_ALIAS_SPELLINGS,
} from './normalization';

/**
 * Assert the snapshot carries a real figure, and narrow to it.
 *
 * Deliberately an assertion rather than a cast: `as CalculationResult` would
 * compile against the uncalculated shape too, so a regression that silently
 * stopped calculating Electricity would keep every one of these specs green
 * while every `expect(...).toBeCloseTo` compared `undefined` to a number.
 */
function expectCalculated(
  snapshot: ActivityCalculationSnapshot,
): CalculationResult {
  expect(isCalculated(snapshot)).toBe(true);
  return snapshot as CalculationResult;
}

// Local Prisma mock: a fake factor library behind the two queries the service
// makes. No DB. `findMany` applies the service's `where` the way SQL would —
// exact equality per column, the release status by its IN list — so a spec
// can show that a row of another year, geography, gas or status is never a
// candidate, not merely that the resolver would discard it.
type FactorRow = EmissionFactor & { release: FactorRelease };
type ConversionRow = UnitConversion & { release: FactorRelease };

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, wanted]) => {
    if (key === 'release') {
      const statuses = (wanted as { status: { in: string[] } }).status.in;
      return statuses.includes((row.release as FactorRelease).status);
    }
    return row[key] === wanted;
  });
}

function createFactorPrismaMock() {
  const library = { factors: [] as FactorRow[], conversions: [] as ConversionRow[] };
  return {
    library,
    emissionFactor: {
      findMany: vi.fn(async (args: { where: Record<string, unknown>; take?: number }) =>
        library.factors.filter((f) => matchesWhere(f, args.where)).slice(0, args.take),
      ),
    },
    unitConversion: {
      findMany: vi.fn(async (args: { where: Record<string, unknown>; take?: number }) =>
        library.conversions.filter((c) => matchesWhere(c, args.where)).slice(0, args.take),
      ),
    },
  };
}
type FactorPrismaMock = ReturnType<typeof createFactorPrismaMock>;

/** Load exactly these factors (none for null) into the fake library. */
function useFactor(prisma: FactorPrismaMock, ...factors: (FactorRow | null)[]) {
  prisma.library.factors = factors.filter((f): f is FactorRow => f !== null);
}

let seq = 0;
function makeRelease(overrides: Partial<FactorRelease> = {}): FactorRelease {
  seq += 1;
  return {
    id: `release-${seq}`,
    publisher: 'TonyAI prototype',
    title: 'Prototype demo emission factors',
    edition: '2024.1',
    ordinal: 202401,
    status: 'placeholder',
    sourceUrl: null,
    licence: null,
    publishedAt: null,
    gwpSet: null,
    reviewedBy: null,
    reviewedAt: null,
    notes: null,
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawalReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as FactorRelease;
}

function makeFactor(overrides: Partial<FactorRow> = {}): FactorRow {
  seq += 1;
  const now = new Date('2026-01-01T00:00:00.000Z');
  const category = overrides.category ?? 'Electricity';
  const normalizedUnit = overrides.normalizedUnit ?? 'kWh';
  const reportingYear = overrides.reportingYear ?? 2024;
  const release = overrides.release ?? makeRelease();
  return {
    id: `factor-${seq}`,
    category,
    activityType: factorActivityTypeFor(category, null),
    gas: 'CO2e',
    gasCoverage: 'all_ghg',
    geographyCode: 'TR',
    reportingYear,
    dataYear: reportingYear,
    scope: 2,
    scope2Method: scope2MethodFor(category),
    calorificBasis: directCalorificBasisFor(category, normalizedUnit),
    factorValue: 0.44,
    factorUnit: 'kgCO2e/kWh',
    normalizedUnit,
    methodology: 'location-based',
    source: 'calculation_logic.md §3',
    version: release.edition,
    createdAt: now,
    updatedAt: now,
    ...overrides,
    releaseId: release.id,
    release,
  } as FactorRow;
}

function makeConversion(overrides: Partial<ConversionRow> = {}): ConversionRow {
  seq += 1;
  const release = overrides.release ?? makeRelease();
  return {
    id: `conversion-${seq}`,
    category: 'Natural Gas',
    activityType: 'natural_gas',
    geographyCode: 'TR',
    reportingYear: 2024,
    dataYear: 2024,
    fromUnit: 'cubic_metres',
    toUnit: 'kWh',
    multiplier: 11.36,
    calorificBasis: 'gross',
    referenceConditions: null,
    basis: 'calculation_logic.md §2.1 prototype assumption, NOT a sourced factor.',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
    releaseId: release.id,
    release,
  } as ConversionRow;
}

const ALLOW_PLACEHOLDERS = Object.freeze({ allowPlaceholders: true });

/** A category for `normalize` calls that apply no conversion — it only
 *  matters when a sourced conversion is passed. */
const ANY_CATEGORY = 'Electricity';

describe('normalize (calculation_logic.md §2)', () => {
  it('passes a refrigerant mass (kg) through unchanged (LP3-03)', () => {
    // A refrigerant factor is quoted per kg of gas; any multiplier here would
    // scale every leakage figure by it.
    expect(normalize(5, 'kg', ANY_CATEGORY, null)).toEqual({
      normalizedValue: 5,
      normalizedUnit: 'kg',
      conversionApplied: false,
    });
  });

  it("normalises every calculable vocabulary unit to its family's base unit — never to the legacy target (LP3-03)", () => {
    // Before LP3-03 this pinned each unit's legacy `target`, so metered m³
    // became kWh in code. A unit now reaches only its own family's base unit
    // (`DIMENSION_BASE_UNIT`) by definition; anything further is a sourced
    // conversion row.
    for (const unit of ACTIVITY_UNITS) {
      if (unit.blocked) continue;
      const base = DIMENSION_BASE_UNIT[unitDimensionOf(unit.value)!];
      expect(normalize(1, unit.value, ANY_CATEGORY, null).normalizedUnit, unit.value).toBe(base);
    }
  });

  it('passes through the electricity base unit (kWh) with no conversion', () => {
    expect(normalize(1000, 'kWh', ANY_CATEGORY, null)).toEqual({
      normalizedValue: 1000,
      normalizedUnit: 'kWh',
      conversionApplied: false,
    });
  });

  it('converts electricity MWh -> kWh (×1000)', () => {
    const r = normalize(5, 'mwh', ANY_CATEGORY, null);
    expect(r.normalizedValue).toBe(5000);
    expect(r.normalizedUnit).toBe('kWh');
    expect(r.conversionApplied).toBe(true);
  });

  it('keeps metered m³ as m³ — the m³ → kWh step is a sourced conversion row, never code (K4)', () => {
    // Until LP3-03 every cubic metre became kWh at 11.36, a water meter's
    // included. Without a conversion the reading stays the volume it is.
    for (const category of ['Natural Gas', 'Water']) {
      expect(normalize(100, 'cubic_metres', category, null)).toEqual({
        normalizedValue: 100,
        normalizedUnit: 'cubic_metres',
        conversionApplied: false,
      });
    }
  });

  it('applies the sourced conversion the resolver chose, and records it', () => {
    const conversion = { category: 'Natural Gas', fromUnit: 'cubic_metres', toUnit: 'kWh', multiplier: 11.36, basis: 'the basis' };
    expect(normalize(100, 'cubic_metres', 'Natural Gas', conversion)).toEqual({
      normalizedValue: 1136,
      normalizedUnit: 'kWh',
      conversionApplied: true,
      conversionFactor: 11.36,
      conversionBasis: 'the basis',
    });
  });

  it("refuses a conversion of another category, or one that does not start at the unit's base", () => {
    const gas = { category: 'Natural Gas', fromUnit: 'cubic_metres', toUnit: 'kWh', multiplier: 11.36, basis: 'b' };
    // A Natural Gas calorific value can never price a Water reading.
    expect(() => normalize(100, 'cubic_metres', 'Water', gas)).toThrow(/Natural Gas conversion cannot price a Water record/);
    expect(() => normalize(100, 'kWh', 'Natural Gas', gas)).toThrow(/conversion from cubic_metres cannot follow/);
  });

  it('accepts the m³ alias for cubic_metres', () => {
    expect(normalize(100, 'm³', ANY_CATEGORY, null)).toMatchObject({ normalizedValue: 100, normalizedUnit: 'cubic_metres' });
  });

  it('accepts kWh written with a space — "kW h"', () => {
    // Regression: the alias was declared `'kw h'`, but the lookup only ever asks
    // for the whitespace-collapsed form (`kw_h`). The entry was unreachable, so
    // a user typing `kW h` had an ordinary spelling of kWh refused outright as
    // a unit the system does not understand.
    expect(isKnownUnit('kW h')).toBe(true);
    expect(normalize(1000, 'kW h', ANY_CATEGORY, null)).toEqual({
      normalizedValue: 1000,
      normalizedUnit: 'kWh',
      conversionApplied: false,
    });
  });

  it('resolves spacing and casing variants of kWh onto one canonical unit', () => {
    for (const spelling of ['kW h', 'KW  H', ' kWh ', 'kwh']) {
      expect(canonicalUnit(spelling)).toBe('kwh');
    }
  });

  it('accepts every alias spelling the table declares', () => {
    // The table is written in human spellings while the lookup is keyed by the
    // canonical form, so a spelling can survive declaration and still never
    // match — failing only when a real user types it. Assert the whole table
    // rather than the single entry that happened to be caught, which also
    // catches an alias pointing at a rule key that does not exist.
    const unreachable = Object.keys(UNIT_ALIAS_SPELLINGS).filter(
      (spelling) => !isKnownUnit(spelling),
    );
    expect(unreachable).toEqual([]);
  });

  it('resolves every alias spelling to the rule key it declares', () => {
    // Deriving the keys trades one silent failure for another: two spellings
    // that clean to the SAME key now overwrite each other, last declaration
    // wins, and TypeScript cannot see it (literal duplicate keys are an error;
    // `'uk gallon'` shadowing `uk_gallon` is not). Both stay *known*, so the
    // reachability check above passes. Only comparing each spelling against
    // the rule key it declared catches the shadowed one — and the damage is a
    // wrong figure, not a refusal: `'uk gallon': 'us_gallons'` silently prices
    // UK gallons 20% light.
    //
    // Scope, precisely: this catches a spelling SHADOWED by another, and the
    // check above catches a spelling that resolves nowhere. Neither can catch
    // a lone MIS-declared alias (`'sm³': 'cubic_metres'`), because both read
    // the same declaration they are checking — that needs the independent
    // oracle in the blocked-unit case below.
    const misresolved = Object.entries(UNIT_ALIAS_SPELLINGS).filter(
      ([spelling, ruleKey]) => canonicalUnit(spelling) !== ruleKey,
    );
    expect(misresolved).toEqual([]);
  });

  it('resolves each alias spelled with spaces, as a user would type it', () => {
    // The whole bug was a spelling written with a space never reaching the
    // lookup, yet nearly every declared key is already underscored — so the
    // checks above would still pass if `cleanUnitToken` DELETED whitespace
    // instead of collapsing it to `_`, and `standard cubic metres` would break
    // with the suite green. Retyping each key the human way exercises the
    // cleaning step itself rather than the table.
    const broken = Object.entries(UNIT_ALIAS_SPELLINGS).filter(
      ([spelling, ruleKey]) =>
        canonicalUnit(spelling.replace(/_/g, ' ')) !== ruleKey,
    );
    expect(broken).toEqual([]);
  });

  // An INDEPENDENT oracle: this list is written out by hand, not derived from
  // UNIT_ALIAS_SPELLINGS, which is the entire point. The table-driven checks
  // above compare the table against itself, so re-pointing a single blocked
  // spelling (`'sm³': 'cubic_metres'`) satisfies both while handing Sm³ the
  // ×11.36 natural-gas multiplier — 1000 Sm³ booked as 11,360 kWh. Sm³ and Nm³
  // are refused BY NAME because this repo holds no sourced calorific value for
  // them (see normalization.ts), and a fabricated figure in an emissions
  // inventory is the failure this product cannot have. Every spelling that
  // reaches a blocked unit is pinned, not just the one someone remembered.
  it.each([
    'Sm3',
    'sm3',
    'sm³',
    'SM³',
    'scm',
    'standard_cubic_metre',
    'standard_cubic_metres',
    'standard cubic metres',
    'Nm3',
    'nm3',
    'nm³',
    'normal_cubic_metre',
    'normal_cubic_metres',
    'normal cubic metres',
  ])('refuses %s rather than converting it', (spelling) => {
    expect(isKnownUnit(spelling)).toBe(true);
    expect(blockedUnitReason(spelling)).not.toBeNull();
    expect(() => normalize(1000, spelling, ANY_CATEGORY, null)).toThrow(/sourced calorific value/i);
  });

  it('uses the exact definitional constants, not rounded ones (LP3-03)', () => {
    // The UK statutory therm as an exact quotient — 29.30711 to seven figures.
    expect(normalize(1, 'therms', ANY_CATEGORY, null)).toMatchObject({ normalizedUnit: 'kWh', conversionFactor: 105_505_585.257348 / 3_600_000 });
    expect(normalize(1, 'therms', ANY_CATEGORY, null).conversionFactor).toBeCloseTo(29.30711, 5);
    expect(normalize(1, 'therms', ANY_CATEGORY, null).conversionBasis).toMatch(/UK statutory/);
    expect(normalize(1, 'us_gallons', ANY_CATEGORY, null)).toMatchObject({ normalizedUnit: 'litres', conversionFactor: 3.785411784 });
    expect(normalize(1, 'uk_gallons', ANY_CATEGORY, null)).toMatchObject({ normalizedUnit: 'litres', conversionFactor: 4.54609 });
    expect(normalize(3.6, 'gj', ANY_CATEGORY, null).normalizedValue).toBeCloseTo(1000, 9);
  });

  it('turns tonnes into kg (×1000) — a factor is quoted per kg (LP3-03)', () => {
    expect(normalize(12, 'tonnes', ANY_CATEGORY, null)).toMatchObject({
      normalizedValue: 12000,
      normalizedUnit: 'kg',
      conversionApplied: true,
      conversionFactor: 1000,
    });
  });

  it('converts liquid fuel uk_gallons -> litres (×4.54609)', () => {
    const r = normalize(10, 'uk_gallons', ANY_CATEGORY, null);
    expect(r.normalizedValue).toBeCloseTo(45.4609, 9);
    expect(r.normalizedUnit).toBe('litres');
    expect(r.conversionApplied).toBe(true);
  });

  it('throws for an unsupported unit', () => {
    expect(() => normalize(1, 'bananas', ANY_CATEGORY, null)).toThrow(/Unsupported unit/);
  });

  it('knows Sm³ but refuses to convert it', () => {
    // Recognised, so the DTO accepts it and the refusal can explain itself —
    // "unsupported unit" would send the user looking for a spelling mistake.
    expect(isKnownUnit('Sm3')).toBe(true);
    expect(() => normalize(1, 'Sm3', ANY_CATEGORY, null)).toThrow(/sourced calorific value/i);
    expect(() => normalize(1, 'Nm³', ANY_CATEGORY, null)).toThrow(/sourced calorific value/i);
  });
});

describe('CalculationsService.compute', () => {
  let prisma: FactorPrismaMock;
  let service: CalculationsService;

  beforeEach(() => {
    prisma = createFactorPrismaMock();
    service = new CalculationsService(prisma as unknown as PrismaService, ALLOW_PLACEHOLDERS);
  });

  it('known input -> known output: 45000 kWh electricity TR 2024 = 19.8 tCO2e', async () => {
    useFactor(prisma, 
      makeFactor({ geographyCode: 'TR', factorValue: 0.44, reportingYear: 2024 }),
    );

    const result = expectCalculated(await service.compute({
      category: 'Electricity',
      geographyCode: 'TR',
      reportingYear: 2024,
      value: 45000,
      unit: 'kWh',
    }));

    expect(result.kgCo2e).toBeCloseTo(19800, 6);
    expect(result.tCo2e).toBeCloseTo(19.8, 6);
    expect(result.normalizedValue).toBe(45000);
    expect(result.conversionApplied).toBe(false);
  });

  it('doc worked example: 5 MWh electricity TR = 2.20 tCO2e (normalizes MWh->kWh)', async () => {
    useFactor(prisma, 
      makeFactor({ geographyCode: 'TR', factorValue: 0.44 }),
    );

    const result = expectCalculated(await service.compute({
      category: 'Electricity',
      geographyCode: 'TR',
      reportingYear: 2024,
      value: 5,
      unit: 'mwh',
    }));

    expect(result.normalizedValue).toBe(5000);
    expect(result.kgCo2e).toBeCloseTo(2200, 6);
    expect(result.tCo2e).toBeCloseTo(2.2, 6);
    expect(result.conversionApplied).toBe(true);
  });

  it('returns the factor snapshot for traceability', async () => {
    const factor = makeFactor({
      id: 'factor-snap',
      factorValue: 0.44,
      factorUnit: 'kgCO2e/kWh',
      methodology: 'location-based',
      source: 'DEFRA demo',
      version: '2024.1',
    });
    useFactor(prisma, factor);

    const result = expectCalculated(await service.compute({
      category: 'Electricity',
      geographyCode: 'TR',
      reportingYear: 2024,
      value: 100,
      unit: 'kWh',
    }));

    expect(result.factorId).toBe('factor-snap');
    expect(result.factorValue).toBe(0.44);
    expect(result.factorUnit).toBe('kgCO2e/kWh');
    expect(result.methodology).toBe('location-based');
    expect(result.version).toBe('2024.1');
    expect(result.geographyCode).toBe('TR');
    expect(result.scope).toBe(2);
  });

  it('factor versioning: resolves the requested year (2023 factor differs from 2024)', async () => {
    // The library holds both years; the 2023 lookup must see only 2023's.
    useFactor(
      prisma,
      makeFactor({ reportingYear: 2023, factorValue: 0.2123, geographyCode: 'UK', release: makeRelease({ edition: '2023.1', ordinal: 202301 }) }),
      makeFactor({ reportingYear: 2024, factorValue: 0.4, geographyCode: 'UK', release: makeRelease({ edition: '2024.1', ordinal: 202401 }) }),
    );

    const result = expectCalculated(await service.compute({
      category: 'Electricity',
      geographyCode: 'UK',
      reportingYear: 2023,
      value: 1000,
      unit: 'kWh',
    }));

    // The lookup is exact on every key, in SQL: category, activity type,
    // geography, year, the CO2e row of the category's own Scope 2 method, and
    // a live release — never a "latest version" ordering.
    expect(prisma.emissionFactor.findMany).toHaveBeenCalledWith({
      where: {
        category: 'Electricity',
        activityType: 'grid_electricity',
        geographyCode: 'UK',
        reportingYear: 2023,
        release: { status: { in: ['authoritative', 'placeholder', 'fixture'] } },
        gas: 'CO2e',
        scope2Method: 'location',
      },
      include: { release: true },
      orderBy: { id: 'asc' },
      take: FACTOR_CANDIDATE_CAP + 1,
    });
    expect(result.factorValue).toBe(0.2123);
    expect(result.version).toBe('2023.1');
    expect(result.kgCo2e).toBeCloseTo(212.3, 6);
  });

  it('natural gas m³ -> kWh through the sourced conversion row, then applies the Scope 1 factor', async () => {
    useFactor(prisma,
      makeFactor({
        category: 'Natural Gas',
        scope: 1,
        factorValue: 0.1829,
        geographyCode: 'UK',
      }),
    );
    prisma.library.conversions = [makeConversion({ geographyCode: 'UK' })];

    const result = expectCalculated(await service.compute({
      category: 'Natural Gas',
      geographyCode: 'UK',
      reportingYear: 2024,
      value: 100,
      unit: 'cubic_metres',
    }));

    // 100 m³ × 11.36 = 1136 kWh ; × 0.1829 = 207.7744 kgCO2e
    expect(result.normalizedValue).toBeCloseTo(1136, 6);
    expect(result.kgCo2e).toBeCloseTo(207.7744, 4);
    expect(result.scope).toBe(1);
    // The v2 snapshot names the conversion row and its release.
    const v2 = result as CalculationResultV2;
    expect(v2.conversion).toMatchObject({ fromUnit: 'cubic_metres', toUnit: 'kWh', multiplier: 11.36, calorificBasis: 'gross' });
    expect(v2.conversion?.release.status).toBe('placeholder');
    expect(v2.calorificBasis).toBe('gross');
  });

  it("never applies another country's or another year's conversion", async () => {
    // Only the exact (category, activity, geography, year) conversion is a
    // candidate: a loose match would price a TR bill at the UK's calorific
    // value. A UK 2024 factor with a TR conversion and a UK 2023 one is a
    // factor with no conversion.
    useFactor(prisma, makeFactor({ category: 'Natural Gas', scope: 1, geographyCode: 'UK' }));
    prisma.library.conversions = [
      makeConversion({ geographyCode: 'TR' }),
      makeConversion({ geographyCode: 'UK', reportingYear: 2023, dataYear: 2023 }),
    ];
    await expect(
      service.compute({ category: 'Natural Gas', geographyCode: 'UK', reportingYear: 2024, value: 100, unit: 'cubic_metres' }),
    ).rejects.toMatchObject({ code: 'no_conversion' });
  });

  it('refuses Sm³ by name, saying what is missing', async () => {
    // Sm³ and m³ are different physical quantities and this repo holds no
    // sourced calorific value for the first. Registering it with the m³
    // multiplier would produce a number nobody could defend, so it is
    // recognised and refused — and the message must say why, or a tester reads
    // it as "unsupported unit" and simply reaches for m³ instead.
    await expect(
      service.compute({
        category: 'Natural Gas',
        geographyCode: 'UK',
        reportingYear: 2026,
        value: 100,
        unit: 'Sm3',
      }),
    ).rejects.toThrow(/sourced calorific value/i);
    expect(prisma.emissionFactor.findMany).not.toHaveBeenCalled();
  });

  it('records WHICH conversion was applied, not just that one was', async () => {
    // `conversionApplied` is a boolean; an auditor asking what multiplier was
    // used had to divide normalizedValue by the input to find out.
    useFactor(prisma,
      makeFactor({
        category: 'Natural Gas',
        normalizedUnit: 'kWh',
        factorValue: 0.1829,
        scope: 1,
        geographyCode: 'UK',
        reportingYear: 2026,
      }),
    );
    prisma.library.conversions = [makeConversion({ geographyCode: 'UK', reportingYear: 2026, dataYear: 2026 })];

    const result = expectCalculated(await service.compute({
      category: 'Natural Gas',
      geographyCode: 'UK',
      reportingYear: 2026,
      value: 100,
      unit: 'cubic_metres',
    }));

    expect(result.conversionApplied).toBe(true);
    expect(result.conversionFactor).toBe(11.36);
    expect(result.conversionBasis).toMatch(/NOT a sourced factor/i);
  });

  it('leaves the conversion fields off when nothing was converted', async () => {
    useFactor(prisma,
      makeFactor({ normalizedUnit: 'kWh', geographyCode: 'UK', reportingYear: 2026 }),
    );

    const result = expectCalculated(await service.compute({
      category: 'Electricity',
      geographyCode: 'UK',
      reportingYear: 2026,
      value: 10,
      unit: 'kWh',
    }));

    expect(result.conversionApplied).toBe(false);
    expect(result.conversionFactor).toBeUndefined();
    expect(result.conversionBasis).toBeUndefined();
  });

  it('rejects a unit that is wrong for the category but right for the family', async () => {
    // The pre-existing guard only compares unit FAMILIES, so `therms` on
    // Electricity normalised to kWh, matched the factor and produced a
    // plausible number with no error at all.
    await expect(
      service.compute({
        category: 'Electricity',
        geographyCode: 'UK',
        reportingYear: 2026,
        value: 100,
        unit: 'therms',
      }),
    ).rejects.toThrow(/not valid for "Electricity"/);
    expect(prisma.emissionFactor.findMany).not.toHaveBeenCalled();
  });

  it('throws NotFound when no factor exists for the key', async () => {
    useFactor(prisma, null);

    await expect(
      service.compute({
        category: 'Electricity',
        geographyCode: 'ZZ',
        reportingYear: 2024,
        value: 1,
        unit: 'kWh',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // The CLASS the bulk importer tells a coverage miss from an access
    // problem by — never the words "emission factor".
    await expect(
      service.compute({
        category: 'Electricity',
        geographyCode: 'ZZ',
        reportingYear: 2024,
        value: 1,
        unit: 'kWh',
      }),
    ).rejects.toBeInstanceOf(NoEmissionFactorError);
  });

  /**
   * The refusal names the two values it could not find, and `compute` is a
   * public method. `CalculationInputDto` now bounds the preview endpoint to the
   * two vocabularies, but it is not the only caller: `ActivityRecordsService`
   * passes a geography read from a subsidiary or location row, and
   * `geographyOptions` in @tonyai/shared-types explicitly anticipates "a code
   * that reached the database by some other route". The DTO bounds the door;
   * these two bound the sentence.
   */
  it('quotes the category and geography it could not find, rather than echoing them', async () => {
    useFactor(prisma, null);

    const message = await service
      .compute({
        category: 'E'.repeat(200),
        geographyCode: 'Z'.repeat(200),
        reportingYear: 2024,
        value: 1,
        unit: 'kWh',
      })
      .then(
        () => 'it resolved, which would itself be the bug',
        (error: Error) => error.message,
      );

    expect(message).toContain(
      `category "${'E'.repeat(CALLER_TEXT_QUOTE_MAX_LENGTH)}…"`,
    );
    expect(message).toContain(
      `geography "${'Z'.repeat(CALLER_TEXT_QUOTE_MAX_LENGTH)}…"`,
    );
    // 400 characters in, well under 200 out: the sentence can no longer be
    // multiplied by the length of what it is asked to name.
    expect(message.length).toBeLessThan(200);
  });

  it('names the characters that disguise a value in that sentence', async () => {
    useFactor(prisma, null);

    // Built from code points rather than written literally: a literal would be
    // a real invisible character sitting in this file. U+202E is the
    // right-to-left override, U+200B the zero-width space. Neither survives
    // into the sentence, and neither vanishes from it either — a refusal that
    // cannot show a character says which one it was.
    const override = String.fromCharCode(0x202e);
    const zeroWidth = String.fromCharCode(0x200b);

    const message = await service
      .compute({
        category: `Electricity${override}`,
        geographyCode: `U${zeroWidth}K`,
        reportingYear: 2024,
        value: 1,
        unit: 'kWh',
      })
      .then(
        () => 'it resolved, which would itself be the bug',
        (error: Error) => error.message,
      );

    expect(message).toContain('category "Electricity<U+202E>"');
    expect(message).toContain('geography "U<U+200B>K"');
    expect(message).not.toContain(override);
    expect(message).not.toContain(zeroWidth);
  });

  describe('a category with no factor at all (WP17 — Water)', () => {
    it('records the entry instead of refusing, and says why in the snapshot', async () => {
      useFactor(prisma, null);

      const result = await service.compute({
        category: 'Water',
        geographyCode: 'TR',
        reportingYear: 2026,
        value: 100,
        unit: 'cubic_metres',
      });

      expect(isCalculated(result)).toBe(false);
      const uncalculated = result as UncalculatedSnapshot;
      expect(uncalculated.reasonCode).toBe('no_emission_factor');
      expect(uncalculated.reason).toMatch(/no emission factor/i);
      // Scope still comes from the canonical map, so the record files itself
      // under Scope 3 rather than defaulting to 0.
      expect(uncalculated.scope).toBe(3);
      expect(uncalculated.inputValue).toBe(100);
      expect(uncalculated.inputUnit).toBe('cubic_metres');
    });

    it('does NOT normalise — 100 m³ of water must not become 1,136 kWh', async () => {
      useFactor(prisma, null);

      const result = (await service.compute({
        category: 'Water',
        geographyCode: 'TR',
        reportingYear: 2026,
        value: 100,
        unit: 'cubic_metres',
      })) as UncalculatedSnapshot & { normalizedValue?: number };

      // The guard that mattered before LP3-03, when normalize() converted any
      // cubic_metres at the NATURAL GAS calorific value (×11.36): the
      // factorless snapshot freezes the reading exactly as entered.
      expect(result.normalizedValue).toBeUndefined();
      expect('normalizedUnit' in result).toBe(false);
      // And normalize() itself no longer turns water into kWh (T8 flip).
      expect(normalize(100, 'cubic_metres', 'Water', null)).toMatchObject({
        normalizedValue: 100,
        normalizedUnit: 'cubic_metres',
      });
    });

    it('carries no figure and no factor, so nothing can read it as zero', async () => {
      useFactor(prisma, null);

      const result = (await service.compute({
        category: 'Water',
        geographyCode: 'UK',
        reportingYear: 2026,
        value: 42,
        unit: 'cubic_metres',
      })) as UncalculatedSnapshot & { tCo2e?: number; factorId?: string };

      expect(result.tCo2e).toBeUndefined();
      expect(result.factorId).toBeUndefined();
      // Every consumer sums with a finite check, so an absent figure drops out
      // of totals rather than deflating them.
      expect(Number.isFinite(result.tCo2e)).toBe(false);
    });

    it('the exception stops firing the moment a factor resolves — a water factor per m³ now applies (T8 flip)', async () => {
      // The safe seeding: a water factor is quoted per cubic metre. Before
      // LP3-03 it could not be applied — normalize() turned every cubic metre
      // into "kWh" at the natural-gas calorific value and the unit guard
      // refused it. With the category-aware engine the reading stays in m³ and
      // the factor prices it; the allow-list is a permission, not an
      // assertion.
      useFactor(prisma,
        makeFactor({
          category: 'Water',
          scope: 3,
          factorValue: 0.149,
          factorUnit: 'kgCO2e/m3',
          normalizedUnit: 'cubic_metres',
          geographyCode: 'UK',
          reportingYear: 2026,
        }),
      );

      const result = expectCalculated(await service.compute({
        category: 'Water',
        geographyCode: 'UK',
        reportingYear: 2026,
        value: 100,
        unit: 'cubic_metres',
      }));

      expect(result.normalizedUnit).toBe('cubic_metres');
      expect(result.normalizedValue).toBe(100);
      expect(result.kgCo2e).toBeCloseTo(14.9, 9);
    });

    it('a water factor quoted per kWh is no path for a reading in m³ — refused, never converted at the gas calorific value', async () => {
      useFactor(prisma,
        makeFactor({
          category: 'Water',
          scope: 3,
          factorValue: 0.149,
          normalizedUnit: 'kWh',
          geographyCode: 'UK',
          reportingYear: 2026,
        }),
      );

      // Not the factorless snapshot either: a factor exists, so the gap is a
      // missing conversion row, which is a 404 to fix, not a category without
      // a methodology.
      await expect(
        service.compute({
          category: 'Water',
          geographyCode: 'UK',
          reportingYear: 2026,
          value: 100,
          unit: 'cubic_metres',
        }),
      ).rejects.toMatchObject({ code: 'no_conversion' });
    });

    it('a missing ELECTRICITY factor still refuses — the exception is one named category', async () => {
      useFactor(prisma, null);

      // Electricity is invoice-tracked too, so a rule keyed on "invoice-tracked
      // and unresolved" would have silently accepted this with no figure. The
      // core of the inventory must fail loudly instead.
      await expect(
        service.compute({
          category: 'Electricity',
          geographyCode: 'ZZ',
          reportingYear: 2026,
          value: 1000,
          unit: 'kWh',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('throws BadRequest for an unsupported unit before any DB lookup', async () => {
    await expect(
      service.compute({
        category: 'Electricity',
        geographyCode: 'TR',
        reportingYear: 2024,
        value: 1,
        unit: 'bananas',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.emissionFactor.findMany).not.toHaveBeenCalled();
  });

  it('refuses a unit the category does not have before any factor is looked up', async () => {
    // (Once "the normalised unit mismatches the factor unit"; since LP3-03 a
    // factor in another family is simply no path, and kWh on Fuel is refused
    // first as `unit_not_for_category`.)
    useFactor(prisma, 
      makeFactor({ category: 'Fuel', normalizedUnit: 'litres', factorValue: 2.6841, scope: 1 }),
    );

    await expect(
      service.compute({
        category: 'Fuel',
        geographyCode: 'UK',
        reportingYear: 2024,
        value: 100,
        unit: 'kWh',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('a refusal quotes the unit, never the whole of it', () => {
    // Built from code points, never typed: escape sequences typed into this
    // repo have arrived in files as the literal, invisible character.
    const char = (code: number) => String.fromCharCode(code);

    it('an unknown unit', async () => {
      await expect(
        service.compute({
          category: 'Electricity',
          geographyCode: 'TR',
          reportingYear: 2024,
          value: 1,
          unit: `bananas${char(0x202e)}${'x'.repeat(100)}`,
        }),
      ).rejects.toThrow(
        `Unsupported unit "bananas<U+202E>${'x'.repeat(32)}…"`,
      );

      // The caller's OWN spelling, not the canonicalised key: quoting
      // `canonicalUnit(input.unit)` would tell a user about a token they never
      // typed, and nothing else here has a capital letter or a space in it.
      await expect(
        service.compute({
          category: 'Electricity',
          geographyCode: 'TR',
          reportingYear: 2024,
          value: 1,
          unit: 'Banana Units',
        }),
      ).rejects.toThrow('Unsupported unit "Banana Units"');
    });

    it('a known unit padded out, which reaches the category refusal', async () => {
      // `canonicalUnit` collapses whitespace, so this is `cubic_metres` to the
      // vocabulary check, and a bulk import repeats the sentence it gets.
      await expect(
        service.compute({
          category: 'Electricity',
          geographyCode: 'UK',
          reportingYear: 2026,
          value: 1,
          unit: `cubic${' '.repeat(30_000)}metres`,
        }),
      ).rejects.toThrow(
        `Unit "cubic${' '.repeat(35)}…" is not valid for "Electricity". Accepted: kWh, MWh.`,
      );
    });

    // A factor refusal names the unit as the library sees it — the
    // vocabulary's spelling (`storedUnit`), never the caller's — so a disguised
    // or padded spelling cannot reach that sentence at all. A Water factor per
    // kWh against a reading in m³ is the refusal that names a unit
    // (`no_conversion`).
    const kwhWaterFactor = () =>
      makeFactor({
        category: 'Water',
        scope: 3,
        factorValue: 0.149,
        normalizedUnit: 'kWh',
        geographyCode: 'UK',
        reportingYear: 2026,
      });

    it('a known unit carrying characters that disguise it, in the factor refusal', async () => {
      useFactor(prisma, kwhWaterFactor());

      // U+FEFF and a tab are whitespace to `canonicalUnit`: still cubic metres.
      const refusal = await service
        .compute({
          category: 'Water',
          geographyCode: 'UK',
          reportingYear: 2026,
          value: 100,
          unit: `cubic${char(0xfeff)}${char(0x09)}metres`,
        })
        .then(() => null, (e: unknown) => e as NotFoundException);
      expect(refusal).toBeInstanceOf(NoEmissionFactorError);
      if (!refusal) return;
      expect(refusal.message).toContain('no sourced conversion from "cubic_metres"');
      expect(refusal.message).not.toMatch(/[\uFEFF\t]/);
    });

    it('a known unit padded out, in the factor refusal', async () => {
      // The other half of the same sentence: reachable at any length through
      // the preview DTO, which has no cap.
      useFactor(prisma, kwhWaterFactor());

      const refusal = await service
        .compute({
          category: 'Water',
          geographyCode: 'UK',
          reportingYear: 2026,
          value: 100,
          unit: `cubic${' '.repeat(30_000)}metres`,
        })
        .then(() => null, (e: unknown) => e as NotFoundException);
      expect(refusal).toBeInstanceOf(NoEmissionFactorError);
      if (!refusal) return;
      expect(refusal.message).toContain('no sourced conversion from "cubic_metres"');
      expect(refusal.message.length).toBeLessThan(400);
    });
  });
});

describe('CalculationsService.listFactors', () => {
  let prisma: FactorPrismaMock;
  let service: CalculationsService;

  beforeEach(() => {
    prisma = createFactorPrismaMock();
    service = new CalculationsService(prisma as unknown as PrismaService, ALLOW_PLACEHOLDERS);
  });

  it('passes optional filters through to Prisma and maps to detail DTOs with their release', async () => {
    const release = makeRelease({ status: 'placeholder', edition: '2026.1', ordinal: 202601 });
    // Every dimension off its default, so a mapping that dropped one fails.
    prisma.emissionFactor.findMany.mockResolvedValue([
      makeFactor({ id: 'f1', release, gas: 'CO2', gasCoverage: null, scope2Method: 'market', calorificBasis: 'net', dataYear: 2023 }),
    ]);

    const result = await service.listFactors({ category: 'Electricity', geographyCode: 'TR', year: 2024 });

    expect(prisma.emissionFactor.findMany).toHaveBeenCalledWith({
      where: { category: 'Electricity', geographyCode: 'TR', reportingYear: 2024 },
      include: {
        release: {
          select: {
            id: true, publisher: true, title: true, edition: true, ordinal: true, status: true,
            sourceUrl: true, licence: true, publishedAt: true, gwpSet: true,
          },
        },
      },
      // By release ordinal, never by the `version` label.
      orderBy: [
        { category: 'asc' },
        { activityType: 'asc' },
        { geographyCode: 'asc' },
        { reportingYear: 'desc' },
        { release: { publisher: 'asc' } },
        { release: { ordinal: 'desc' } },
        { gas: 'asc' },
        { scope2Method: 'asc' },
        { calorificBasis: 'asc' },
        { normalizedUnit: 'asc' },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'f1',
      activityType: 'grid_electricity',
      gas: 'CO2',
      gasCoverage: null,
      scope2Method: 'market',
      calorificBasis: 'net',
      dataYear: 2023,
      release: { id: release.id, status: 'placeholder', edition: '2026.1', ordinal: 202601 },
    });
    expect(typeof result[0].createdAt).toBe('string');
    // A release's people and notes stay off the wire.
    expect(result[0].release).not.toHaveProperty('reviewedBy');
    expect(result[0].release).not.toHaveProperty('notes');
  });

  it('omits undefined filters (lists all)', async () => {
    prisma.emissionFactor.findMany.mockResolvedValue([]);

    await service.listFactors({});

    expect(prisma.emissionFactor.findMany).toHaveBeenCalledWith({
      where: { category: undefined, geographyCode: undefined, reportingYear: undefined },
      include: { release: { select: expect.not.objectContaining({ reviewedBy: true }) } },
      orderBy: expect.any(Array),
    });
  });
});

describe('CalculationsService.compute — LP3-03 factor paths', () => {
  let prisma: FactorPrismaMock;
  const service = (allowPlaceholders: boolean) =>
    new CalculationsService(prisma as unknown as PrismaService, { allowPlaceholders });
  const authoritative = () =>
    makeRelease({
      publisher: 'DESNZ',
      status: 'authoritative',
      edition: '2026',
      ordinal: 1,
      sourceUrl: 'https://www.gov.uk/x',
      licence: 'OGL v3.0',
      publishedAt: new Date('2026-06-10T00:00:00.000Z'),
      gwpSet: 'AR5',
    });
  const electricityUK = { category: 'Electricity', geographyCode: 'UK', reportingYear: 2026, value: 1000, unit: 'kWh' };

  beforeEach(() => {
    prisma = createFactorPrismaMock();
  });

  it('writes the v2 snapshot: release, activity type, gas coverage, basis, method, year policy', async () => {
    const release = authoritative();
    // The row's own `version` label differs from its release's edition, as a
    // pre-LP3-03 row's can: the snapshot's `version` is the EDITION (contract).
    useFactor(prisma, makeFactor({ geographyCode: 'UK', reportingYear: 2026, factorValue: 0.2, release, version: 'row-label' }));
    const result = (await service(false).compute(electricityUK)) as CalculationResultV2;
    expect(result).toMatchObject({
      snapshotSchema: 2,
      activityType: 'grid_electricity',
      gas: 'CO2e',
      gasCoverage: 'all_ghg',
      calorificBasis: 'not_applicable',
      scope2Method: 'location',
      dataYear: 2026,
      yearPolicy: 'exact',
      version: '2026',
      conversion: null,
      factorRelease: {
        id: release.id,
        publisher: 'DESNZ',
        edition: '2026',
        ordinal: 1,
        status: 'authoritative',
        sourceUrl: 'https://www.gov.uk/x',
        licence: 'OGL v3.0',
        publishedAt: '2026-06-10',
        gwpSet: 'AR5',
      },
    });
    expect(result.kgCo2e).toBeCloseTo(200, 9);
    expect(isProvenanceSnapshot(result)).toBe(true);
    expect(isAuthoritativeSnapshot(result)).toBe(true);
  });

  it('where placeholders are refused, never reads one into the pricing query, and names the gap', async () => {
    useFactor(prisma, makeFactor({ geographyCode: 'UK', reportingYear: 2026 }));
    const refusal = await service(false)
      .compute(electricityUK)
      .then(() => null, (e: unknown) => e as NoEmissionFactorError);
    expect(refusal).toBeInstanceOf(NoEmissionFactorError);
    expect(refusal?.getResponse()).toMatchObject({
      statusCode: 404,
      code: 'placeholder_refused',
      coverage: { category: 'Electricity', activityType: 'grid_electricity', geographyCode: 'UK', reportingYear: 2026, unit: 'kWh' },
    });
    // The pricing query asked for authoritative releases only; the second
    // pass, over every live release, only named the refusal.
    const statusesAsked = prisma.emissionFactor.findMany.mock.calls.map(
      ([args]) => (args.where.release as { status: { in: string[] } }).status.in,
    );
    expect(statusesAsked).toEqual([['authoritative'], ['authoritative', 'placeholder', 'fixture']]);
  });

  it('where placeholders are refused, an authoritative factor prices with one query each', async () => {
    useFactor(prisma, makeFactor({ geographyCode: 'UK', reportingYear: 2026, release: authoritative() }));
    expectCalculated(await service(false).compute(electricityUK));
    expect(prisma.emissionFactor.findMany).toHaveBeenCalledTimes(1);
  });

  it('ranks an authoritative factor above a placeholder of a higher ordinal', async () => {
    useFactor(
      prisma,
      makeFactor({ geographyCode: 'UK', reportingYear: 2026, factorValue: 9, release: makeRelease({ ordinal: 999999 }) }),
      makeFactor({ geographyCode: 'UK', reportingYear: 2026, factorValue: 0.2, release: authoritative() }),
    );
    const result = expectCalculated(await service(true).compute(electricityUK));
    expect(result.factorValue).toBe(0.2);
  });

  it('never resolves a withdrawn release, a per-gas row or a market-based row', async () => {
    useFactor(
      prisma,
      makeFactor({ geographyCode: 'UK', reportingYear: 2026, release: makeRelease({ status: 'withdrawn' }) }),
      makeFactor({ geographyCode: 'UK', reportingYear: 2026, gas: 'CO2', gasCoverage: null }),
      makeFactor({ geographyCode: 'UK', reportingYear: 2026, scope2Method: 'market' }),
    );
    await expect(service(true).compute(electricityUK)).rejects.toMatchObject({ code: 'no_factor' });
  });

  it('prices a typed record by its own activity type, and a legacy untyped one by `unspecified`', async () => {
    useFactor(
      prisma,
      makeFactor({ category: 'Fuel', activityType: 'diesel', scope: 1, geographyCode: 'UK', normalizedUnit: 'litres', factorValue: 2.5 }),
      makeFactor({ category: 'Fuel', activityType: 'unspecified', scope: 1, geographyCode: 'UK', normalizedUnit: 'litres', factorValue: 2.7 }),
    );
    const fuel = { category: 'Fuel', geographyCode: 'UK', reportingYear: 2024, value: 10, unit: 'litres' };
    expect(expectCalculated(await service(true).compute({ ...fuel, activityType: 'diesel' })).factorValue).toBe(2.5);
    expect(expectCalculated(await service(true).compute(fuel)).factorValue).toBe(2.7);
    // Gas oil has no factor of its own and never borrows diesel's.
    await expect(service(true).compute({ ...fuel, activityType: 'gas_oil' })).rejects.toMatchObject({
      code: 'no_factor',
      coverage: expect.objectContaining({ activityType: 'gas_oil' }),
    });
  });

  it('refuses an activity type the category does not have (400, no coverage, no lookup)', async () => {
    for (const [category, activityType, unit] of [
      ['Electricity', 'diesel', 'kWh'],
      ['Fuel', 'R-410A', 'litres'],
      ['Fuel', 'unspecified', 'litres'],
    ]) {
      const refusal = await service(true)
        .compute({ category, activityType, geographyCode: 'UK', reportingYear: 2026, value: 1, unit })
        .then(() => null, (e: unknown) => e as CalculationInputError);
      expect(refusal).toBeInstanceOf(CalculationInputError);
      expect(refusal?.getResponse()).toEqual(expect.objectContaining({ code: 'activity_type_not_for_category' }));
      expect(refusal?.getResponse()).not.toHaveProperty('coverage');
    }
    expect(prisma.emissionFactor.findMany).not.toHaveBeenCalled();
  });

  it('gives the 400 refusals their codes and no coverage', async () => {
    const codeOf = (input: Parameters<CalculationsService['compute']>[0]) =>
      service(true)
        .compute(input)
        .then(() => null, (e: unknown) => (e as CalculationInputError).getResponse());
    expect(await codeOf({ ...electricityUK, unit: 'bananas' })).toMatchObject({ code: 'unit_unknown' });
    expect(await codeOf({ ...electricityUK, category: 'Natural Gas', unit: 'Sm3' })).toMatchObject({ code: 'unit_blocked' });
    expect(await codeOf({ ...electricityUK, unit: 'therms' })).toMatchObject({ code: 'unit_not_for_category' });
    for (const body of [
      await codeOf({ ...electricityUK, unit: 'bananas' }),
      await codeOf({ ...electricityUK, unit: 'therms' }),
    ]) {
      expect(body).not.toHaveProperty('coverage');
    }
  });

  it("refuses a factor whose scope is not its category's (409 factor_scope_mismatch)", async () => {
    useFactor(prisma, makeFactor({ geographyCode: 'UK', reportingYear: 2026, scope: 1 }));
    await expect(service(true).compute(electricityUK)).rejects.toMatchObject({
      code: 'factor_scope_mismatch',
      status: 409,
    });
  });

  it('refuses two publishers claiming one key at one rank (409 ambiguous_factor)', async () => {
    useFactor(
      prisma,
      makeFactor({ geographyCode: 'UK', reportingYear: 2026, release: makeRelease({ publisher: 'A' }) }),
      makeFactor({ geographyCode: 'UK', reportingYear: 2026, release: makeRelease({ publisher: 'B' }) }),
    );
    await expect(service(true).compute(electricityUK)).rejects.toBeInstanceOf(FactorLibraryConflictError);
  });

  it('refuses a lookup with more candidates than the cap, as a library defect', async () => {
    useFactor(
      prisma,
      ...Array.from({ length: FACTOR_CANDIDATE_CAP + 1 }, (_, i) =>
        makeFactor({ geographyCode: 'UK', reportingYear: 2026, release: makeRelease({ ordinal: i + 1 }) }),
      ),
    );
    await expect(service(true).compute(electricityUK)).rejects.toMatchObject({ code: 'ambiguous_factor' });
  });

  it("keeps the 404 when only the diagnostic pass over non-authoritative rows exceeds the cap", async () => {
    useFactor(
      prisma,
      ...Array.from({ length: FACTOR_CANDIDATE_CAP + 1 }, (_, i) =>
        makeFactor({ geographyCode: 'UK', reportingYear: 2026, release: makeRelease({ ordinal: i + 1 }) }),
      ),
    );
    await expect(service(false).compute(electricityUK)).rejects.toMatchObject({ status: 404 });
  });

  it('reads conversions only from the base unit of the record\'s family, and caps them too', async () => {
    useFactor(prisma, makeFactor({ category: 'Natural Gas', scope: 1, geographyCode: 'UK', reportingYear: 2026 }));
    prisma.library.conversions = Array.from({ length: FACTOR_CANDIDATE_CAP + 1 }, (_, i) =>
      makeConversion({ geographyCode: 'UK', reportingYear: 2026, dataYear: 2026, release: makeRelease({ ordinal: i + 1 }) }),
    );
    await expect(
      service(true).compute({ category: 'Natural Gas', geographyCode: 'UK', reportingYear: 2026, value: 1, unit: 'm3' }),
    ).rejects.toMatchObject({ code: 'ambiguous_factor', status: 409 });
    expect(prisma.unitConversion.findMany.mock.calls[0][0].where).toMatchObject({
      category: 'Natural Gas',
      activityType: 'natural_gas',
      geographyCode: 'UK',
      reportingYear: 2026,
      fromUnit: 'cubic_metres',
    });
  });

  it('accepts exactly the cap — the refusal is above it, not at it', async () => {
    useFactor(
      prisma,
      ...Array.from({ length: FACTOR_CANDIDATE_CAP }, (_, i) =>
        makeFactor({ geographyCode: 'UK', reportingYear: 2026, release: makeRelease({ ordinal: i + 1 }) }),
      ),
    );
    expectCalculated(await service(true).compute(electricityUK));
  });

  it('lets any other failure of the diagnostic pass surface — it swallows only the cap', async () => {
    useFactor(prisma, null);
    const boom = new Error('connection reset');
    prisma.emissionFactor.findMany
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => {
        throw boom;
      });
    await expect(service(false).compute(electricityUK)).rejects.toBe(boom);
  });

  it('refuses a billed kWh of gas against net-only factors (calorific_basis_mismatch)', async () => {
    useFactor(prisma, makeFactor({ category: 'Natural Gas', scope: 1, geographyCode: 'UK', reportingYear: 2026, calorificBasis: 'net' }));
    await expect(
      service(true).compute({ category: 'Natural Gas', geographyCode: 'UK', reportingYear: 2026, value: 100, unit: 'kWh' }),
    ).rejects.toMatchObject({ code: 'calorific_basis_mismatch' });
  });

  it('builds the coverage key from canonical values — the vocabulary unit, never the typed spelling', async () => {
    useFactor(prisma, null);
    await expect(
      service(true).compute({ category: 'Electricity', geographyCode: 'UK', reportingYear: 2031, value: 1, unit: 'kw h' }),
    ).rejects.toMatchObject({
      code: 'no_factor',
      coverage: { category: 'Electricity', activityType: 'grid_electricity', geographyCode: 'UK', reportingYear: 2031, unit: 'kWh' },
    });
  });
});
