// Unit normalization for the calculation engine.
//
// Source of truth: docs/md_docs/calculation_logic.md §2 (Unit Conversion and
// Normalisation). Raw activity data is converted to the base unit required by
// the factor before the emission factor is applied. Not every category is
// converted to energy units (§2.4): liquid fuels stay in litres, electricity /
// natural gas go to kWh, etc. Passthrough units (already the base unit) apply a
// multiplier of 1 and report conversionApplied = false.

export interface NormalizationResult {
  normalizedValue: number;
  normalizedUnit: string;
  /** true when a non-identity conversion factor was applied. */
  conversionApplied: boolean;
}

interface UnitRule {
  /** Base unit this input normalises to. */
  target: string;
  /** Multiply the input value by this to reach the base unit. */
  multiplier: number;
}

// Keyed by a canonical (lowercased, trimmed) unit alias. Values taken verbatim
// from calculation_logic.md §2 — do not invent conversion factors here.
const UNIT_RULES: Record<string, UnitRule> = {
  // --- Energy base unit: kWh ---
  kwh: { target: 'kWh', multiplier: 1 },
  // Natural gas -> kWh (§2.1)
  cubic_metres: { target: 'kWh', multiplier: 11.36 },
  therms: { target: 'kWh', multiplier: 29.3 },
  gj: { target: 'kWh', multiplier: 277.78 },
  // Electricity -> kWh (§2.3)
  mwh: { target: 'kWh', multiplier: 1000 },

  // --- Liquid fuel base unit: litres (§2.2) ---
  litres: { target: 'litres', multiplier: 1 },
  uk_gallons: { target: 'litres', multiplier: 4.546 },
  us_gallons: { target: 'litres', multiplier: 3.785 },

  // --- Categories that stay in their own unit (§2.4) ---
  passenger_kilometres: { target: 'passenger_kilometres', multiplier: 1 },
  kilometres: { target: 'kilometres', multiplier: 1 },
  tonnes: { target: 'tonnes', multiplier: 1 },
};

/** Common human/alias spellings mapped onto the canonical rule keys above. */
const UNIT_ALIASES: Record<string, string> = {
  kwh: 'kwh',
  'kw h': 'kwh',
  mwh: 'mwh',
  m3: 'cubic_metres',
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

/** Canonicalise a raw unit string: lowercase, trim, collapse whitespace. */
function canonicalUnit(unit: string): string {
  const cleaned = unit.trim().toLowerCase().replace(/\s+/g, '_');
  return UNIT_ALIASES[cleaned] ?? cleaned;
}

/** True if the engine knows how to normalise the given unit. */
export function isKnownUnit(unit: string): boolean {
  return canonicalUnit(unit) in UNIT_RULES;
}

/**
 * Normalise a raw activity value/unit to the base unit required by the factor.
 * Throws for units the engine does not recognise so callers can surface a 400.
 */
export function normalize(value: number, unit: string): NormalizationResult {
  const key = canonicalUnit(unit);
  const rule = UNIT_RULES[key];
  if (!rule) {
    throw new Error(`Unsupported unit "${unit}" for normalization`);
  }
  return {
    normalizedValue: value * rule.multiplier,
    normalizedUnit: rule.target,
    conversionApplied: rule.multiplier !== 1,
  };
}
