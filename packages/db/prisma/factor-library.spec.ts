/**
 * Parity between the three places the LP3-03 factor model is written down:
 * the shared contract (@tonyai/shared-types), the migration's SQL and the
 * Prisma schema, and the seed's placeholder library. Each is checked against
 * the others as text or data, so a vocabulary, key or label that drifts in one
 * fails here rather than as an "ambiguous" or "no factor" refusal at runtime.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CALORIFIC_BASES,
  CATEGORY_ACTIVITY_TYPES,
  CATEGORY_SCOPE_MAP,
  CONVERSION_IDENTITY_FIELDS,
  DIMENSION_BASE_UNIT,
  FACTOR_GASES,
  FACTOR_GAS_COVERAGES,
  FACTOR_IDENTITY_FIELDS,
  FACTOR_STATUSES,
  GWP_SETS,
  SCOPE2_METHODS,
  UNSPECIFIED_ACTIVITY_TYPE,
  directCalorificBasisFor,
  identityKey,
  recordActivityTypesFor,
  resolveFactorPath,
  scope2MethodFor,
  unitDimensionOf,
  type Category,
  type FactorStatus,
} from '@tonyai/shared-types';
import {
  FIXTURE_PUBLISHER,
  NATURAL_GAS_M3_BASIS,
  NATURAL_GAS_M3_MULTIPLIER,
  PLACEHOLDER_PUBLISHER,
  PLACEHOLDER_RELEASE_NOTES,
  PLACEHOLDER_RELEASE_TITLE,
  SEED_CONVERSIONS,
  SEED_FACTORS,
  SEED_RELEASES,
  placeholderOrdinal,
} from './factor-library';

const migrationsDir = join(__dirname, 'migrations');
const migrationDir = readdirSync(migrationsDir).find((d) => d.endsWith('_lp3_03_factor_model'));
const migration = readFileSync(join(migrationsDir, migrationDir ?? 'missing', 'migration.sql'), 'utf8');
const schema = readFileSync(join(__dirname, 'schema.prisma'), 'utf8');

/** The quoted literals of `CHECK ("<column>" IN (...))` in the migration. */
function checkVocabulary(column: string): string[] {
  const match = new RegExp(`"${column}" IN \\(([^)]*)\\)`).exec(migration);
  if (!match) throw new Error(`no IN-list CHECK for ${column}`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

/** The fields of a model's `@@unique([...], name: "identity", ...)`. */
function identityFields(model: string): string[] {
  const body = new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1] ?? '';
  const match = /@@unique\(\[([^\]]*)\], name: "identity"/.exec(body);
  if (!match) throw new Error(`no identity key on ${model}`);
  return match[1].split(',').map((f) => f.trim());
}

describe('the migration and schema agree with the contract', () => {
  it('finds the LP3-03 migration', () => {
    expect(migrationDir).toBeDefined();
  });

  it('keys emission_factors and unit_conversions on the contract identity fields, in order', () => {
    expect(identityFields('EmissionFactor')).toEqual([...FACTOR_IDENTITY_FIELDS]);
    expect(identityFields('UnitConversion')).toEqual([...CONVERSION_IDENTITY_FIELDS]);
  });

  it('constrains every vocabulary to the contract lists', () => {
    expect(checkVocabulary('status')).toEqual([...FACTOR_STATUSES]);
    expect(checkVocabulary('gas')).toEqual([...FACTOR_GASES]);
    expect(checkVocabulary('gas_coverage')).toEqual([...FACTOR_GAS_COVERAGES]);
    expect(checkVocabulary('calorific_basis')).toEqual([...CALORIFIC_BASES]);
    expect(checkVocabulary('scope2_method')).toEqual([...SCOPE2_METHODS]);
    expect(checkVocabulary('gwp_set')).toEqual([...GWP_SETS]);
  });

  it('registers exactly the two internal publishers the seed and the e2e fixture use', () => {
    expect(checkVocabulary('publisher')).toEqual([PLACEHOLDER_PUBLISHER, FIXTURE_PUBLISHER]);
  });

  it('creates the legacy placeholder releases with the seed\'s title, notes and ordinal rule', () => {
    expect(migration).toContain(`'${PLACEHOLDER_RELEASE_TITLE}'`);
    expect(migration).toContain(`'${PLACEHOLDER_RELEASE_NOTES}'`);
    expect(migration).toContain(
      `split_part(v."version", '.', 1)::int * 100 + split_part(v."version", '.', 2)::int`,
    );
  });

  it('backfills each implicit category with its own activity type and every other with unspecified', () => {
    const implicit = Object.entries(CATEGORY_ACTIVITY_TYPES).filter(([, spec]) => spec?.implicit);
    for (const [category, spec] of implicit) {
      expect(migration).toContain(`WHEN '${category}' THEN '${spec!.implicit}'`);
    }
    // No mapping for a category the contract does not make implicit.
    const block = /"activity_type" = CASE f\."category"([\s\S]*?)END/.exec(migration)?.[1] ?? '';
    expect(block.match(/WHEN /g)).toHaveLength(implicit.length);
    expect(block).toContain(`ELSE '${UNSPECIFIED_ACTIVITY_TYPE}'`);
  });

  it('backfills the calorific basis and the Scope 2 method as the contract derives them', () => {
    // Gross exactly for a fuel-combustion category quoted per kWh
    // (`directCalorificBasisFor`); location-based exactly for Scope 2
    // (`scope2MethodFor`) — or the seed would add a second, differently keyed
    // row beside each backfilled one.
    const basis = /"calorific_basis" = CASE\s*WHEN f\."category" IN \(([^)]*)\)\s*AND f\."normalized_unit" = 'kWh' THEN 'gross'/.exec(migration);
    const fuelCategories = [...(basis?.[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1]);
    for (const category of Object.keys(CATEGORY_SCOPE_MAP)) {
      expect(fuelCategories.includes(category), category).toBe(directCalorificBasisFor(category, 'kWh') === 'gross');
      expect(directCalorificBasisFor(category, 'litres'), category).toBe('not_applicable');
      expect(scope2MethodFor(category) !== 'not_applicable', category).toBe(CATEGORY_SCOPE_MAP[category as Category] === 2);
    }
    expect(migration).toContain(`"scope2_method" = CASE WHEN f."scope" = 2 THEN 'location' ELSE 'not_applicable' END`);
  });

  it('keeps the activity-type token shape of the API DTO on records, factors and conversions', () => {
    const shape = `'^[A-Za-z0-9_-]{1,32}$'`;
    expect(migration.split(`"activity_type" ~ ${shape}`)).toHaveLength(4);
    // Every activity type the contract names fits it.
    for (const spec of Object.values(CATEGORY_ACTIVITY_TYPES)) {
      for (const type of spec?.types ?? []) expect(type.value).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    }
  });
});

describe('the seed library', () => {
  it('derives each demo edition\'s ordinal as the migration does', () => {
    expect(placeholderOrdinal('2026.1')).toBe(202601);
    expect(placeholderOrdinal('2025.12')).toBe(202512);
    for (const bad of ['2026', '2026.1.1', '0000-E2E-FIXTURE', '2026.123', ' 2026.1']) {
      expect(() => placeholderOrdinal(bad)).toThrow();
    }
  });

  it('declares its releases in ascending ordinal order, all placeholder', () => {
    const ordinals = SEED_RELEASES.map((r) => r.ordinal);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
    expect(new Set(ordinals).size).toBe(ordinals.length);
    expect(SEED_RELEASES.every((r) => r.status === 'placeholder' && r.publisher === PLACEHOLDER_PUBLISHER)).toBe(true);
  });

  it('places every factor and conversion in a declared release', () => {
    const editions = new Set(SEED_RELEASES.map((r) => r.edition));
    for (const row of [...SEED_FACTORS, ...SEED_CONVERSIONS]) expect(editions.has(row.edition)).toBe(true);
  });

  it('holds no duplicate identity within a release', () => {
    const withRelease = <T extends { edition: string }>(row: T) => ({ ...row, releaseId: row.edition });
    const factorKeys = SEED_FACTORS.map((f) => identityKey(withRelease(f), FACTOR_IDENTITY_FIELDS));
    const conversionKeys = SEED_CONVERSIONS.map((c) => identityKey(withRelease(c), CONVERSION_IDENTITY_FIELDS));
    expect(new Set(factorKeys).size).toBe(factorKeys.length);
    expect(new Set(conversionKeys).size).toBe(conversionKeys.length);
  });

  it('quotes every factor per one base unit, in its category\'s scope, with an activity type the category allows', () => {
    for (const f of SEED_FACTORS) {
      const dimension = unitDimensionOf(f.normalizedUnit);
      expect(dimension).toBeDefined();
      expect(DIMENSION_BASE_UNIT[dimension!]).toBe(f.normalizedUnit);
      expect(f.scope).toBe(CATEGORY_SCOPE_MAP[f.category as Category]);
      const own = (CATEGORY_ACTIVITY_TYPES[f.category as Category]?.types ?? []).map((t) => t.value);
      expect([...own, UNSPECIFIED_ACTIVITY_TYPE]).toContain(f.activityType);
      expect(f.version).toBe(f.edition);
    }
  });

  it('keeps one factor per typed Fuel row for legacy (unspecified) and typed (diesel) records, at the same value', () => {
    for (const geography of ['UK', 'TR', 'EU']) {
      const fuel = SEED_FACTORS.filter((f) => f.category === 'Fuel' && f.geographyCode === geography);
      expect(fuel.map((f) => f.activityType).sort()).toEqual(['diesel', UNSPECIFIED_ACTIVITY_TYPE]);
      expect(new Set(fuel.map((f) => f.factorValue)).size).toBe(1);
      expect(recordActivityTypesFor('Fuel').map((t) => t.value)).toContain('diesel');
    }
  });

  it('pairs the K4 11.36 conversion with each Natural Gas factor, gross, with its basis verbatim', () => {
    const gas = SEED_FACTORS.filter((f) => f.category === 'Natural Gas');
    expect(SEED_CONVERSIONS).toHaveLength(gas.length);
    for (const f of gas) {
      expect(f.calorificBasis).toBe('gross');
      const c = SEED_CONVERSIONS.find((x) => x.geographyCode === f.geographyCode && x.reportingYear === f.reportingYear);
      expect(c).toMatchObject({
        edition: f.edition,
        activityType: f.activityType,
        fromUnit: 'cubic_metres',
        toUnit: 'kWh',
        multiplier: NATURAL_GAS_M3_MULTIPLIER,
        calorificBasis: 'gross',
        basis: NATURAL_GAS_M3_BASIS,
      });
    }
    expect(NATURAL_GAS_M3_BASIS).toContain('NOT a sourced factor');
    // The literal, not the constant compared with itself: K4 moves the
    // prototype's number into a row, it does not change it.
    expect(NATURAL_GAS_M3_MULTIPLIER).toBe(11.36);
    expect(SEED_FACTORS.every((f) => f.gasCoverage === 'all_ghg' && f.gas === 'CO2e')).toBe(true);
  });

  it('resolves a metered m³ Natural Gas record through the placeholder conversion, and refuses it without placeholders', () => {
    const release = (edition: string) => ({ publisher: PLACEHOLDER_PUBLISHER, ordinal: placeholderOrdinal(edition), status: 'placeholder' as FactorStatus });
    const factors = SEED_FACTORS.filter((f) => f.category === 'Natural Gas' && f.geographyCode === 'TR').map((f) => ({ ...f, release: release(f.edition) }));
    const conversions = SEED_CONVERSIONS.filter((c) => c.geographyCode === 'TR').map((c) => ({ ...c, release: release(c.edition) }));
    const allowed = resolveFactorPath({ category: 'Natural Gas', inputUnit: 'cubic_metres', factors, conversions, allowPlaceholders: true });
    expect(allowed.ok && allowed.conversion?.multiplier).toBe(NATURAL_GAS_M3_MULTIPLIER);
    const refused = resolveFactorPath({ category: 'Natural Gas', inputUnit: 'cubic_metres', factors, conversions, allowPlaceholders: false });
    expect(refused).toEqual({ ok: false, code: 'placeholder_refused' });
  });

  it('labels every value as a non-authoritative placeholder', () => {
    for (const f of SEED_FACTORS) expect(f.source).toMatch(/NOT an authoritative value/);
    expect(PLACEHOLDER_RELEASE_TITLE).toMatch(/NOT authoritative/);
  });
});
