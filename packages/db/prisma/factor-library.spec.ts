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
  FACTOR_PUBLISHERS,
  FACTOR_STATUSES,
  GWP_SETS,
  INTERNAL_FACTOR_PUBLISHERS,
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

/** Every migration's SQL, oldest first. */
function migrationSqls(): string[] {
  return readdirSync(migrationsDir)
    .filter((d) => /^\d{14}_/.test(d))
    .sort()
    .map((d) => readFileSync(join(migrationsDir, d, 'migration.sql'), 'utf8'));
}

/**
 * The text inside the parentheses that open at `open` (just past a `(`),
 * reading SQL string literals whole — a `)` or a doubled `''` inside a
 * publisher's name is text, not syntax.
 */
function parenthesised(sql: string, open: number): string {
  let depth = 1;
  for (let i = open; i < sql.length; i += 1) {
    const c = sql[i];
    if (c === "'") {
      i += 1;
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1;
    } else if (c === '(') depth += 1;
    else if (c === ')' && (depth -= 1) === 0) return sql.slice(open, i);
  }
  throw new Error('unbalanced parentheses');
}

/**
 * The body of the CHECK named `constraint` now in force: the newest statement
 * that adds it (`ADD CONSTRAINT`, or an inline `CONSTRAINT … CHECK`), unless a
 * later one drops it or renames it away — then none is in force and this
 * throws, so the parity below fails rather than vouching for a CHECK that is
 * gone. LP4-02 admits a real publisher by redefining the publisher CHECK in a
 * migration of its own; the registry must match that one, not LP3-03's.
 */
function constraintInForce(constraint: string, sqls: readonly string[] = migrationSqls()): string {
  const name = `"${constraint}"`;
  const event = new RegExp(
    `(DROP\\s+CONSTRAINT(?:\\s+IF\\s+EXISTS)?\\s+${name})` +
      `|(RENAME\\s+CONSTRAINT\\s+${name}\\s+TO)` +
      `|(\\bTO\\s+${name})` +
      `|((?:ADD\\s+)?CONSTRAINT\\s+${name}\\s+CHECK\\s*\\()`,
    'gi',
  );
  let body: string | null = null;
  for (const sql of sqls) {
    for (const m of sql.matchAll(event)) {
      if (m[3]) throw new Error(`a constraint is renamed to ${constraint} — read that migration by hand`);
      body = m[4] ? parenthesised(sql, m.index! + m[0].length) : null;
    }
  }
  if (body === null) throw new Error(`no CHECK named ${constraint} is in force`);
  return body;
}

/** The literals of `"<column>" IN (...)` inside one CHECK's body. */
function inList(body: string, column: string): string[] {
  const at = body.indexOf(`"${column}" IN (`);
  if (at < 0) throw new Error(`no IN list for ${column}`);
  const list = parenthesised(body, at + `"${column}" IN (`.length);
  return [...list.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
}

/** The quoted literals of `CHECK ("<column>" IN (...))` in the migration. */
function checkVocabulary(column: string, sql: string = migration): string[] {
  const match = new RegExp(`"${column}" IN \\(([^)]*)\\)`).exec(sql);
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

  it('admits exactly the contract\'s publisher registry, in the CHECK now in force', () => {
    // The import refuses an unregistered publisher before the database does
    // (LP4-02); the two lists must be one list, or a release the validator
    // passed is refused by a constraint name — or the reverse.
    expect(inList(constraintInForce('factor_releases_publisher_check'), 'publisher')).toEqual([
      ...FACTOR_PUBLISHERS,
    ]);
    expect([PLACEHOLDER_PUBLISHER, FIXTURE_PUBLISHER]).toEqual([
      INTERNAL_FACTOR_PUBLISHERS.placeholder,
      INTERNAL_FACTOR_PUBLISHERS.fixture,
    ]);
  });

  it('pairs each internal publisher with its status as the contract does', () => {
    for (const [status, publisher] of Object.entries(INTERNAL_FACTOR_PUBLISHERS)) {
      const body = constraintInForce(`factor_releases_${status}_publisher_check`);
      expect(body).toContain(`("status" = '${status}') <= ("publisher" = '${publisher}')`);
      expect(body).toContain(`("publisher" = '${publisher}') <= ("status" IN ('${status}', 'withdrawn'))`);
    }
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

describe('constraintInForce — the parity spec\'s own reader', () => {
  const add = (list: string) => `ALTER TABLE "t" ADD CONSTRAINT "c" CHECK ("publisher" IN (${list}));`;
  const read = (...sqls: string[]) => inList(constraintInForce('c', sqls), 'publisher');

  it('reads the newest definition, across migrations and within one', () => {
    expect(read(add("'a'"), add("'a', 'b'"))).toEqual(['a', 'b']);
    expect(read(add("'a'"), `ALTER TABLE "t" DROP CONSTRAINT "c", ${add("'a', 'c'").slice('ALTER TABLE "t" '.length)}`)).toEqual(['a', 'c']);
  });

  it('refuses a CHECK dropped, or renamed away, after its last definition', () => {
    expect(() => read(add("'a'"), 'ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "c";')).toThrow(/no CHECK named c/);
    expect(() => read(add("'a'"), 'ALTER TABLE "t" RENAME CONSTRAINT "c" TO "d";')).toThrow(/no CHECK named c/);
    expect(() => read(add("'a'"), 'ALTER TABLE "t" RENAME CONSTRAINT "d" TO "c";')).toThrow(/renamed to c/);
  });

  it('keeps a parenthesis or a doubled quote inside a name, and reads only the constraint\'s own list', () => {
    expect(read(add("'Pub (UK)', 'O''Brien'"))).toEqual(['Pub (UK)', "O'Brien"]);
    expect(read(`UPDATE "t" SET "x" = 1 WHERE "publisher" IN ('stale');\n${add("'a'")}`)).toEqual(['a']);
  });

  it('reads an inline CONSTRAINT … CHECK as a definition', () => {
    expect(read(`CREATE TABLE "t" ("publisher" TEXT, CONSTRAINT "c" CHECK ("publisher" IN ('a')));`)).toEqual(['a']);
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
