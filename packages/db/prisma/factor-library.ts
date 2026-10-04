/**
 * The seed's factor library — its releases, factors and the K4 conversion —
 * and the identities the LP3-03 migration, the seed and the e2e fixture must
 * agree on. Pure data and pure helpers, no database access, so
 * `factor-library.spec.ts` can pin them against the migration's SQL and the
 * shared contract.
 *
 * Nothing here is a sourced value. Every row is a PLACEHOLDER: the release that
 * holds it says so, every snapshot that cites it says so, and the API refuses
 * it unless it runs with `ALLOW_PLACEHOLDER_FACTORS=true` (local development
 * and CI; owner decision K3, 2026-10-04). Authoritative DESNZ / Türkiye values
 * arrive with LP4-02 as releases of their own.
 */
import {
  directCalorificBasisFor,
  factorActivityTypeFor,
  scope2MethodFor,
} from '@tonyai/shared-types';

// The reporting year the demo dataset lives in. Restated in 30+ places before
// WP15; a single constant is what stops the next move from being another sweep.
// PRIOR_YEAR exists only to give the factor library a second edition to
// resolve against, so factor versioning is demonstrable.
export const DEMO_YEAR = 2026;
export const PRIOR_YEAR = DEMO_YEAR - 1;

/**
 * The activity type the seed's demo records of a typed category are entered
 * with: a NEW record of Fuel, Mobile Combustion or Refrigerants names one
 * (LP3-03), and the seed writes new records. Only Fuel is seeded, priced by
 * the `diesel` rows below; `unspecified` stays for records written before
 * LP3-03 (owner decision K-b).
 */
export const SEED_ACTIVITY_TYPES: Readonly<Record<string, string>> = { Fuel: 'diesel' };

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

/**
 * The two internal publishers of the database's closed publisher registry
 * (`factor_releases_publisher_check`). The migration names them in SQL; a
 * parity spec keeps the spellings identical.
 */
export const PLACEHOLDER_PUBLISHER = 'TonyAI prototype';
export const FIXTURE_PUBLISHER = 'TonyAI test fixture';

export const PLACEHOLDER_RELEASE_TITLE =
  'Prototype demo emission factors (calculation_logic.md §3) — NOT authoritative';
export const PLACEHOLDER_RELEASE_NOTES =
  'Unsourced prototype values. Calculated only where the API runs with ' +
  'ALLOW_PLACEHOLDER_FACTORS=true (local development, CI); refused everywhere ' +
  'else (LP3-03, owner decision K3). Their dimensions (gas coverage, data ' +
  'year, calorific basis) are assumed, not sourced.';

/**
 * A demo edition's ordinal, derived from the edition (2026.1 → 202601) — the
 * same arithmetic the LP3-03 migration applies to a database's pre-release
 * rows, so the release the migration created and the one the seed declares
 * are one release, whichever editions a database happened to hold.
 */
export function placeholderOrdinal(edition: string): number {
  const match = /^([0-9]{4})\.([0-9]{1,2})$/.exec(edition);
  if (!match) throw new Error(`Not a demo edition: "${edition}"`);
  return Number(match[1]) * 100 + Number(match[2]);
}

export interface SeedRelease {
  publisher: string;
  title: string;
  edition: string;
  ordinal: number;
  status: 'placeholder';
  notes: string;
}

/** In ascending ordinal order — the database refuses a lower one later. */
export const SEED_RELEASES: readonly SeedRelease[] = [`${PRIOR_YEAR}.1`, `${DEMO_YEAR}.1`].map(
  (edition) => ({
    publisher: PLACEHOLDER_PUBLISHER,
    title: PLACEHOLDER_RELEASE_TITLE,
    edition,
    ordinal: placeholderOrdinal(edition),
    status: 'placeholder' as const,
    notes: PLACEHOLDER_RELEASE_NOTES,
  }),
);

// ---------------------------------------------------------------------------
// Factors
// ---------------------------------------------------------------------------
//
// Values are the demo numbers of docs/md_docs/calculation_logic.md (§3
// Regional Emission Factors). Scope 1 = direct combustion, Scope 2 = purchased
// energy. A factor is quoted per ONE base unit of its family
// (`DIMENSION_BASE_UNIT`): electricity and natural gas per kWh, liquid fuels
// per litre.
//
// The doc gives a single demo factor set, seeded under DEMO_YEAR. The VALUES
// are the doc's demo numbers; re-dating them does not make them that year's
// real factors, which is why every row's `source` says so — `source` and the
// release's edition are printed verbatim into the customer-facing factor
// appendix, so this is the label a customer actually sees.

const DEMO_SOURCE = 'docs/md_docs/calculation_logic.md §3 (prototype demo factors)';
// Applied to the DEMO_YEAR rows: those values are the doc's demo set re-dated,
// so they get exactly the same caveat the prior-year row carries. Without it
// the two sets read backwards: a reader comparing them infers the year with
// the caveat is the placeholder and the other one is real.
const DEMO_FACTOR_SOURCE = `${DEMO_SOURCE} — ${DEMO_YEAR} demo placeholder, NOT an authoritative value`;
const PRIOR_FACTOR_SOURCE = `${DEMO_SOURCE} — ${PRIOR_YEAR} demo placeholder, NOT an authoritative value`;

/** A factor as the seed loads it — every `FACTOR_IDENTITY_FIELDS` dimension explicit. */
export interface SeedFactor {
  /** The edition of the placeholder release that holds it. */
  edition: string;
  category: string;
  activityType: string;
  gas: 'CO2e';
  gasCoverage: 'all_ghg';
  geographyCode: string;
  reportingYear: number;
  dataYear: number;
  scope: number;
  scope2Method: string;
  calorificBasis: string;
  factorValue: number;
  factorUnit: string;
  normalizedUnit: string;
  methodology: string;
  source: string;
  version: string;
}

type DemoFactor = Pick<
  SeedFactor,
  'category' | 'geographyCode' | 'reportingYear' | 'scope' | 'factorValue' | 'factorUnit' |
  'normalizedUnit' | 'methodology' | 'source'
> & { activityType?: string };

/**
 * The dimensions a demo row takes — exactly how the LP3-03 migration
 * backfilled the pre-release rows (the parity spec checks the SQL against this):
 * the category's implicit activity type, else `unspecified`; the CO2e total
 * covering every gas; the basis a factor applied directly to the record's unit
 * is on; the category's Scope 2 method.
 */
function demoFactor(row: DemoFactor): SeedFactor {
  const edition = `${row.reportingYear}.1`;
  return {
    edition,
    category: row.category,
    activityType: row.activityType ?? factorActivityTypeFor(row.category, null),
    gas: 'CO2e',
    gasCoverage: 'all_ghg',
    geographyCode: row.geographyCode,
    reportingYear: row.reportingYear,
    dataYear: row.reportingYear,
    scope: row.scope,
    scope2Method: scope2MethodFor(row.category),
    calorificBasis: directCalorificBasisFor(row.category, row.normalizedUnit),
    factorValue: row.factorValue,
    factorUnit: row.factorUnit,
    normalizedUnit: row.normalizedUnit,
    methodology: row.methodology,
    source: row.source,
    version: edition,
  };
}

export const SEED_FACTORS: readonly SeedFactor[] = [
  // --- Scope 2: purchased electricity (kgCO2e/kWh) — DEMO_YEAR ---
  // The EU row's methodology says "residual-mix" — a market-based figure — yet
  // it resolves as location-based (D08), by owner decision 2026-10-04: a
  // placeholder production refuses, relabelled when LP4-02 loads sourced
  // factors (Open questions, "LP3-03 PR B").
  { category: 'Electricity', geographyCode: 'UK', reportingYear: DEMO_YEAR, scope: 2, factorValue: 0.2071, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'location-based', source: DEMO_FACTOR_SOURCE },
  { category: 'Electricity', geographyCode: 'TR', reportingYear: DEMO_YEAR, scope: 2, factorValue: 0.4400, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'location-based', source: DEMO_FACTOR_SOURCE },
  { category: 'Electricity', geographyCode: 'EU', reportingYear: DEMO_YEAR, scope: 2, factorValue: 0.2310, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'residual-mix', source: DEMO_FACTOR_SOURCE },

  // --- Scope 2: purchased electricity — PRIOR_YEAR versioning demo (UK) ---
  // Placeholder value (the doc gives one demo set only); present to prove that
  // (category, geography, year) resolves to a DIFFERENT factor than DEMO_YEAR.
  { category: 'Electricity', geographyCode: 'UK', reportingYear: PRIOR_YEAR, scope: 2, factorValue: 0.2123, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'location-based', source: PRIOR_FACTOR_SOURCE },

  // --- Scope 1: natural gas (kgCO2e/kWh, gross CV) — DEMO_YEAR ---
  // Geography-agnostic demo factor; seeded per supported geography so a lookup
  // by the reporting entity's geographyCode always resolves.
  { category: 'Natural Gas', geographyCode: 'UK', reportingYear: DEMO_YEAR, scope: 1, factorValue: 0.1829, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'standard-factor', source: DEMO_FACTOR_SOURCE },
  { category: 'Natural Gas', geographyCode: 'TR', reportingYear: DEMO_YEAR, scope: 1, factorValue: 0.1829, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'standard-factor', source: DEMO_FACTOR_SOURCE },
  { category: 'Natural Gas', geographyCode: 'EU', reportingYear: DEMO_YEAR, scope: 1, factorValue: 0.1829, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'standard-factor', source: DEMO_FACTOR_SOURCE },

  // --- Scope 1: liquid fuels (kgCO2e/litre) — DEMO_YEAR ---
  // Doc §3.1 gives Diesel 2.6841 (and Petrol 2.3111, not seeded). The rows
  // with no activity type are the pre-LP3-03 library's representative "Fuel"
  // factor: they price records written before Fuel was typed (`unspecified`,
  // a placeholder-only lookup). The `diesel` rows carry the SAME demo value
  // and label for typed records (owner decision, 2026-10-04) — no new number.
  { category: 'Fuel', geographyCode: 'UK', reportingYear: DEMO_YEAR, scope: 1, factorValue: 2.6841, factorUnit: 'kgCO2e/litre', normalizedUnit: 'litres', methodology: 'standard-factor (diesel)', source: DEMO_FACTOR_SOURCE },
  { category: 'Fuel', geographyCode: 'TR', reportingYear: DEMO_YEAR, scope: 1, factorValue: 2.6841, factorUnit: 'kgCO2e/litre', normalizedUnit: 'litres', methodology: 'standard-factor (diesel)', source: DEMO_FACTOR_SOURCE },
  { category: 'Fuel', geographyCode: 'EU', reportingYear: DEMO_YEAR, scope: 1, factorValue: 2.6841, factorUnit: 'kgCO2e/litre', normalizedUnit: 'litres', methodology: 'standard-factor (diesel)', source: DEMO_FACTOR_SOURCE },
  { category: 'Fuel', activityType: 'diesel', geographyCode: 'UK', reportingYear: DEMO_YEAR, scope: 1, factorValue: 2.6841, factorUnit: 'kgCO2e/litre', normalizedUnit: 'litres', methodology: 'standard-factor (diesel)', source: DEMO_FACTOR_SOURCE },
  { category: 'Fuel', activityType: 'diesel', geographyCode: 'TR', reportingYear: DEMO_YEAR, scope: 1, factorValue: 2.6841, factorUnit: 'kgCO2e/litre', normalizedUnit: 'litres', methodology: 'standard-factor (diesel)', source: DEMO_FACTOR_SOURCE },
  { category: 'Fuel', activityType: 'diesel', geographyCode: 'EU', reportingYear: DEMO_YEAR, scope: 1, factorValue: 2.6841, factorUnit: 'kgCO2e/litre', normalizedUnit: 'litres', methodology: 'standard-factor (diesel)', source: DEMO_FACTOR_SOURCE },
].map(demoFactor);

// ---------------------------------------------------------------------------
// Conversions (K4)
// ---------------------------------------------------------------------------

/**
 * The prototype's metered m³ → kWh multiplier for natural gas, until PR B a
 * code constant of `normalize()`: now a labelled placeholder conversion row of
 * the DEMO_YEAR release (owner decision K4, 2026-10-04), so dev figures do not
 * move and K3 refuses it wherever placeholders are refused. One row per
 * (geography, reporting year) the seed's Natural Gas factors cover. Gross, like
 * the factors it pairs with. The basis is the constant's own text, verbatim.
 */
export const NATURAL_GAS_M3_MULTIPLIER = 11.36;
export const NATURAL_GAS_M3_BASIS =
  'calculation_logic.md §2.1 prototype assumption, NOT a sourced factor. ' +
  'It reconstructs as a GROSS (higher) calorific value of ~40.0 MJ/m³ with ' +
  'the UK volume correction 1.02264 — a UK-shaped number currently applied ' +
  'to TR and EU records too. It must stay paired with a gross-CV emission ' +
  'factor; a net-CV factor would be ~10% inconsistent with it.';
export const NATURAL_GAS_M3_REFERENCE_CONDITIONS =
  'Not stated: calculation_logic.md §2.1 gives no reference conditions (see basis).';

export interface SeedConversion {
  edition: string;
  category: string;
  activityType: string;
  geographyCode: string;
  reportingYear: number;
  dataYear: number;
  fromUnit: string;
  toUnit: string;
  multiplier: number;
  calorificBasis: string;
  referenceConditions: string;
  basis: string;
}

export const SEED_CONVERSIONS: readonly SeedConversion[] = SEED_FACTORS.filter(
  (f) => f.category === 'Natural Gas',
).map((f) => ({
  edition: f.edition,
  category: f.category,
  activityType: f.activityType,
  geographyCode: f.geographyCode,
  reportingYear: f.reportingYear,
  dataYear: f.dataYear,
  fromUnit: 'cubic_metres',
  toUnit: 'kWh',
  multiplier: NATURAL_GAS_M3_MULTIPLIER,
  calorificBasis: 'gross',
  referenceConditions: NATURAL_GAS_M3_REFERENCE_CONDITIONS,
  basis: NATURAL_GAS_M3_BASIS,
}));
