import { ACTIVITY_UNITS } from '@tonyai/shared-types';
// Unit normalization for the calculation engine (LP3-03).
//
// Two steps, and only the first is code:
// 1. DEFINITIONAL — within a unit family, to that family's base unit
//    (`DIMENSION_BASE_UNIT` in @tonyai/shared-types): MWh → kWh, therms → kWh,
//    gallons → litres, tonnes → kg. These are exact by definition and need no
//    source.
// 2. SOURCED — between families (metered m³ of natural gas → kWh), which
//    depends on the fuel, the country, the year and the calorific basis. That
//    is a `unit_conversions` row of a factor release, chosen by
//    `resolveFactorPath` for the record's category and passed in here; code
//    never carries one. Until LP3-03 the m³ → kWh multiplier 11.36 lived in
//    this table and converted ANY cubic metres, a water meter's included; it
//    is now a labelled placeholder row of the seed's release (owner decision
//    K4), refused wherever placeholders are.
// Passthrough units (already the base unit) apply a multiplier of 1 and report
// conversionApplied = false.

export interface NormalizationResult {
  normalizedValue: number;
  normalizedUnit: string;
  /** true when a non-identity conversion factor was applied. */
  conversionApplied: boolean;
  /** The multiplier that was applied. `conversionApplied` alone only says THAT
   *  something happened — an auditor asking WHAT was applied had to divide
   *  `normalizedValue` by the input to find out. */
  conversionFactor?: number;
  /** Where that multiplier comes from. */
  conversionBasis?: string;
}

/**
 * A unit is either convertible or blocked — never both.
 *
 * The first cut gave blocked units `multiplier: 1`, which is the worst possible
 * fail-open value: if the block check were ever bypassed, `normalize(100,'Sm3')`
 * would return 100 kWh against a real ~10.6, a ~10x understatement that looks
 * entirely normal. As a union, a blocked rule HAS no multiplier and forgetting
 * the check is a type error.
 */
type UnitRule =
  | {
      target: string;
      /** Multiply the input value by this to reach the base unit. */
      multiplier: number;
      /** Where the multiplier comes from, recorded in the snapshot. */
      basis: string;
    }
  | {
      target: string;
      /** Why this recognised unit cannot be calculated. */
      blocked: string;
    };

// The Sm³ refusal is the shared contract's wording, not a copy — the API and the
// UI must not be able to state different reasons for the same refusal.
const BLOCKED_SM3 =
  ACTIVITY_UNITS.find((u) => u.value === 'standard_cubic_metres')?.blocked ??
  'Standard cubic metres cannot be converted without a sourced calorific value.';

// Keyed by a canonical (lowercased, trimmed) unit alias. Every `target` is the
// base unit of the unit's family (`DIMENSION_BASE_UNIT`), and every multiplier
// is definitional and exact — a spec pins both. Do not add a cross-family
// conversion here: it belongs in a factor release.
const UNIT_RULES: Record<string, UnitRule> = {
  // --- Energy base unit: kWh ---
  kwh: { target: 'kWh', multiplier: 1, basis: 'identity' },
  mwh: { target: 'kWh', multiplier: 1000, basis: 'definitional — 1 MWh = 1,000 kWh (exact)' },
  // The international therm: 105,505,585.257 J (EC Directive 80/181/EEC) =
  // 29.30711 kWh to the seven figures the obligation names.
  therms: { target: 'kWh', multiplier: 29.30711, basis: 'definitional — 1 therm = 29.30711 kWh' },
  gj: { target: 'kWh', multiplier: 1000 / 3.6, basis: 'definitional — 1 GJ = 1,000/3.6 kWh (exact)' },

  // --- Metered gas volume base unit: cubic_metres ---
  // A volume as the meter reads it. Natural gas reaches kWh only through a
  // sourced conversion row (see the header); water is priced per m³ as it is.
  cubic_metres: { target: 'cubic_metres', multiplier: 1, basis: 'identity' },

  // Standard cubic metres: RECOGNISED but not calculable. Sm³ and m³ are
  // different physical quantities — the conversion needs a calorific value at
  // stated reference conditions, and this repo has no sourced one. Registering
  // it with any multiplier would produce a number nobody could defend, so it is
  // registered with none and refused by name (K4: until a sourced row exists).
  standard_cubic_metres: {
    target: 'standard_cubic_metres',
    blocked: BLOCKED_SM3,
  },
  // Nm³ is NOT Sm³. Normal cubic metres are referenced to 0 °C, standard to
  // 15 °C (ISO 13443) — an Nm³ holds ~5.5% more gas (288.15/273.15 = 1.0549).
  // Both are blocked today, but they must never come to share a multiplier, and
  // an Nm³ user told about "standard cubic metres" would reasonably conclude
  // they are the same unit.
  normal_cubic_metres: {
    target: 'normal_cubic_metres',
    blocked:
      'Normal cubic metres (Nm³, referenced to 0 °C) need a sourced calorific ' +
      'value to become kWh, and this prototype has none — it arrives with the ' +
      'Phase-4 factor library. Note Nm³ is not the same as Sm³ (15 °C): the two ' +
      'differ by about 5.5%. Enter the energy in kWh instead.',
  },

  // --- Liquid fuel base unit: litres (§2.2) ---
  litres: { target: 'litres', multiplier: 1, basis: 'identity' },
  uk_gallons: { target: 'litres', multiplier: 4.54609, basis: 'definitional — 1 UK gallon = 4.54609 L (exact)' },
  us_gallons: { target: 'litres', multiplier: 3.785411784, basis: 'definitional — 1 US gallon = 3.785411784 L (exact)' },

  // --- Distance (§2.4) ---
  passenger_kilometres: { target: 'passenger_kilometres', multiplier: 1, basis: 'identity' },
  kilometres: { target: 'kilometres', multiplier: 1, basis: 'identity' },

  // --- Mass base unit: kg ---
  // Refrigerant leakage is priced per kg by the gas's GWP; waste and fuel by
  // mass are quoted per kg too, so a tonne is 1,000 of them.
  kg: { target: 'kg', multiplier: 1, basis: 'identity' },
  tonnes: { target: 'kg', multiplier: 1000, basis: 'definitional — 1 tonne = 1,000 kg (exact)' },
};

/**
 * Common human/alias spellings mapped onto the canonical rule keys above,
 * written the way a user would actually type them. The lookup keys are DERIVED
 * from these spellings below — never hand-key this table in canonical form.
 *
 * Exported for the reachability spec, which asserts every spelling declared
 * here is one `isKnownUnit` accepts.
 */
export const UNIT_ALIAS_SPELLINGS: Readonly<Record<string, string>> = {
  kwh: 'kwh',
  'kw h': 'kwh',
  mwh: 'mwh',
  m3: 'cubic_metres',
  sm3: 'standard_cubic_metres',
  'sm³': 'standard_cubic_metres',
  standard_cubic_metre: 'standard_cubic_metres',
  standard_cubic_metres: 'standard_cubic_metres',
  scm: 'standard_cubic_metres',
  nm3: 'normal_cubic_metres',
  'nm³': 'normal_cubic_metres',
  normal_cubic_metre: 'normal_cubic_metres',
  normal_cubic_metres: 'normal_cubic_metres',
  'm³': 'cubic_metres',
  cubic_metre: 'cubic_metres',
  cubic_meters: 'cubic_metres',
  cubic_metres: 'cubic_metres',
  therm: 'therms',
  therms: 'therms',
  gj: 'gj',
  litre: 'litres',
  litres: 'litres',
  liter: 'litres',
  liters: 'litres',
  l: 'litres',
  uk_gallon: 'uk_gallons',
  uk_gallons: 'uk_gallons',
  us_gallon: 'us_gallons',
  us_gallons: 'us_gallons',
  passenger_kilometre: 'passenger_kilometres',
  passenger_kilometres: 'passenger_kilometres',
  pkm: 'passenger_kilometres',
  kilometre: 'kilometres',
  kilometres: 'kilometres',
  km: 'kilometres',
  tonne: 'tonnes',
  tonnes: 'tonnes',
  t: 'tonnes',
};

/**
 * The canonical form of a raw unit token: trimmed, lowercased, with every run
 * of whitespace collapsed to `_`.
 *
 * This is the SINGLE definition of what a lookup key looks like, and both the
 * alias table and incoming user input go through it. That is the point of it.
 * The alias table used to be hand-keyed, mixing canonical spellings with human
 * ones, and `'kw h'` was one of the human ones — it could never match, because
 * a user typing `kW h` reaches the lookup as `kw_h`. An ordinary spelling of
 * kWh was refused as a unit the system does not understand. Deriving the keys
 * makes that class of typo impossible rather than merely fixed once.
 *
 * It trades that for a narrower one, recorded here so the next reader does not
 * have to rediscover it: two spellings that clean to the SAME key silently
 * overwrite each other, last declaration wins, and TypeScript cannot see it
 * (literal duplicate keys are a compile error — `'uk gallon'` shadowing
 * `uk_gallon` is not). A spec asserts every spelling still resolves to the rule
 * key it declares, which is what makes this safe to keep doing.
 */
function cleanUnitToken(unit: string): string {
  return unit.trim().toLowerCase().replace(/\s+/g, '_');
}

/** The alias table keyed the way the lookup actually asks for it. */
const UNIT_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(UNIT_ALIAS_SPELLINGS).map(([spelling, ruleKey]) => [
    cleanUnitToken(spelling),
    ruleKey,
  ]),
);

/** The alias-resolved key a raw unit string maps to. Exported so the category
 *  guard compares the same token the rules are keyed by, not the user's
 *  spelling — `m3`, `m³` and `cubic_metres` are one unit. */
export function canonicalUnit(unit: string): string {
  const cleaned = cleanUnitToken(unit);
  return UNIT_ALIASES[cleaned] ?? cleaned;
}

/** True if the engine knows how to normalise the given unit. */
export function isKnownUnit(unit: string): boolean {
  return canonicalUnit(unit) in UNIT_RULES;
}

/**
 * A sourced conversion row as `normalize` applies it — the step a release
 * states between two base units (metered m³ → kWh for one fuel, country and
 * year), chosen by `resolveFactorPath`.
 */
export interface NormalizationConversion {
  category: string;
  fromUnit: string;
  toUnit: string;
  multiplier: number;
  basis: string;
}

/**
 * Normalise a raw activity value/unit to the unit the chosen factor is quoted
 * per: the definitional step to the unit family's base unit, then — only when
 * the resolver chose one for this category — the sourced conversion.
 *
 * Throws for a unit the engine does not recognise or cannot calculate, so
 * callers can surface a 400, and for a conversion that does not belong to
 * this category or does not start at this unit's base: a resolver defect,
 * never something to price through.
 */
export function normalize(
  value: number,
  unit: string,
  category: string,
  conversion: NormalizationConversion | null,
): NormalizationResult {
  const key = canonicalUnit(unit);
  const rule = UNIT_RULES[key];
  if (!rule) {
    throw new Error(`Unsupported unit "${unit}" for normalization`);
  }
  if ('blocked' in rule) {
    throw new Error(rule.blocked);
  }
  let normalizedValue = value * rule.multiplier;
  let normalizedUnit = rule.target;
  let multiplier = rule.multiplier;
  // Only the steps that changed something: a passthrough has no basis to
  // record, and an empty string would read as "basis unknown".
  const bases = rule.multiplier !== 1 ? [rule.basis] : [];
  if (conversion) {
    if (conversion.category !== category) {
      throw new Error(`A ${conversion.category} conversion cannot price a ${category} record`);
    }
    if (conversion.fromUnit !== normalizedUnit) {
      throw new Error(`A conversion from ${conversion.fromUnit} cannot follow ${unit} (${normalizedUnit})`);
    }
    normalizedValue *= conversion.multiplier;
    multiplier *= conversion.multiplier;
    normalizedUnit = conversion.toUnit;
    bases.push(conversion.basis);
  }
  const converted = bases.length > 0;
  return {
    normalizedValue,
    normalizedUnit,
    conversionApplied: converted,
    ...(converted ? { conversionFactor: multiplier, conversionBasis: bases.join(' Then: ') } : {}),
  };
}

/** The base unit a known unit normalises to by definition alone, or null. */
export function baseUnitOf(unit: string): string | null {
  const rule = UNIT_RULES[canonicalUnit(unit)];
  return rule ? rule.target : null;
}

/** The reason a recognised unit cannot be calculated, or null if it can. */
export function blockedUnitReason(unit: string): string | null {
  const rule = UNIT_RULES[canonicalUnit(unit)];
  return rule && 'blocked' in rule ? rule.blocked : null;
}
