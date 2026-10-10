export type DataStatus = 'complete' | 'incomplete' | 'missing';

export interface CategoryData {
  category: string;
  status: DataStatus;
  lastUpdate: string | null;
  responsible: string;
  calculationComplete: boolean;
  emission: number | null;
  missingFields?: string[];
}

export interface Subsidiary {
  id: string;
  name: string;
  shortName: string;
  sector: string;
  totalEmissions: number;
  completionRate: number;
  categories: CategoryData[];
  notes?: string;
}

export interface ScopeEmissions {
  scope1: number;
  scope2: number;
  scope3: number;
  total: number;
  /** Percentage change vs prior period; null when no prior-period data exists. */
  scope1Trend: number | null;
  scope2Trend: number | null;
  scope3Trend: number | null;
  totalTrend: number | null;
}

export interface KPIData {
  totalSubsidiaries: number;
  /** null while the KPI endpoint hasn't loaded yet. */
  totalLocations: number | null;
  completedCategories: number;
  incompleteCategories: number;
  missingCategories: number;
  totalEmissions: number;
  calculationCompletionRate: number;
  emissions: ScopeEmissions;
}

// Category to Scope mapping
export const CATEGORY_SCOPE_MAP: Record<Category, 1 | 2 | 3> = {
  'Electricity': 2,
  'Natural Gas': 1,
  'Fuel': 1,
  'Mobile Combustion': 1,
  'Refrigerants': 1,
  'Purchased Goods': 3,
  'Waste': 3,
  'Water': 3,
  'Business Travel': 3,
  'Commuting': 3,
  'Logistics': 3,
};

export interface Alert {
  id: string;
  type: 'warning' | 'error' | 'info';
  message: string;
  subsidiary: string;
  category?: string;
  timestamp: string;
}

export const CATEGORIES = [
  'Electricity',
  'Natural Gas',
  'Fuel',
  'Mobile Combustion',
  'Refrigerants',
  'Purchased Goods',
  'Waste',
  'Water',
  'Business Travel',
  'Commuting',
  'Logistics',
] as const;

export type Category = typeof CATEGORIES[number];

// ---------------------------------------------------------------------------
// Activity units (WP15 / round-1 DE-3 + EM-1)
// ---------------------------------------------------------------------------

/**
 * A family of units that convert into each other by DEFINITION — exact
 * constants that never change and need no source (1 MWh = 1,000 kWh, 1 UK
 * gallon = 4.54609 L, 1 t = 1,000 kg).
 *
 * Crossing families is never a constant (LP3-03): a metered cubic metre of
 * natural gas becomes kWh through a calorific value that depends on the gas,
 * the country and the year, and a standard cubic metre is not a metered one.
 * Those steps are sourced, versioned `unit_conversions` rows carried into the
 * snapshot; where no row covers a record, the calculation is refused
 * (`no_conversion`), never approximated.
 */
export const UNIT_DIMENSIONS = [
  'energy',
  /** Liquid fuel as bought: litres, gallons. */
  'fuel_volume',
  /** A volume as a meter reads it, at actual conditions (gas or water). */
  'metered_volume',
  /** A gas volume corrected to stated reference conditions (Sm³). */
  'standard_volume',
  'distance',
  'passenger_distance',
  'mass',
] as const;

export type UnitDimension = (typeof UNIT_DIMENSIONS)[number];

/**
 * The one unit of each family a factor may be quoted per. A factor's value is
 * kg CO₂e per ONE of these — never per MWh or per gallon — so a definitional
 * step in code is all that ever stands between a record's unit and its
 * factor's, and a factor quoted per MWh cannot be read as one quoted per kWh.
 * A publisher's other units are converted at import and the derivation is
 * recorded in the row's `methodology`.
 */
export const DIMENSION_BASE_UNIT: Readonly<Record<UnitDimension, string>> = {
  energy: 'kWh',
  fuel_volume: 'litres',
  metered_volume: 'cubic_metres',
  standard_volume: 'standard_cubic_metres',
  distance: 'kilometres',
  passenger_distance: 'passenger_kilometres',
  mass: 'kg',
};

/**
 * The reference conditions of a standard cubic metre (ISO 13443), and the only
 * ones `standard_cubic_metres` means. A publisher's "per cubic metre"
 * combustion factor is never per METERED m³ — it derives from a calorific
 * value at stated conditions — so it is loaded per `standard_cubic_metres`
 * only when the publisher states exactly these; a metered reading reaches it
 * only through a sourced volume correction. A factor per NORMAL m³ (0 °C) is a
 * different quantity — about 5.5% more gas per m³ — and waits for a unit
 * family of its own; loaded as Sm³ it would overstate. Every conversion step
 * to or from `standard_cubic_metres` must state these conditions verbatim.
 */
export const STANDARD_REFERENCE_CONDITIONS = '15 °C, 101.325 kPa (ISO 13443)';

/**
 * Every unit a user may submit activity data in.
 *
 * One list, because there were three: the engine's conversion rules, the
 * engine's alias table and the Data Entry dropdown — which had already drifted
 * (the engine accepts `gj`, the dropdown never offered it).
 *
 * `target` is the base unit the value normalises to, and is what makes a
 * unit/factor mismatch detectable. `blocked` marks a unit that is offered but
 * cannot be calculated yet, so the UI can list it and the API can refuse it with
 * the same reason.
 */
export interface ActivityUnitSpec {
  value: string;
  label: string;
  /**
   * How the unit is written when it appears NEXT TO a value ("250 m³"), as
   * opposed to `label`, which names it in a dropdown ("Cubic metres — m³").
   *
   * Exists because the raw `value` was being printed to users: "Recorded as 250
   * cubic_metres" is a storage token, not a unit, and it reached the screen in
   * the places where a value and its unit are shown together.
   */
  symbol: string;
  /**
   * The unit the pre-LP3-03 engine normalised to — kept, unchanged, because
   * `appliesUnitConversion` and the Data Entry conversion note key on it.
   * `cubic_metres → kWh` here is the natural-gas path only. Which conversion a
   * calculation ACTUALLY applied is in its snapshot (`conversion` on a
   * `CalculationResultV2`), and that is what a screen should show.
   */
  target: 'kWh' | 'litres' | 'kilometres' | 'passenger_kilometres' | 'tonnes' | 'kg';
  /** The definitional family the unit belongs to (see `UNIT_DIMENSIONS`). */
  dimension: UnitDimension;
  /** Present when the unit is selectable but not yet calculable. */
  blocked?: string;
}

export const ACTIVITY_UNITS: readonly ActivityUnitSpec[] = [
  { value: 'kWh', label: 'kWh (electricity / gas)', symbol: 'kWh', target: 'kWh', dimension: 'energy' },
  { value: 'MWh', label: 'MWh (electricity)', symbol: 'MWh', target: 'kWh', dimension: 'energy' },
  {
    value: 'cubic_metres',
    // No parenthetical: the same token is offered for Natural Gas and for Water,
    // and it read as "Cubic metres — m³ (natural gas)" in the Water dropdown,
    // where it is the ONLY option. `target` describes the natural-gas path only;
    // a Water record is never normalised (see UncalculatedSnapshot).
    label: 'Cubic metres — m³',
    symbol: 'm³',
    target: 'kWh',
    dimension: 'metered_volume',
  },
  {
    // Round-1 DE-3/EM-1 asked for Sm³ alongside m³. It is listed rather than
    // hidden, because the request was to SEE it — but standard and actual cubic
    // metres are different physical quantities, and this repo holds no sourced
    // calorific value for the conversion. Inventing one would put a fabricated
    // number into an inventory, so it is offered and refused, with the reason.
    value: 'standard_cubic_metres',
    label: 'Standard cubic metres — Sm³ (natural gas)',
    symbol: 'Sm³',
    target: 'kWh',
    dimension: 'standard_volume',
    blocked:
      'Standard cubic metres need a sourced calorific value to become kWh, and this prototype does not have one yet — it arrives with the Phase-4 factor library. Enter the volume in m³, or the energy in kWh.',
  },
  { value: 'therms', label: 'Therms (natural gas)', symbol: 'therms', target: 'kWh', dimension: 'energy' },
  { value: 'gj', label: 'GJ (natural gas)', symbol: 'GJ', target: 'kWh', dimension: 'energy' },
  { value: 'litres', label: 'Litres (liquid fuel)', symbol: 'L', target: 'litres', dimension: 'fuel_volume' },
  { value: 'uk_gallons', label: 'UK gallons (liquid fuel)', symbol: 'UK gal', target: 'litres', dimension: 'fuel_volume' },
  { value: 'us_gallons', label: 'US gallons (liquid fuel)', symbol: 'US gal', target: 'litres', dimension: 'fuel_volume' },
  { value: 'kilometres', label: 'Kilometres', symbol: 'km', target: 'kilometres', dimension: 'distance' },
  {
    value: 'passenger_kilometres',
    label: 'Passenger-km',
    symbol: 'p-km',
    target: 'passenger_kilometres',
    dimension: 'passenger_distance',
  },
  { value: 'tonnes', label: 'Tonnes', symbol: 't', target: 'tonnes', dimension: 'mass' },
  // Refrigerant leakage is a mass (LP3-03): a refrigerant's factor is its GWP,
  // quoted per kilogram of that gas.
  { value: 'kg', label: 'Kilograms — kg', symbol: 'kg', target: 'kg', dimension: 'mass' },
] as const;

/**
 * Which units make sense for which category.
 *
 * Without this the only guard is the unit FAMILY check in the calc service, so
 * litres on Electricity is refused (litres vs kWh) while `therms` on Electricity
 * or `MWh` on Natural Gas sail straight through and produce a number — a silent
 * wrong figure rather than an error. The categories absent from this map are
 * the Scope 3 ones, outside the pilot: their unit is unconstrained, and the
 * factor import refuses their factors until they get an entry here (the e2e
 * suite's Waste fixture factor is written directly, not imported).
 */
export const CATEGORY_UNITS: Partial<Record<Category, readonly string[]>> = {
  Electricity: ['kWh', 'MWh'],
  // MWh belongs here: EU gas markets and industrial contracts quote gas in MWh
  // and MWh→kWh is exact, so excluding it would push a hand conversion outside
  // the system — the un-audited step this whole contract exists to remove.
  'Natural Gas': [
    'kWh',
    'MWh',
    'cubic_metres',
    'standard_cubic_metres',
    'therms',
    'gj',
  ],
  Fuel: ['litres', 'uk_gallons', 'us_gallons'],
  // Fuel-based first (LP3-03, T4): the fuel a fleet bought — litres of liquid
  // fuel, kilograms of CNG. Distance-based activity (km by vehicle class)
  // needs its own activity types and waits for the holding's source list (D05).
  'Mobile Combustion': ['litres', 'uk_gallons', 'us_gallons', 'kg'],
  // Leakage is reported as a mass of refrigerant, priced by that gas's GWP.
  Refrigerants: ['kg'],
  // Water is billed in cubic metres and has no factor yet, so nothing is
  // normalised or calculated from it (see UncalculatedSnapshot). Pinning the
  // unit anyway keeps the invoice figure comparable across locations — left
  // unconstrained, the same meter could be filed in litres, kWh or gallons.
  Water: ['cubic_metres'],
};

/**
 * The units offered for a category.
 *
 * A category with no factor yet is left unconstrained — the factor lookup will
 * refuse it anyway — except that it never offers a BLOCKED unit, since those are
 * guaranteed to be refused and listing them everywhere just invites the refusal.
 */
export function unitsForCategory(category: string): readonly ActivityUnitSpec[] {
  const allowed = CATEGORY_UNITS[category as Category];
  return allowed
    ? ACTIVITY_UNITS.filter((u) => allowed.includes(u.value))
    : ACTIVITY_UNITS.filter((u) => !u.blocked);
}

/**
 * How to write a unit beside a value. Falls back to the raw token for a unit
 * this build does not know, which is preferable to rendering nothing at all
 * next to a number.
 */
export function unitSymbol(unit: string): string {
  return ACTIVITY_UNITS.find((u) => u.value === unit)?.symbol ?? unit;
}

/**
 * True when the calculation engine will CONVERT this input before applying a
 * factor to it — i.e. when a UI may honestly say "m³ is converted to kWh".
 *
 * The category half is the part that was missing and it is not cosmetic. Data
 * Entry keyed its ×11.36 conversion note on the unit alone, which was correct
 * while `cubic_metres` meant natural gas and became false the moment Water
 * could be recorded: nothing about a water reading is converted, because with
 * no factor there is nothing to convert TOWARDS. The note was telling users
 * their water meter had been multiplied by the natural-gas calorific value.
 *
 * Blocked units convert nothing either — they are refused before any
 * arithmetic happens, with their own explanation.
 */
export function appliesUnitConversion(unit: string, category: string): boolean {
  if (isRecordableWithoutFactor(category)) return false;
  const spec = ACTIVITY_UNITS.find((u) => u.value === unit);
  if (!spec || spec.blocked) return false;
  return spec.value !== spec.target;
}

// ---------------------------------------------------------------------------
// Activity types (LP3-03; owner decision K1 = A1, 2026-10-04)
// ---------------------------------------------------------------------------

/**
 * WHAT was burned, bought or leaked within a category — diesel or petrol under
 * Mobile Combustion, R-410A or R-32 under Refrigerants.
 *
 * The category alone cannot price these: each fuel and each gas has its own
 * factor, so a record says which one it is and the factor library is keyed on
 * the same token. It is also part of a record's identity — the raw unique index
 * on `activity_records` ends `…, category, activity_type` — so diesel and
 * petrol for one site and month are two records, not one pre-summed figure.
 * Two meters of the SAME fuel at one site are summed on entry (K1).
 *
 * `value` is a storage token that records and factors key on, so it is never
 * renamed: a new fuel is a new entry. These lists are the structural starter
 * set; LP4-02 completes them from the holding's source list (D05) and the
 * releases it loads. Labels are English here; LP3-01's catalogues translate.
 */
export interface ActivityTypeSpec {
  value: string;
  label: string;
}

/**
 * The activity types a category's records and factors may name. Two kinds:
 *
 * - **implicit** (`implicit` set) — one activity covers the whole category:
 *   grid electricity, mains natural gas. A record stores NO activity type and
 *   the API refuses one: a typed and an untyped record would be different keys
 *   to the unique index, i.e. two "different" records for one meter. Its
 *   factors carry the implicit value.
 * - **typed** (no `implicit`) — a NEW record must name one of `types`
 *   (`activity_type_required` otherwise): an untyped and a typed record are
 *   different keys to the unique index, so one site and month could count the
 *   same fuel twice. A record with none is one written before LP3-03; it
 *   resolves to `UNSPECIFIED_ACTIVITY_TYPE`, which only a non-authoritative
 *   release may carry (`validateFactorReleaseImport`), so recalculating it is
 *   priced by a labelled placeholder where placeholders are allowed and
 *   refused everywhere else. A slot holds typed records or one untyped legacy
 *   record, never both.
 *
 * A category absent from the map (Scope 3, outside the pilot) takes no
 * activity type either and resolves to `UNSPECIFIED_ACTIVITY_TYPE`. No factor
 * of it can be imported at any status until it has an entry here and in
 * `CATEGORY_UNITS`.
 */
export interface CategoryActivityTypes {
  types: readonly ActivityTypeSpec[];
  implicit?: string;
}

/** What a record that names no activity resolves to in a typed category. */
export const UNSPECIFIED_ACTIVITY_TYPE = 'unspecified';

export const CATEGORY_ACTIVITY_TYPES: Partial<
  Record<Category, CategoryActivityTypes>
> = {
  Electricity: {
    implicit: 'grid_electricity',
    types: [{ value: 'grid_electricity', label: 'Grid electricity' }],
  },
  'Natural Gas': {
    implicit: 'natural_gas',
    types: [{ value: 'natural_gas', label: 'Natural gas' }],
  },
  Water: {
    implicit: 'water_supply',
    types: [{ value: 'water_supply', label: 'Water supply' }],
  },
  // Stationary combustion of fuels other than mains gas.
  //
  // `diesel` and `petrol` (here and under Mobile Combustion) mean the road
  // fuel as retailed in the record's geography — the average biofuel blend —
  // so every release maps them to that row and never to a 100%-mineral one;
  // `diesel_mineral` / `petrol_mineral` are reserved for that, if a source
  // ever needs it. `gas_oil` is the UK's off-road "red diesel"; `burning_oil`
  // is kerosene, which UK sites usually call heating oil (a literal Turkish
  // rendering of "gas oil" reads as kerosene — LP3-01's translators beware).
  Fuel: {
    types: [
      { value: 'diesel', label: 'Diesel' },
      { value: 'gas_oil', label: 'Gas oil (red diesel)' },
      { value: 'fuel_oil', label: 'Fuel oil' },
      { value: 'burning_oil', label: 'Burning oil (kerosene, heating oil)' },
      { value: 'lpg', label: 'LPG' },
    ],
  },
  'Mobile Combustion': {
    types: [
      { value: 'diesel', label: 'Diesel' },
      { value: 'petrol', label: 'Petrol' },
      { value: 'lpg', label: 'LPG' },
      { value: 'cng', label: 'CNG' },
    ],
  },
  // ASHRAE designations, written exactly so; an import canonicalises aliases
  // (R410A, HFC-134a) to them. HCFCs such as R-22 are absent on purpose: the
  // GHG Protocol treats Montreal Protocol gases as optional and reported
  // separately, outside the scopes. R-1234yf (fleet air conditioning) is an
  // HFO, outside the Kyoto basket too; it is listed so a fleet's leakage can be
  // recorded, and a release prices it only with a numeric GWP it states (AR5
  // gives "<1"), never one chosen at load.
  Refrigerants: {
    types: [
      { value: 'R-32', label: 'R-32' },
      { value: 'R-134a', label: 'R-134a' },
      { value: 'R-404A', label: 'R-404A' },
      { value: 'R-407C', label: 'R-407C' },
      { value: 'R-407F', label: 'R-407F' },
      { value: 'R-410A', label: 'R-410A' },
      { value: 'R-448A', label: 'R-448A' },
      { value: 'R-449A', label: 'R-449A' },
      { value: 'R-1234yf', label: 'R-1234yf' },
    ],
  },
};

/**
 * The activity types a RECORD of this category may name — empty for an
 * implicit or unmapped category, whose records name none.
 */
export function recordActivityTypesFor(
  category: string,
): readonly ActivityTypeSpec[] {
  const spec = categoryActivityTypes(category);
  return spec && !spec.implicit ? spec.types : [];
}

/**
 * The map's entry for a category — an OWN entry only. The helpers below see
 * caller-supplied categories before validation does, and `'constructor'` or
 * `'__proto__'` would otherwise reach an inherited property and throw.
 */
function categoryActivityTypes(category: string): CategoryActivityTypes | undefined {
  return Object.prototype.hasOwnProperty.call(CATEGORY_ACTIVITY_TYPES, category)
    ? CATEGORY_ACTIVITY_TYPES[category as Category]
    : undefined;
}

/**
 * May a record of this category carry this activity type? No activity type is
 * always acceptable at this layer (see `CategoryActivityTypes`); a named one
 * must belong to a typed category's list.
 */
export function isRecordActivityTypeAllowed(
  category: string,
  activityType: string | null | undefined,
): boolean {
  if (activityType === null || activityType === undefined) return true;
  return recordActivityTypesFor(category).some((t) => t.value === activityType);
}

/**
 * The activity type the factor lookup uses for a record: its own, else its
 * category's implicit one, else `UNSPECIFIED_ACTIVITY_TYPE`.
 */
export function factorActivityTypeFor(
  category: string,
  recordActivityType: string | null | undefined,
): string {
  return (
    recordActivityType ??
    categoryActivityTypes(category)?.implicit ??
    UNSPECIFIED_ACTIVITY_TYPE
  );
}


// Data Entry Types
// Canonical 4-role enum (aligned with docs/tech_docs technical_analysis.md §4 and Prisma user_role)
export type UserRole = 'super_admin' | 'consultant' | 'data_entry' | 'executive_viewer';

/**
 * May this user author activity records — create, edit, delete, submit, and
 * attach or remove their evidence? One rule, used by the API's record and
 * evidence services and by every screen that offers those controls.
 *
 * A consultant is NOT a writer (decision 2026-07-30): the seat is advisory —
 * review, anomaly flagging, guidance — and is typically held by someone outside
 * the holding company. A function rather than an exported set, so the rule
 * cannot be widened at runtime by a caller.
 */
export function mayAuthorRecords(
  user: { role: string } | null | undefined,
): boolean {
  return !!user && (user.role === 'data_entry' || user.role === 'super_admin');
}

export type SubmissionStatus = 'draft' | 'submitted' | 'in_review' | 'approved' | 'revision_requested';

/**
 * Accepted reporting years, independently of factor availability (LP3-02).
 * Preserve the API's inclusive 2000–2100 range. Selection never promises
 * coverage: D07 still refuses a calculation without its activity-year factor.
 */
export const REPORTING_YEAR_MIN = 2000;
export const REPORTING_YEAR_MAX = 2100;
/** A wire number; validate unknown input with isReportingYear, never a cast. */
export type ReportingYear = number;
export const REPORTING_YEARS: readonly ReportingYear[] = Object.freeze(
  Array.from({ length: REPORTING_YEAR_MAX - REPORTING_YEAR_MIN + 1 },
    (_, index) => REPORTING_YEAR_MAX - index),
);
/** D06: first close is 2026; neither list order nor New Year's Day changes it. */
export const DEFAULT_REPORTING_YEAR: ReportingYear = 2026;

export const isReportingYear = (value: unknown): value is ReportingYear =>
  typeof value === 'number' && Number.isInteger(value) &&
  value >= REPORTING_YEAR_MIN && value <= REPORTING_YEAR_MAX;

/**
 * One annual inventory selection (LP3-02, owner decisions 2026-10-10).
 * The URL is authoritative; refreshes, navigation and exports retain these
 * fields. Resolve EACH field in order: a valid explicit URL value; otherwise
 * its remembered selection, if any; otherwise DEFAULT_REPORTING_YEAR for year,
 * all accessible subsidiaries for subsidiaryId, and no scope/category filter.
 * Write the resolved year into the canonical URL. An invalid explicit URL
 * value is refused, never replaced by remembered state or a default. Duplicate
 * URL keys and a resolved category/scope conflict are validation failures too.
 *
 * Omitted subsidiaryId means ALL ACCESSIBLE subsidiaries, not necessarily the
 * whole organisation. A selected subsidiary includes its company- and site-
 * attributed records; it is not a company-only or site selector. Every API
 * request rechecks access; an inaccessible selection stays empty, never falls
 * back to the accessible set. Selection is not authorisation.
 *
 * Scope/category are AND-combined inventory filters. Search, record status,
 * sort, target comparison years and export formatting are view-local options,
 * not inventory filters. D11–D13 attribution, applicability and final/PARTIAL
 * semantics are not changed by a context or a filtered view.
 */
export interface ReportingContext {
  year: ReportingYear;
  subsidiaryId?: string;
  scope?: 1 | 2 | 3;
  category?: Category;
}

/** Legacy summary alone permits an omitted year for explicit history views.
 * Annual consumers use ReportingContext. Targets retain their own baseline,
 * target and actual progress years and only inherit the subsidiary selection. */
export type EmissionsSummaryParams = Partial<ReportingContext>;

export const REPORTING_CONTEXT_KEYS = ['year', 'subsidiaryId', 'scope', 'category'] as const satisfies readonly (keyof ReportingContext)[];
const _noMissingReportingContextKey: never = null as unknown as
  Exclude<keyof ReportingContext, (typeof REPORTING_CONTEXT_KEYS)[number]>;
void _noMissingReportingContextKey;

/** Validate the context only, not access or available factor coverage. */
export const isReportingContext = (value: unknown): value is ReportingContext => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  if (Object.keys(context).some((key) => !(REPORTING_CONTEXT_KEYS as readonly string[]).includes(key))) return false;
  if (!isReportingYear(context.year)) return false;
  if (context.subsidiaryId !== undefined &&
      (typeof context.subsidiaryId !== 'string' || !context.subsidiaryId.trim())) return false;
  if (context.scope !== undefined && ![1, 2, 3].includes(context.scope as number)) return false;
  if (context.category !== undefined && !(CATEGORIES as readonly unknown[]).includes(context.category)) return false;
  return context.scope === undefined || context.category === undefined ||
    CATEGORY_SCOPE_MAP[context.category as Category] === context.scope;
};

/** Servers echo the request verbatim: absent keys omitted, never null; scope
 * never derived from category; numbers remain numbers. Strict acknowledgement,
 * including omitted filters. An omitted subsidiary
 * must not acknowledge a requested subsidiary, even when its result is empty. */
export const matchesReportingContext = (value: unknown, expected: ReportingContext): boolean =>
  isReportingContext(value) && isReportingContext(expected) &&
  REPORTING_CONTEXT_KEYS.every((key) => value[key] === expected[key]);

/**
 * Additive, dormant routes until LP3-02's API implementation lands. Separate
 * paths make an older API refuse with 404 instead of silently ignoring filters
 * (the legacy intensity controller ignores unknown query keys). Existing
 * clients/routes keep their old envelopes. No CORS/header negotiation needed
 * for binary exports: only the new paths implement this contract.
 * Before activating pdf/excel/csv, classify these paths as EXPORT under #160,
 * with the export quota and reports concurrency lease. Derive the EXPORT set
 * from this constant plus the legacy paths, and test routeGroup for both sets.
 * The legacy exact-path regex would otherwise classify context exports READ.
 */
export const REPORTING_CONTEXT_API_PATHS = {
  summary: '/emissions/context/summary',
  matrix: '/emissions/context/tracking-matrix',
  intensity: '/intensity/context',
  meta: '/reports/context/meta',
  pdf: '/reports/context/pdf',
  excel: '/reports/context/excel',
  csv: '/reports/context/csv',
} as const;

/** Filter acknowledgement, NOT a database snapshot or completeness guarantee.
 * Even an empty result echoes the requested context without disclosing whether
 * a selected subsidiary exists. The data is always tenant-scoped. */
export interface ReportingContextResponse<T> {
  context: ReportingContext;
  data: T;
}

/** Filter records AND emitted matrix cells by scope/category, then recompute
 * per row: totalTCo2e, uncalculatedRecordCount, completeCount, categoryCount;
 * overall totals: { complete, incomplete, missing }.
 * reportingYear must equal context.year. Filtering records
 * alone would manufacture missing obligations. Existing cell coverage rules
 * remain unchanged; a filtered matrix cannot certify a full inventory. */
export type ReportingMatrixResponse = ReportingContextResponse<TrackingMatrixDTO>;
export type ReportingSummaryResponse = ReportingContextResponse<EmissionsSummary>;
export type ReportingMetaResponse = ReportingContextResponse<ReportMetaDTO>;

/** Each format, its preview/meta and its audit apply the same context to
 * committed AND withdrawn ledgers, totals, notes and labels. No recalculation
 * of historical snapshots; no all-year export. Legacy ReportParams stay intact
 * until callers move to the additive context routes. */
export interface ReportingExportParams extends ReportingContext {
  template: ReportTemplate;
  includeMethodologyNotes?: boolean;
  includeEvidenceSummary?: boolean;
}

export const REPORTING_PERIODS = ['monthly', 'quarterly', 'annual'] as const;
export type ReportingPeriod = (typeof REPORTING_PERIODS)[number];

/**
 * The canonical `periodValue` vocabulary, per granularity — the spelling a
 * record is STORED with, not merely one the API accepts.
 *
 * It lives here because six hand-written copies of it existed, in two different
 * casings: the validator and the anomaly ordering kept lower-case lists, the
 * emissions module kept one of each, and the two dropdowns and the seed kept
 * Title Case. Nothing reconciled them, and "canonicalise on write" is not a
 * thing that can be said at all until one of them is the answer.
 *
 * `annual` is the literal token `Annual`, deliberately NOT the year: the year
 * already has its own column, and a `periodValue` that sometimes held it would
 * make the uniqueness key mean two different things.
 */
export const PERIOD_VALUES = {
  monthly: [
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
  ],
  quarterly: ['Q1', 'Q2', 'Q3', 'Q4'],
  annual: ['Annual'],
} as const satisfies Record<ReportingPeriod, readonly string[]>;

// `as const` is compile-time only, and this list now decides record identity.
// Annotating it `Record<ReportingPeriod, readonly string[]>` had thrown the
// literals away AND left whole-property assignment legal — `PERIOD_VALUES.monthly
// = ['Nope']` typechecked.
Object.freeze(PERIOD_VALUES);
for (const values of Object.values(PERIOD_VALUES)) Object.freeze(values);

/**
 * The twelve month names in calendar order — the index IS the month number.
 *
 * Order is LOAD-BEARING, not presentational: it drives month→quarter
 * attribution, the monthly trend sort key, and the anomaly baseline's period
 * ordering. Asserted element by element in this package's spec, because a
 * swapped pair changes emissions attribution and nothing else would notice.
 */
export const MONTH_NAMES = PERIOD_VALUES.monthly;

/**
 * The canonical spelling of a `periodValue`, or `null` when it names no period
 * of that granularity.
 *
 * Tolerant on the way in (case-insensitive, trims) and exact on the way out, so
 * a caller sending `" JANUARY "` stores `January`. That asymmetry is the whole
 * point: the uniqueness index compares raw strings, so every spelling the API
 * accepted used to occupy a SEPARATE slot — `"january"` and `"January"` were
 * two rows for one month, and both counted towards the emissions inventory.
 * Period locks compare raw strings too, so a lock on one spelling did not close
 * the other.
 *
 * Canonicalise at every write. Validation alone is not enough; it was already
 * case-insensitive, and that is exactly how the two spellings both got in.
 */
export function canonicalPeriodValue(
  reportingPeriod: string,
  periodValue: string,
): string | null {
  const wanted = periodValue.trim().toLowerCase();
  // `Array.isArray`, not a truthiness check: `PERIOD_VALUES` inherits
  // `Object.prototype`, so `reportingPeriod` of `constructor`, `toString`,
  // `valueOf`, `hasOwnProperty` or `__proto__` returns something truthy that is
  // not an array, and `.find` then throws. `reporting_period` is a plain text
  // column and this function is exported, so "the DTO validates it" is not a
  // property this function may assume about its own inputs.
  const allowed: readonly string[] | undefined =
    PERIOD_VALUES[reportingPeriod as ReportingPeriod];
  if (!Array.isArray(allowed)) return null;
  return allowed.find((v) => v.toLowerCase() === wanted) ?? null;
}


export interface DataEntryField {
  id: string;
  name: string;
  type: 'number' | 'text' | 'select' | 'date' | 'file' | 'textarea';
  label: string;
  placeholder?: string;
  required: boolean;
  unit?: string;
  options?: string[];
  helperText?: string;
  value?: string | number | null;
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
  };
}

export interface FieldGroup {
  id: string;
  name: string;
  description?: string;
  fields: DataEntryField[];
}

export interface CalculationPreview {
  activityData: number;
  activityUnit: string;
  emissionFactor: number;
  emissionFactorUnit: string;
  estimatedEmissions: number;
  emissionsUnit: string;
  methodology?: string;
}

export interface Comment {
  id: string;
  author: string;
  role: UserRole;
  content: string;
  timestamp: string;
}

export interface VersionHistoryEntry {
  id: string;
  version: number;
  author: string;
  timestamp: string;
  changes: string;
  status: SubmissionStatus;
}

export interface DataSubmission {
  id: string;
  reportingYear: number;
  reportingPeriod: ReportingPeriod;
  periodValue: string; // e.g., "Q1", "January", "Annual"
  subsidiaryId: string;
  subsidiaryName: string;
  locationId: string;
  locationName: string;
  category: Category;
  status: DataStatus;
  submissionStatus: SubmissionStatus;
  responsibleUser: string;
  lastSaved: string;
  fieldGroups: FieldGroup[];
  calculationPreview?: CalculationPreview;
  comments: Comment[];
  versionHistory: VersionHistoryEntry[];
  attachments: string[];
}

// Subsidiary & Location Management Types
export type SubsidiaryStatus = 'active' | 'inactive' | 'pending';

/**
 * How completeness is measured for one subsidiary (WP17 / round-1 DE-2 + DASH-3).
 *
 * `subsidiary` — a category is complete once it holds a committed record with
 *   its evidence, whichever entity that record names. The behaviour every row
 *   had before WP17, and the default.
 * `location`  — the invoice rule: each invoice-tracked category expects one
 *   monthly invoice per LOCATION, so the denominator is `locations × 12`.
 *
 * An explicit setting rather than an inference from "does this subsidiary own
 * locations". Measured before choosing: 96 of the 102 seeded records carry no
 * `locationId` at all, so an automatic rule would report almost every existing
 * tenant as incomplete overnight and leave the user no way to see why.
 */
export const TRACKING_GRANULARITIES = ['subsidiary', 'location'] as const;
export type TrackingGranularity = (typeof TRACKING_GRANULARITIES)[number];

export interface Location {
  id: string;
  name: string;
  address: string;
  activityDescription: string;
  generalInfo: string;
  authorizedPerson: string;
  email: string;
  department: string;
  createdAt: string;
  updatedAt: string;
}

export interface CapacityReport {
  fileName: string;
  fileSize: number;
  uploadedAt: string;
  uploadedBy: string;
}

export interface SubsidiaryCompany {
  id: string;
  // Company Information
  officialName: string;
  country: string;
  city: string;
  postalCode: string;
  address: string;
  // Activity Information
  naceCode: string;
  naceDescription: string;
  capacityReport: CapacityReport | null;
  // Contact Information
  authorizedRepresentative: string;
  representativeContact: string;
  // Organizational Structure
  hasMultipleLocations: boolean;
  locations: Location[];
  hasChildSubsidiaries: boolean;
  childSubsidiaryCount: number;
  // Metadata
  status: SubsidiaryStatus;
  createdAt: string;
  updatedAt: string;
}

// NACE Code lookup
export interface NaceCode {
  code: string;
  description: string;
}

export const NACE_CODES: NaceCode[] = [
  { code: 'A01', description: 'Crop and animal production, hunting and related service activities' },
  { code: 'B05', description: 'Mining of coal and lignite' },
  { code: 'B06', description: 'Extraction of crude petroleum and natural gas' },
  { code: 'C10', description: 'Manufacture of food products' },
  { code: 'C19', description: 'Manufacture of coke and refined petroleum products' },
  { code: 'C20', description: 'Manufacture of chemicals and chemical products' },
  { code: 'C24', description: 'Manufacture of basic metals' },
  { code: 'C25', description: 'Manufacture of fabricated metal products' },
  { code: 'C27', description: 'Manufacture of electrical equipment' },
  { code: 'C29', description: 'Manufacture of motor vehicles, trailers and semi-trailers' },
  { code: 'D35', description: 'Electricity, gas, steam and air conditioning supply' },
  { code: 'E36', description: 'Water collection, treatment and supply' },
  { code: 'E38', description: 'Waste collection, treatment and disposal activities' },
  { code: 'F41', description: 'Construction of buildings' },
  { code: 'F42', description: 'Civil engineering' },
  { code: 'G45', description: 'Wholesale and retail trade of motor vehicles' },
  { code: 'G46', description: 'Wholesale trade, except of motor vehicles' },
  { code: 'G47', description: 'Retail trade, except of motor vehicles' },
  { code: 'H49', description: 'Land transport and transport via pipelines' },
  { code: 'H50', description: 'Water transport' },
  { code: 'H51', description: 'Air transport' },
  { code: 'H52', description: 'Warehousing and support activities for transportation' },
  { code: 'J61', description: 'Telecommunications' },
  { code: 'J62', description: 'Computer programming, consultancy and related activities' },
  { code: 'K64', description: 'Financial service activities' },
  { code: 'L68', description: 'Real estate activities' },
  { code: 'M69', description: 'Legal and accounting activities' },
  { code: 'M70', description: 'Activities of head offices; management consultancy activities' },
  { code: 'N77', description: 'Rental and leasing activities' },
  { code: 'O84', description: 'Public administration and defence' },
];

export const DEPARTMENTS = [
  'Operations',
  'Finance',
  'Human Resources',
  'Engineering',
  'Production',
  'Logistics',
  'Quality Control',
  'Research & Development',
  'Sales',
  'Marketing',
  'IT',
  'Administration',
  'Maintenance',
  'Environmental Health & Safety',
] as const;

export const COUNTRIES = [
  'Turkey',
  'Germany',
  'United Kingdom',
  'France',
  'Italy',
  'Spain',
  'Netherlands',
  'Belgium',
  'Austria',
  'Switzerland',
  'Poland',
  'Czech Republic',
  'Romania',
  'Bulgaria',
  'Greece',
  'Portugal',
  'Sweden',
  'Norway',
  'Denmark',
  'Finland',
  'United States',
  'Canada',
  'China',
  'Japan',
  'South Korea',
  'India',
  'Brazil',
  'Mexico',
  'Australia',
  'United Arab Emirates',
] as const;

// Emissions Analysis Types
export type EmissionsScope = 'all' | 'scope1' | 'scope2' | 'scope3';
export type DataViewMode = 'absolute' | 'intensity';
// NOTE: `EmissionsRecordStatus` and `EmissionsRecord` lived here and were
// deleted in WP7 PR 3. They had zero consumers and restated the record
// lifecycle with the SAME six members as `ActivityRecordStatus` — a second
// source of truth for the lifecycle, one autocomplete slip away from being
// picked in place of the real one.

export interface CategoryEmissions {
  category: Category;
  scope: 1 | 2 | 3;
  absoluteEmissions: number;
  percentOfTotal: number;
  dataQualityScore: number; // 0-100
  recordCount: number;
}

export interface TrendDataPoint {
  period: string;
  scope1: number;
  scope2: number;
  scope3: number;
  total: number;
  target?: number;
  baseline?: number;
}

export interface IntensityMetric {
  id: string;
  name: string;
  unit: string;
  value: number;
}

export const INTENSITY_METRICS: IntensityMetric[] = [
  { id: 'area', name: 'Area', unit: 'm²', value: 125000 },
  { id: 'revenue', name: 'Revenue', unit: 'M EUR', value: 450 },
  { id: 'headcount', name: 'Headcount', unit: 'FTE', value: 2850 },
  { id: 'production', name: 'Production Output', unit: 'units', value: 1250000 },
];

// Report Types (WP6 — live report generation, FR §5)
// Phase 1 ships two templates; Subsidiary Comparison and Supplier ESG Scorecard
// are Phase 3 (no suppliers module; comparison is a thin summary variant).
export type ReportTemplate = 'executive_summary' | 'ghg_protocol_detail';
export type ReportStatus = 'approved' | 'draft' | 'contains_incomplete_data';
export type ReportExportType = 'pdf' | 'excel' | 'csv';

/** Filter-aware report parameters (FR §5.3) — v1 reports are year-scoped. */
export interface ReportParams {
  template: ReportTemplate;
  year: number;
  subsidiaryId?: string; // omitted = whole accessible organisation
  includeMethodologyNotes?: boolean;
  includeEvidenceSummary?: boolean; // filenames + counts, never signed URLs (they expire)
}

export const REPORT_TEMPLATES: { id: ReportTemplate; name: string; description: string }[] = [
  { id: 'executive_summary', name: 'Executive Summary', description: 'High-level overview for leadership reporting' },
  { id: 'ghg_protocol_detail', name: 'GHG Protocol Detail', description: 'Detailed breakdown following GHG Protocol standards' },
];

/** Completeness/status meta for the report preview badge (GET /reports/meta). */
export interface ReportMetaDTO {
  /** PR B publishes the configured positive safe-integer export row budget.
   * Compare committedCount + voidedCount against this limit, not totalCount:
   * exports count committed and withdrawn rows together. Absent on pre-PR-B servers;
   * absence is unknown, never unlimited. The export rechecks current limits and
   * authorized data; this preview does not reserve capacity or promise success. */
  recordLimit?: number;
  status: ReportStatus;
  organisationName: string;
  totalCount: number;
  committedCount: number;
  incompleteCount: number; // draft + rejected
  pendingCount: number; // submitted + under_review
  incompleteRatio: number; // 0-1
  /**
   * Records withdrawn from this reporting year (`voided`).
   *
   * Deliberately NOT part of `totalCount` — `committed + incomplete` is meant
   * to exhaust it, and a withdrawn figure belongs to neither. It is reported
   * separately because the alternative, which shipped, was an export that
   * silently omitted withdrawn records without saying it had: a restatement
   * the reader cannot see is not a restatement.
   */
  voidedCount: number;
}

// Target Types
export type TargetStatus = 'on_track' | 'at_risk' | 'off_track';
export type TargetBasis = 'science_based' | 'internal_annual' | 'baseline_reduction';

export interface EmissionsTarget {
  id: string;
  name: string;
  basis: TargetBasis;
  baselineYear: number;
  baselineEmissions: number;
  targetYear: number;
  targetEmissions: number;
  reductionPercent: number;
  scope: 'all' | 'scope1' | 'scope2' | 'scope3';
}

export interface TargetProgress {
  targetId: string;
  currentEmissions: number;
  targetEmissions: number;
  baselineEmissions: number;
  varianceToTarget: number;
  progressPercent: number;
  status: TargetStatus;
}

// --- Targets & intensity (WP5) — live, backed by the API/DB -----------------
// Canonical DTOs (the interfaces above are the earlier org-level mock, still
// referenced by the not-yet-migrated reports page; superseded here).

/** An emission-reduction target for one subsidiary. `reductionPercent` is derived. */
export interface TargetDTO {
  id: string;
  subsidiaryId: string;
  name: string;
  basis: TargetBasis;
  scope: EmissionsScope; // 'all' | 'scope1' | 'scope2' | 'scope3'
  baselineYear: number;
  baselineTCo2e: number;
  targetYear: number;
  targetTCo2e: number;
  reductionPercent: number; // (baseline - target) / baseline * 100
  createdBy: string;
  createdAt: string;
}

export interface CreateTargetInput {
  subsidiaryId: string;
  name: string;
  basis: TargetBasis;
  scope: EmissionsScope;
  baselineYear: number;
  baselineTCo2e: number;
  targetYear: number;
  targetTCo2e: number;
}

export type UpdateTargetInput = Partial<Omit<CreateTargetInput, 'subsidiaryId'>>;

/**
 * Live target progress, computed from committed activity records. `currentTCo2e`
 * / `progressPercent` / `status` are `null` when no post-baseline year has
 * committed data yet — an honest "n/a" instead of a placeholder 0%.
 */
export interface TargetProgressDTO {
  targetId: string;
  currentYear: number;
  currentTCo2e: number | null;
  progressPercent: number | null;
  status: TargetStatus | null;
}

/** The spec's four intensity denominators (emissions_page.md §2). */
export type IntensityMetricKey =
  | 'area'
  | 'revenue'
  | 'headcount'
  | 'production_output'
  | 'sales_output';

export const INTENSITY_METRIC_KEYS: IntensityMetricKey[] = [
  'area',
  'revenue',
  'headcount',
  'production_output',
  'sales_output',
];

export const INTENSITY_METRIC_META: Record<
  IntensityMetricKey,
  { label: string; defaultUnit: string }
> = {
  area: { label: 'Area', defaultUnit: 'm²' },
  revenue: { label: 'Revenue', defaultUnit: 'M EUR' },
  headcount: { label: 'Headcount', defaultUnit: 'FTE' },
  production_output: { label: 'Production output', defaultUnit: 'units' },
  // Round-1 EM-1. The tester asked for "sales output" and to "focus on
  // energy-sector metrics", and the docs give no unit — MWh of energy sold was
  // the product owner's call (2026-08-13). The unit stays editable per
  // denominator, so a non-energy subsidiary can record something else.
  sales_output: { label: 'Sales output', defaultUnit: 'MWh' },
};

/** A configured intensity denominator for one subsidiary + year + metric. */
export interface DenominatorDTO {
  id: string;
  subsidiaryId: string;
  year: number;
  metric: IntensityMetricKey;
  value: number;
  unit: string;
  createdBy: string;
  createdAt: string;
}

export interface CreateDenominatorInput {
  subsidiaryId: string;
  year: number;
  metric: IntensityMetricKey;
  value: number;
  unit: string;
}

export type UpdateDenominatorInput = Partial<Pick<CreateDenominatorInput, 'value' | 'unit'>>;

/** One metric's emissions intensity for a year (GET /intensity). */
export interface IntensityMetricResultDTO {
  metric: IntensityMetricKey;
  unit: string;
  emissionsTotal: number;
  denominatorTotal: number;
  intensity: number; // emissionsTotal / denominatorTotal
}

export interface IntensityResponseDTO {
  year: number | null;
  metrics: IntensityMetricResultDTO[]; // empty → Intensity toggle stays disabled
}

/** D14: revenue is the only monetary metric in the current vocabulary.
 * Physical metrics require an explicitly selected subsidiary, even when an
 * all-accessible selection happens to contain only one subsidiary. Different
 * monetary units are separate groups; this contract performs no FX conversion. */
export const GROUP_INTENSITY_METRICS = ['revenue'] as const satisfies readonly IntensityMetricKey[];

export interface ReportingIntensityMetric extends IntensityMetricResultDTO {
  /** Authorized subsidiaries with this exact metric/unit denominator. The
   * numerator includes ONLY their committed emissions for the selected year,
   * scope and category. The denominator is annual and is never prorated by
   * scope/category. Missing denominators exclude a subsidiary, not a zero. */
  contributingSubsidiaryIds: string[];
  /** Non-negative safe integer: committed records of the contributing
   * subsidiaries, for the same year/scope/category, excluded from emissionsTotal
   * because they have no usable figure. The whole-selection summary's count
   * cannot substitute for this numerator-specific coverage disclosure. */
  uncalculatedRecordCount: number;
}

/** Empty access or an inaccessible selection yields empty ids and metrics.
 * Every contributing id is unique and belongs to selectedSubsidiaryIds; the
 * difference names missing denominator coverage for that metric/unit. No
 * claim that the metric's numerator equals the whole group's absolute total.
 * Metric/unit pairs are unique. For one metric, contributors cannot overlap
 * across units: each subsidiary has one denominator per year and metric. */
export interface ReportingIntensityData {
  selectedSubsidiaryIds: string[];
  metrics: ReportingIntensityMetric[];
}
export type ReportingIntensityResponse = ReportingContextResponse<ReportingIntensityData>;

// Scope subcategory mappings for Summary chart
export const SCOPE1_SUBCATEGORIES = [
  'Stationary Combustion',
  'Mobile Combustion',
  'Process Emissions',
  'Fugitive Emissions',
] as const;

export const SCOPE2_SUBCATEGORIES = [
  'Purchased Electricity',
  'Purchased Heating',
  'Purchased Cooling',
  'Purchased Steam',
] as const;

export const SCOPE3_SUBCATEGORIES = [
  'Purchased Goods & Services',
  'Capital Goods',
  'Business Travel',
  'Employee Commuting',
  'Waste Generated',
  'Upstream Transportation',
  'Downstream Transportation',
  'Investments',
] as const;

// ---------------------------------------------------------------------------
// Locales (LP3-01)
// ---------------------------------------------------------------------------

/**
 * The languages the product speaks. `profiles.language` holds one of these
 * (a CHECK constraint since LP3-01), and so does the web's locale cookie.
 *
 * A locale changes how a value is SHOWN and how a typed one is READ — never
 * what is stored or sent: the wire carries JSON numbers, ISO dates and the
 * canonical vocabularies (`PERIOD_VALUES`, `CATEGORIES`) in every locale (D15).
 */
export const SUPPORTED_LOCALES = ['en', 'tr'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * The BCP 47 tag each locale formats numbers and dates with. English is
 * British English — a UK product, and what every screen formatted with before
 * LP3-01 (`'en-GB'`).
 */
export const LOCALE_FORMAT_TAGS: Readonly<Record<Locale, string>> = Object.freeze({
  en: 'en-GB',
  tr: 'tr-TR',
});

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** PATCH /api/v1/me/preferences — the caller's own preferences. */
export interface UpdatePreferencesRequest {
  language: Locale;
}

// ---------------------------------------------------------------------------
// API contract types (backend <-> frontend) — Milestone 1 vertical slice
// ---------------------------------------------------------------------------

/** Authenticated user as returned by GET /api/v1/me */
export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  organisationId: string | null;
  accessibleSubsidiaryIds: string[];
  /** The UI language the user chose — `en` until they choose. */
  language: Locale;
  theme: string;
}

/** Subsidiary row as returned/accepted by the API (DB-shaped, not the UI view model). */
export interface SubsidiaryDTO {
  id: string;
  organisationId: string;
  legalName: string;
  tradingName: string | null;
  location: string | null;
  geographyCode: string;
  businessArea: string | null;
  sector: string | null;
  /**
   * The OPERATIONAL reporting contact for this entity — who to reach about its
   * data. In ISO 14064-1 §9.3.1 terms this is the preparer/coordinator, and it
   * is explicitly NOT the "responsible party" of ISO 14064-3, i.e. whoever
   * signs off the GHG assertion.
   *
   * Named now because the distinction is cheap to state and expensive to
   * recover: TonyAI already encodes it in the workflow (`data_entry` prepares,
   * `super_admin` approves), but this record carries no role, so once UAT
   * testers start filling it — some meaning "who to chase for data", others
   * meaning "who signs it off" — no migration could tell the two apart. A
   * future `responsibleParty*` field is then an addition, not a reinterpretation.
   *
   * Current state, not history: an inventory is per-period but this column is
   * not, so a report that ever prints the contact would show today's person
   * against an older year. Nothing reads it that way today — the only consumer
   * renders it as "responsible" in the tracking matrix.
   *
   * `designatedPerson` predates the other two and had no write path until WP16,
   * which is why every seeded row said the literal string "Seed Admin".
   */
  designatedPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  reportingStatus: SubsidiaryStatus;
  includedScopes: number[];
  /** How this subsidiary's completeness is measured (WP17). */
  trackingGranularity: TrackingGranularity;
  createdAt: string;
  updatedAt: string;
}

/**
 * Upper bound on locations supplied in ONE subsidiary create.
 *
 * A transaction bound, not a product one: each location is two sequential
 * statements inside a single interactive transaction, so a large array becomes
 * thousands of round trips. Measured — 2000 locations ran in ~1s locally, but
 * at a managed database's 5-15ms RTT the same payload takes 20-60s and blows
 * Prisma's default 5s timeout while holding a pooled connection.
 *
 * Here rather than in the API's DTO so the create form can enforce the same
 * number. A cap the client cannot see is a 400 that arrives after the user has
 * already typed the rows.
 */
export const MAX_LOCATIONS_PER_CREATE = 50;

export interface CreateSubsidiaryInput {
  legalName: string;
  tradingName?: string | null;
  location?: string | null;
  geographyCode: string;
  businessArea?: string | null;
  sector?: string | null;
  designatedPerson?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  reportingStatus?: SubsidiaryStatus;
  includedScopes?: number[];
  /**
   * Defaults to `subsidiary`. Setting `location` requires at least one
   * location — supplied inline here, or already present when this arrives via
   * PATCH — because the denominator is `locations × 12` and a zero multiplier
   * makes a subsidiary with no data whatsoever read as complete.
   */
  trackingGranularity?: TrackingGranularity;
  /**
   * Operational locations to create with the subsidiary, in one transaction.
   *
   * Note the neighbour: `location` (singular, above) is a free-text address
   * line on the subsidiary itself and has nothing to do with these rows. They
   * are one keystroke apart, so read the plural as "the `locations` table".
   *
   * Optional here even though the create FORM requires at least one — making it
   * mandatory would be a breaking change for every existing caller, and a
   * holding entity with no distinct site is a real thing.
   */
  locations?: CreateSubsidiaryLocationInput[];
}

/**
 * `locations` is omitted deliberately. `PATCH /subsidiaries/:id` rejects it with
 * a 400 (`UpdateSubsidiaryDto` is hand-written, not derived), so leaving it in
 * would let a typed client write code that compiles and fails at runtime —
 * especially easy here, where `location` and `locations` are one keystroke
 * apart. Locations are managed through `/locations`.
 */
export type UpdateSubsidiaryInput = Omit<Partial<CreateSubsidiaryInput>, 'locations'>;

/**
 * Everything hanging off one subsidiary, counted server-side.
 *
 * Two jobs, both of which the API could not do before. First, showing "36
 * records" without downloading 36 records — `GET /activity-records` is not
 * paginated. Second, answering *why* a subsidiary cannot be deleted: the delete
 * guard computes exactly these counts, but until now the only way to see them
 * was to attempt the DELETE and read the 409.
 *
 * `hasBlockingDependents` is therefore computed from the same counts the guard
 * uses, and deliberately not re-derived by callers — a UI that decided for
 * itself would eventually disagree with the endpoint that actually refuses.
 *
 * It is a SNAPSHOT, not a promise. Sharing the counting function does not share
 * the transaction: `remove()` counts inside its delete transaction behind a row
 * lock, while this endpoint issues seven independent reads under READ
 * COMMITTED. A record moving `draft → submitted` between two of them can be
 * counted twice or not at all, so a caller can be told there are no blockers
 * and still get a 409. **The 409 is authoritative**; treat this as a display
 * value and let the refusal be the gate.
 */
export interface SubsidiarySummaryDTO {
  subsidiaryId: string;
  /** Informational, not a blocker: deleting the subsidiary now removes its own
   *  record-free locations, with an audit row each. */
  locations: number;
  /** `approved`, `locked` or `voided` — these can never be deleted, at any
   *  point. A voided record is included because it is the only trace that a
   *  figure was withdrawn, and a subsidiary delete would cascade it away. */
  terminalRecords: number;
  /** `submitted`/`under_review` — a reviewer can send them back, and then they can. */
  reviewRecords: number;
  /** `draft`/`rejected` — still the author's to remove. */
  openRecords: number;
  periodLocks: number;
  targets: number;
  denominators: number;
  /**
   * Why a delete would be refused, in the words the 409 itself uses.
   *
   * Composed by the same function that builds the refusal message, so the panel
   * explaining the block and the endpoint enforcing it cannot describe the same
   * rule two different ways. Empty when nothing blocks.
   *
   * A terminal-records refusal is a single sentence (the subsidiary stays, and
   * `reportingStatus: 'inactive'` is how it is retired); everything else is one
   * short phrase per remaining dependent, in the order they should be cleared.
   */
  blockers: string[];
  /**
   * True while anything above still hangs off the subsidiary — a statement
   * about DEPENDENCIES only.
   *
   * It deliberately does NOT say "deletable". `remove()` runs `assertCanWrite`
   * first, so a non-super_admin caller with an empty subsidiary would have been
   * told `deletable: true` and then refused with 403. Encoding an authorisation
   * outcome here would also make the same subsidiary answer differently per
   * caller, which is worse than useless for caching.
   */
  hasBlockingDependents: boolean;
}

// ---------------------------------------------------------------------------
// Operational locations (FR §1.1: Holding > Subsidiary > Location).
// DB-shaped API types — distinct from the legacy mock `Location` view model.
// Activity records still attach to subsidiaries; binding them to locations
// (incl. per-location geographyCode) is a separate roadmap item.
// ---------------------------------------------------------------------------

/** An operational location as returned/accepted by the API. */
export interface LocationDTO {
  id: string;
  subsidiaryId: string;
  name: string;
  /** Determines the emission factor when a record targets this location (data_entry_page.md §5.2). */
  geographyCode: string;
  address: string | null;
  authorizedPerson: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Everything that describes WHAT a location is. The base, on purpose.
 *
 * `CreateLocationInput` extends this with the one field that describes how a
 * location ATTACHES to a parent, and the nested form used by
 * `POST /subsidiaries` is this type unchanged.
 *
 * The derivation used to run the other way — the nested type was
 * `Omit<CreateLocationInput, 'subsidiaryId'>` — which made the two edits
 * indistinguishable. A field added to describe a location would silently reach
 * the nested input, a web caller would compile code that sends it, and the API
 * would answer `400 property … should not exist` and fail the ENTIRE subsidiary
 * create. That is the same failure class already fixed for
 * `UpdateSubsidiaryInput`; it was simply left latent in the opposite direction.
 *
 * Inverted, the two kinds of change are distinguishable: add a field here and
 * both forms get it; add one to the extension and only the standalone endpoint
 * does.
 */
export interface CreateSubsidiaryLocationInput {
  name: string;
  geographyCode: string;
  address?: string | null;
  authorizedPerson?: string | null;
}

export type CreateLocationInput = CreateSubsidiaryLocationInput & {
  subsidiaryId: string;
};

/** `subsidiaryId` is immutable — a location cannot move between subsidiaries. */
export type UpdateLocationInput = Partial<CreateSubsidiaryLocationInput>;

/** Dashboard KPI summary returned by GET /api/v1/kpi */
export interface DashboardKpi {
  totalSubsidiaries: number;
  activeSubsidiaries: number;
  pendingSubsidiaries: number;
  /** Operational locations across the caller's accessible subsidiaries. */
  totalLocations: number;
  geographyBreakdown: { geographyCode: string; count: number }[];
}

export const GEOGRAPHY_CODES = ['UK', 'TR', 'EU'] as const;
export type GeographyCode = typeof GEOGRAPHY_CODES[number];

/**
 * Human names for the geography codes.
 *
 * Round-1 DE-6 reported "Turkey is not an option" while `TR` was there all
 * along — a two-letter code is not a country to the person reading it. Pickers
 * render the label; tables, the audit trail and the geography-change
 * confirmation keep the CODE, because that is what is stored, snapshotted and
 * asserted on.
 */
export const GEOGRAPHY_LABELS: Record<GeographyCode, string> = {
  UK: 'United Kingdom',
  TR: 'Türkiye',
  EU: 'European Union',
};

/**
 * The geographies offered when creating something new (round-1 DE-7).
 *
 * `EU` is HIDDEN, not deleted: the seeded Munich subsidiary resolves its
 * electricity factor through it, and removing the code would make new records
 * for that entity impossible. It stays valid at the API, in the factor table and
 * on every existing record.
 */
export const SELECTABLE_GEOGRAPHY_CODES: readonly GeographyCode[] = ['UK', 'TR'];

/**
 * The options a geography picker should show, given what is currently selected.
 *
 * A Radix Select bound to a value with no matching item renders a BLANK trigger
 * — no error, no placeholder — so hiding `EU` while an EU entity is open would
 * silently empty the control on the one screen where you can change it. Keeping
 * the current value in the list is what makes "hidden, not deleted" true for the
 * user and not just for the database.
 *
 * Takes SEVERAL codes because the live form value is not enough: change EU to UK
 * by mistake and EU would drop out of the list, leaving Cancel — which discards
 * every other edit in the dialog — as the only way back. Pass the persisted
 * value alongside the form's so the choice stays reversible in place.
 */
export function geographyOptions(
  ...current: (string | null | undefined)[]
): string[] {
  const base: string[] = [...SELECTABLE_GEOGRAPHY_CODES];
  for (const code of current) {
    // Any non-empty code is rescued, not just the three we know: the guard
    // exists to stop a stored value blanking its own control, and a code that
    // reached the database by some other route needs that more, not less.
    if (code && !base.includes(code)) base.push(code);
  }
  return base;
}

/** `Türkiye (TR)` — label for the reader, code so it stays greppable. */
export function geographyLabel(code: string): string {
  const name = GEOGRAPHY_LABELS[code as GeographyCode];
  return name ? `${name} (${code})` : code;
}

// ---------------------------------------------------------------------------
// Emission-factor library + calculation engine (Phase 1, PR1)
// ---------------------------------------------------------------------------

/** A single emission factor as returned by GET /api/v1/factors. Reference data. */
export interface EmissionFactorDTO {
  id: string;
  category: string;
  geographyCode: string;
  reportingYear: number;
  scope: number;
  factorValue: number;
  factorUnit: string;
  normalizedUnit: string;
  methodology: string;
  source: string;
  version: string;
  createdAt: string;
  updatedAt: string;
}

/** Body of POST /api/v1/calculations/preview. */
export interface CalculationInput {
  category: string;
  /**
   * The record's activity type, so a preview prices the same fuel or gas the
   * saved record will (see `CreateActivityRecordInput.activityType`). Do not
   * send it before LP3-03's schema change lands: until then the API refuses
   * it as an unknown property.
   */
  activityType?: string | null;
  geographyCode: string;
  reportingYear: number;
  value: number;
  unit: string;
}

/**
 * Result of a preview calculation. Carries the full factor snapshot so the
 * historic result is reproducible even after a newer factor version is added.
 */
export interface CalculationResult {
  category: string;
  geographyCode: string;
  reportingYear: number;
  scope: number;
  /** Raw activity input as submitted. */
  inputValue: number;
  inputUnit: string;
  /** Value after unit normalization (e.g. m³ -> kWh). */
  normalizedValue: number;
  normalizedUnit: string;
  /** true when a unit conversion was applied during normalization. */
  conversionApplied: boolean;
  /** The multiplier applied, and where it comes from. Optional because records
   *  written before WP15 have neither, and because a passthrough has nothing to
   *  record. `conversionApplied` on its own could not answer "converted HOW?",
   *  which is the question an auditor actually asks. */
  conversionFactor?: number;
  conversionBasis?: string;
  kgCo2e: number;
  tCo2e: number;
  // Factor traceability snapshot (see calculation_logic.md §5).
  factorId: string;
  factorValue: number;
  factorUnit: string;
  methodology: string;
  source: string;
  version: string;
}

/**
 * The snapshot written when a record's category is INVOICE-TRACKED but has no
 * seeded emission factor — today that is `Water` alone (WP17 / round-1 DASH-3).
 *
 * Why this exists: completeness is measured in invoices, not in tonnes. The
 * product owner's rule counts one water invoice per location per month, so the
 * record has to be storable; but no authoritative water factor exists, and
 * inventing one is forbidden. So the record is stored and the snapshot says,
 * in the row itself, that no figure was produced and why.
 *
 * What is deliberately ABSENT is the point of the type:
 * - no `tCo2e` / `kgCo2e` — a missing number must not be readable as zero, and
 *   every consumer already guards with `Number.isFinite`, so an absent field
 *   drops out of sums instead of deflating them.
 * - no factor fields — there is no factor to be traceable to.
 * - **no `normalizedValue` / `normalizedUnit`.** Normalization exists to reach
 *   the unit a factor expects; with no factor there is no target, and running it
 *   anyway would be actively wrong here: `normalize()` is category-blind and
 *   turns any `cubic_metres` into kWh at the natural-gas calorific multiplier,
 *   so 100 m³ of WATER would have been frozen into the record as 1,136 kWh.
 *   The raw input is kept exactly as submitted.
 *
 * There is no `calculated: false` discriminant on purpose: the 100+ snapshots
 * already in the database were written before this type existed, so a required
 * flag would make every historic row read as uncalculated. `isCalculated()`
 * keys on `factorId`, which every real snapshot has always carried.
 */
export interface UncalculatedSnapshot {
  /**
   * Schema tag for THIS shape only.
   *
   * Added at introduction because it is free here and expensive later: no row
   * written before WP17 is uncalculated, so unlike `CalculationResult` this side
   * of the union can require a version from its first row. `CalculationResult`
   * deliberately does not have one — retrofitting a required field there would
   * misdescribe every historic snapshot.
   */
  snapshotSchema: 1;
  category: string;
  geographyCode: string;
  reportingYear: number;
  /** From CATEGORY_SCOPE_MAP — a factor would normally supply this. */
  scope: number;
  /** Raw activity input as submitted, un-normalised (see above). */
  inputValue: number;
  inputUnit: string;
  /** Machine-readable cause, so a UI can branch without parsing prose. */
  reasonCode: UncalculatedReasonCode;
  /** Human-readable cause, rendered verbatim to the user. */
  reason: string;
}

/**
 * Why a record carries no figure. Exported as a named type because both apps
 * will switch on it; widening an inline literal later would be a breaking
 * change in two packages at once.
 */
export type UncalculatedReasonCode = 'no_emission_factor';

/**
 * What an activity record's immutable `calculation` column can hold. A record
 * either has a full factor-backed result — the untagged pre-LP3-03 shape, or
 * the provenance-carrying `CalculationResultV2` every new calculation writes —
 * or an explicit statement that no figure was produced.
 *
 * Historic snapshots are never rewritten (LP3-03): a reader handles all three.
 * `CalculationResultV2` extends `CalculationResult`, so every existing reader
 * of the flat fields keeps working on both.
 */
export type ActivityCalculationSnapshot =
  | CalculationResult
  | CalculationResultV2
  | UncalculatedSnapshot;

/**
 * True when the snapshot carries a real, factor-backed emissions figure.
 *
 * **This is the single rule.** An earlier cut of WP17 used this on the display
 * paths but `Number.isFinite(tCo2e)` alone in the aggregations, to keep any
 * hypothetical legacy row counting exactly as before. The two disagree on
 * precisely one shape — a figure with no factor id — and that shape would have
 * counted its tonnes into the dashboard totals and printed its number in the
 * report ledger while every screen rendered it as "Not calculated": the mirror
 * image of the misstatement this type exists to prevent. Measured against the
 * database before deleting the second rule: 102 rows, 0 without `factorId`,
 * 0 in the disagreeing set. There was nothing to preserve.
 *
 * Keyed on `factorId` rather than a discriminant flag so it is correct for rows
 * written before `UncalculatedSnapshot` existed — see the note on that type.
 * `tCo2e` is checked too so the predicate fails SAFE: a malformed or
 * JSON-round-tripped snapshot (`NaN` serialises to `null`) narrows to "no
 * figure" instead of reaching a formatter that would throw on it.
 */
export function isCalculated(
  snapshot: ActivityCalculationSnapshot | null | undefined,
): snapshot is CalculationResult {
  const candidate = snapshot as CalculationResult | null | undefined;
  return (
    !!candidate &&
    typeof candidate.factorId === 'string' &&
    candidate.factorId.length > 0 &&
    Number.isFinite(candidate.tCo2e)
  );
}

/**
 * True when the snapshot explicitly records that no figure was produced.
 *
 * Not simply `!isCalculated(...)`: that folds in a third case — a snapshot that
 * is neither, i.e. malformed — and the display paths should be able to tell
 * "the API said why" from "this row is broken". Keyed on `reasonCode`, which is
 * required on the shape this codebase writes.
 */
export function isUncalculated(
  snapshot: ActivityCalculationSnapshot | null | undefined,
): snapshot is UncalculatedSnapshot {
  return (
    !!snapshot &&
    typeof (snapshot as UncalculatedSnapshot).reasonCode === 'string'
  );
}

// ---------------------------------------------------------------------------
// Factor model (LP3-03) — releases, dimensions, provenance, coverage
// ---------------------------------------------------------------------------
//
// The contract the engine (LP3-03's schema PR), the factor import (LP4-02) and
// the coverage report (LP3-04) share. Structural only: it holds no factor
// value, and nothing here may ever supply one.

/**
 * Where a release stands. A release — one publication, loaded whole — carries
 * the status, and its factors and conversions inherit it.
 *
 * - `authoritative` — loaded from a cited publication with its provenance
 *   (LP4-02). The only status production calculates from.
 * - `placeholder` — not sourced: the prototype demo values. Calculated only
 *   where the API runs with `ALLOW_PLACEHOLDER_FACTORS=true` (local dev, CI),
 *   named as such in every snapshot, and refused everywhere else (owner
 *   decision K3, 2026-10-04).
 * - `fixture` — written by a test run; ranked below placeholder and allowed
 *   wherever placeholders are.
 * - `withdrawn` — never resolves, but stays, because snapshots point at it.
 *   Withdrawing is the one change a loaded release accepts: an erratum is a
 *   NEW release with the next ordinal, never an edit.
 */
export const FACTOR_STATUSES = [
  'authoritative',
  'placeholder',
  'fixture',
  'withdrawn',
] as const;

export type FactorStatus = (typeof FACTOR_STATUSES)[number];

/**
 * Resolution rank. Among the candidates a calculation may use, the highest
 * rank wins before anything else is compared: an authoritative factor beats a
 * placeholder whatever their editions or ordinals say.
 */
export const FACTOR_STATUS_RANK: Readonly<Record<FactorStatus, number>> = {
  authoritative: 3,
  placeholder: 2,
  fixture: 1,
  withdrawn: 0,
};

/**
 * The calorific-value basis an energy quantity is stated on. Gross (higher)
 * counts the latent heat of the water formed; net (lower) does not — about 10%
 * apart for natural gas, so a factor and the quantity it multiplies must be on
 * the same one. `not_applicable` for anything not an energy quantity of a fuel
 * (a litre of diesel, a kWh of grid electricity, a kg of refrigerant).
 */
export const CALORIFIC_BASES = ['gross', 'net', 'not_applicable'] as const;

export type CalorificBasis = (typeof CALORIFIC_BASES)[number];

/**
 * The basis a BILLED fuel-energy quantity is on, and so the basis of any factor
 * applied to it: UK suppliers bill gas in kWh on gross calorific value (DESNZ
 * directs kWh-from-bills users to its Gross CV factors), and Turkish
 * natural-gas bills convert Sm³ to energy on the upper (gross) calorific value.
 */
export const BILLED_ENERGY_CALORIFIC_BASIS: CalorificBasis = 'gross';

/** The categories whose energy quantities carry a calorific basis. */
const FUEL_COMBUSTION_CATEGORIES: readonly string[] = ['Natural Gas', 'Fuel', 'Mobile Combustion'];

/**
 * Scope 2 accounting method (GHG Protocol Scope 2 Guidance). `not_applicable`
 * for every Scope 1 and Scope 3 factor.
 */
export const SCOPE2_METHODS = ['location', 'market', 'not_applicable'] as const;

export type Scope2Method = (typeof SCOPE2_METHODS)[number];

/**
 * The method the pilot calculates Scope 2 with: location-based only (D08), as
 * ISO 14064-1 permits. A market-based row is stored but never resolved.
 *
 * Note for any GHG Protocol claim: its Scope 2 Guidance asks for BOTH methods
 * wherever contractual instruments exist (the UK has REGOs, Türkiye YEK-G),
 * and without certificates the market-based figure falls back through
 * supplier rate, residual mix and grid average rather than dropping out —
 * an owner decision before a report claims GHG Protocol conformance.
 */
export const PILOT_SCOPE2_METHOD: Scope2Method = 'location';

/** The Scope 2 method a calculation in this category resolves with. */
export function scope2MethodFor(category: string): Scope2Method {
  return CATEGORY_SCOPE_MAP[category as Category] === 2
    ? PILOT_SCOPE2_METHOD
    : 'not_applicable';
}

/**
 * Which gas's contribution a factor value covers. Every value is kg CO₂e per
 * one `DIMENSION_BASE_UNIT` of activity, weighted with its release's
 * `gwpSet`. `CO2e` is the total — the only row a calculation multiplies — and
 * what it includes is its `gasCoverage`. Per-gas rows are kept for disclosure
 * and never summed into a figure.
 *
 * `CO2_biogenic` is the CO₂ from the biomass share of a fuel (the biofuel in
 * retail diesel). The GHG Protocol and ISO 14064-1 report it separately,
 * outside the scopes, so it is never part of a `CO2e` total.
 */
export const FACTOR_GASES = ['CO2e', 'CO2', 'CH4', 'N2O', 'CO2_biogenic'] as const;

export type FactorGas = (typeof FACTOR_GASES)[number];

/** The gas row every calculation uses. */
export const CALCULATION_GAS = 'CO2e' satisfies FactorGas;

/**
 * What a `CO2e` total includes. `all_ghg`: every greenhouse gas the activity
 * emits as the publisher accounts for it (CO₂, CH₄ and N₂O for a fuel; the gas
 * itself for a refrigerant). `co2_only`: CO₂ alone — a grid factor computed
 * with the CDM tool, an AIB residual mix — so CH₄ and N₂O are excluded, and a
 * report says so. Set on a `CO2e` row only; per-gas rows carry null.
 */
export const FACTOR_GAS_COVERAGES = ['all_ghg', 'co2_only'] as const;

export type FactorGasCoverage = (typeof FACTOR_GAS_COVERAGES)[number];

/**
 * The IPCC Assessment Report a release's global-warming potentials come from —
 * 100-year GWPs; AR5 means its values without climate-carbon feedbacks, the
 * convention of the UNFCCC transparency framework. One set per inventory year
 * (D09), recorded on the release; a release whose totals are all `co2_only`
 * needs none, since CO₂'s GWP is 1 in every set.
 */
export const GWP_SETS = ['AR4', 'AR5', 'AR6'] as const;

export type GwpSet = (typeof GWP_SETS)[number];

/**
 * A release as a snapshot embeds it: who published what, which edition, and
 * whether it may be relied on.
 *
 * `ordinal` — never `edition` — orders one publisher's releases: an integer
 * the release file states and the load checks is greater than every ordinal
 * that publisher already has, so an erratum always outranks what it corrects
 * and re-importing an old edition cannot. An edition is a label: as text,
 * '2024.2' sorts after '2024.10' (F01). Both (publisher, ordinal) and
 * (publisher, edition) are unique.
 */
export interface FactorReleaseSnapshot {
  id: string;
  /** The publishing body, e.g. the UK's DESNZ. */
  publisher: string;
  /** The publication cited, as the publisher titles it. */
  title: string;
  /** The publisher's own version label. Displayed, never compared. */
  edition: string;
  ordinal: number;
  status: FactorStatus;
  sourceUrl: string | null;
  licence: string | null;
  /** ISO date (YYYY-MM-DD) of publication. */
  publishedAt: string | null;
  gwpSet: GwpSet | null;
}

/** A release as the API lists it. */
export interface FactorReleaseDTO extends FactorReleaseSnapshot {
  /**
   * Who checked the load against the publication (D24): the reviewing firm
   * or role, never a person's name — every tenant can read this row (KVKK).
   * Required, with `reviewedAt`, before a release may be authoritative.
   */
  reviewedBy: string | null;
  /** ISO date (YYYY-MM-DD) of that review. */
  reviewedAt: string | null;
  notes: string | null;
  /**
   * Set together when the release is withdrawn (an erratum superseded it, or
   * it was loaded in error) — the one change a loaded release accepts. The
   * withdrawer is a firm or role, as with `reviewedBy`.
   */
  withdrawnAt: string | null;
  withdrawnBy: string | null;
  withdrawalReason: string | null;
  createdAt: string;
}

/**
 * A factor with its LP3-03 dimensions and its release, as `GET
 * /api/v1/factors` returns it once LP3-03's schema change lands. Extends
 * `EmissionFactorDTO`, so a reader typed on that keeps working.
 */
export interface EmissionFactorDetailDTO extends EmissionFactorDTO {
  activityType: string;
  gas: FactorGas;
  /** What a `CO2e` row's total includes; null on a per-gas row. */
  gasCoverage: FactorGasCoverage | null;
  calorificBasis: CalorificBasis;
  scope2Method: Scope2Method;
  /**
   * The factor year as the publisher labels it (DESNZ's "2026 conversion
   * factors" → 2026) — not the vintage of the statistics underneath. Equal to
   * `reportingYear` unless the release declares a fallback for that year
   * (D07); "latest available" is never a fallback.
   */
  dataYear: number;
  release: FactorReleaseSnapshot;
}

/**
 * The fields that make a factor distinct: the unique key of
 * `emission_factors`. Rows differing in any one are different factors; rows
 * agreeing on all are one factor loaded twice, which is refused.
 * `normalizedUnit` belongs to it because one publication can quote the same
 * fuel per kWh and per m³.
 */
export const FACTOR_IDENTITY_FIELDS = [
  'releaseId',
  'category',
  'activityType',
  'gas',
  'geographyCode',
  'reportingYear',
  'scope2Method',
  'calorificBasis',
  'normalizedUnit',
] as const;

/** The unique key of `unit_conversions`, on the same terms. */
export const CONVERSION_IDENTITY_FIELDS = [
  'releaseId',
  'category',
  'activityType',
  'geographyCode',
  'reportingYear',
  'fromUnit',
  'toUnit',
  'calorificBasis',
] as const;

/** One comparable string for a row's identity under `fields`. */
export function identityKey<F extends string>(
  row: Readonly<Partial<Record<F, unknown>>>,
  fields: readonly F[],
): string {
  return JSON.stringify(fields.map((field) => row[field] ?? null));
}

/** How the factor's data year relates to the activity's year (D07). */
export type YearPolicy = 'exact' | 'declared_fallback';

export function yearPolicyOf(reportingYear: number, dataYear: number): YearPolicy {
  return reportingYear === dataYear ? 'exact' : 'declared_fallback';
}

/**
 * A sourced conversion as a snapshot embeds it — a step between unit families
 * (metered m³ → kWh) that depends on the fuel, the country and the year.
 */
export interface UnitConversionSnapshot {
  id: string;
  fromUnit: string;
  toUnit: string;
  multiplier: number;
  calorificBasis: CalorificBasis;
  /** Temperature and pressure a gas volume is referred to, when one is. */
  referenceConditions: string | null;
  /** How the multiplier is derived, in the publisher's terms. */
  basis: string;
  dataYear: number;
  release: FactorReleaseSnapshot;
}

/**
 * The snapshot every calculation writes from LP3-03's engine on: the v1 fields,
 * unchanged in meaning, plus where every number came from.
 *
 * The v1 fields stay because every reader reads them: `source` is the factor
 * row's citation, `version` its release's edition, `conversionFactor` the whole
 * multiplier from input to normalised unit (definitional and sourced steps
 * together) and `conversionBasis` how it was reached.
 *
 * `snapshotSchema` numbers one sequence across the union: 1 is the
 * `UncalculatedSnapshot` (WP17), 2 this. The untagged pre-LP3-03 shape stays
 * readable as it is; no historic row is ever rewritten.
 */
export interface CalculationResultV2 extends CalculationResult {
  snapshotSchema: 2;
  /** The activity type the factor was resolved for (`factorActivityTypeFor`). */
  activityType: string;
  gas: typeof CALCULATION_GAS;
  /** What the total includes — a report discloses a `co2_only` factor. */
  gasCoverage: FactorGasCoverage;
  calorificBasis: CalorificBasis;
  scope2Method: Scope2Method;
  dataYear: number;
  yearPolicy: YearPolicy;
  factorRelease: FactorReleaseSnapshot;
  /**
   * The sourced conversion applied, or null when none was needed. A
   * definitional step (MWh → kWh) is not a conversion row; it shows in
   * `conversionFactor` alone.
   */
  conversion: UnitConversionSnapshot | null;
}

/** True when the snapshot is a factor-backed figure that carries provenance. */
export function isProvenanceSnapshot(
  snapshot: ActivityCalculationSnapshot | null | undefined,
): snapshot is CalculationResultV2 {
  return (
    isCalculated(snapshot) &&
    (snapshot as CalculationResultV2).snapshotSchema === 2
  );
}

/**
 * True only when every number in the snapshot came from an authoritative
 * release — the factor's and, when one was applied, the conversion's. A
 * snapshot written before LP3-03 is never authoritative: its factors were the
 * prototype's. Every report and screen that labels a placeholder asks this,
 * never the factor's status alone, because a path is only as authoritative as
 * its weakest link.
 */
export function isAuthoritativeSnapshot(
  snapshot: ActivityCalculationSnapshot | null | undefined,
): boolean {
  return (
    isProvenanceSnapshot(snapshot) &&
    snapshot.factorRelease.status === 'authoritative' &&
    (snapshot.conversion === null ||
      snapshot.conversion.release.status === 'authoritative')
  );
}

/**
 * Why the engine refused to calculate. Machine-readable, so a screen, the bulk
 * importer and LP3-04's coverage report can branch without parsing prose;
 * LP3-01's error-code registry adopts them. A refusal is never a guess: no
 * fallback to another year, geography, fuel or basis exists.
 *
 * The bulk importer keeps reporting every coverage refusal as `no_factor`,
 * with the sentence saying which — its issue codes are an exhaustive map on
 * the web, and adding one is a contract change of its own.
 */
export const CALCULATION_REFUSAL_CODES = [
  /** The unit is not one the engine knows. */
  'unit_unknown',
  /** The unit is known but cannot be calculated (Sm³, Nm³ today). */
  'unit_blocked',
  /** The unit is not one this category is measured in. */
  'unit_not_for_category',
  /** The record names an activity type its category does not have. */
  'activity_type_not_for_category',
  /** A new record in a typed category names no activity type. */
  'activity_type_required',
  /** No factor covers this category, activity, geography and year. */
  'no_factor',
  /** Only non-authoritative factors cover it, and they are not allowed here. */
  'placeholder_refused',
  /** Two releases claim the same key at the same rank — a library conflict. */
  'ambiguous_factor',
  /** The resolved factor's scope is not its category's — a library defect. */
  'factor_scope_mismatch',
  /** The unit needs a sourced conversion and none covers it. */
  'no_conversion',
  /** A conversion exists, but on a different calorific basis than the factor. */
  'calorific_basis_mismatch',
] as const;

export type CalculationRefusalCode = (typeof CALCULATION_REFUSAL_CODES)[number];

/**
 * The HTTP status of each refusal: 400 for what the caller sent, 404 for a
 * coverage gap (as `NoEmissionFactorError` has always been), 409 for a factor
 * library that contradicts itself.
 */
export const CALCULATION_REFUSAL_STATUS: Readonly<
  Record<CalculationRefusalCode, 400 | 404 | 409>
> = {
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
};

/** The exact lookup a refusal is about — what LP3-04 lists as missing. */
export interface CoverageKey {
  category: string;
  activityType: string;
  geographyCode: string;
  reportingYear: number;
  unit: string;
}

/** The body of a refused calculation (preview, create, update). */
export interface CalculationRefusalBody {
  statusCode: 400 | 404 | 409;
  error?: string;
  message: string;
  code: CalculationRefusalCode;
  coverage?: CoverageKey;
}

// ---------------------------------------------------------------------------
// Error codes and the error body (LP3-01)
// ---------------------------------------------------------------------------
//
// Every error the API answers carries a `code` from this registry, and a
// screen shows the message its language's catalogue holds for that code — the
// English `message` is for logs and for the fallback below. A code is a
// contract: renaming one breaks every catalogue, so add codes, never reword
// them. Recipe: `.claude/skills/localise-ui`.

/**
 * Codes that name only the HTTP status. The API's exception filter gives one
 * to every error that carries no code of its own, so a body never lacks a
 * code; a screen shows its catalogue's generic sentence for it (in English,
 * the server's own `message`, which is more specific — decision K5 of LP3-01).
 *
 * Two of them cover a range rather than their one status: `bad_request` is
 * the code of ANY 4xx without one of its own (405, 410, 422, …), and
 * `internal_error` of any 5xx. Every other code always answers exactly the
 * status listed here.
 */
export const GENERIC_ERROR_STATUS = Object.freeze({
  /** 400, and any other 4xx without a code of its own. */
  bad_request: 400,
  /** A DTO refused the body or query; `message` lists the fields. */
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  /** Any 5xx — the one code whose status is a range, not only 500. Its body
   *  never carries the cause; that goes to the logs. */
  internal_error: 500,
} as const);
export type GenericErrorCode = keyof typeof GENERIC_ERROR_STATUS;

/**
 * Codes for refusals a screen words on its own.
 *
 * A `*_not_found` code names the KIND of thing the caller asked for, never
 * why it was not found: an id of another organisation and an id that does not
 * exist answer the same code and the same body (tenant-isolation.int.spec.ts
 * compares them byte for byte). No 404 carries params.
 */
export const DOMAIN_ERROR_STATUS = Object.freeze({
  /** A path id that is not a UUID. */
  invalid_id: 400,
  /** params: `category` (canonical, from `CATEGORIES`). */
  evidence_required: 400,
  variance_reason_required: 400,
  record_create_forbidden: 403,
  record_submit_forbidden: 403,
  /** Only a record's author submits or resubmits it (D02). */
  record_author_forbidden: 403,
  /** Segregation of duties (D01). */
  self_approval_forbidden: 403,
  subsidiary_not_found: 404,
  location_not_found: 404,
  record_not_found: 404,
  evidence_not_found: 404,
  /** The row exists but its bytes are gone from Storage (reported to operators). */
  evidence_content_missing: 404,
  period_lock_not_found: 404,
  user_not_found: 404,
  access_grant_not_found: 404,
  /** One record per reporting entity, period, category and activity type. */
  record_duplicate: 409,
  /** params: `period` (canonical, from `PERIOD_VALUES`) and `year`. */
  period_locked: 409,
  /** LP1-01's lost race: someone else changed the record first. */
  record_changed: 409,
  /** The slot holds an untyped record; this one names an activity type (TA002). */
  slot_holds_untyped: 409,
  /** The slot holds typed records; this one names none (TA002). */
  slot_holds_typed: 409,
  /** The record has left draft; its figure is frozen (TA001). */
  snapshot_immutable: 409,
  upload_expired: 409,
  /** A complete read/export exceeds its work or output budget after authorization,
   * over the caller's accessible set only. Inaccessible filters equal empty sets.
   * No partial result. Body depends only on this code: fixed message, no params
   * or extra fields (including counts, ids or limits). */
  query_too_broad: 422,
} as const);
export type DomainErrorCode = keyof typeof DOMAIN_ERROR_STATUS;

export type ApiErrorCode = GenericErrorCode | DomainErrorCode | CalculationRefusalCode;

/** Every code, with the status it answers with. */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = Object.freeze({
  ...GENERIC_ERROR_STATUS,
  ...DOMAIN_ERROR_STATUS,
  ...CALCULATION_REFUSAL_STATUS,
});

export const API_ERROR_CODES = Object.freeze(Object.keys(API_ERROR_STATUS)) as readonly ApiErrorCode[];

/**
 * The params each code carries — exactly these keys, every time — so a
 * catalogue message can name them (`{period}`). A code absent here carries
 * none. Values are canonical (a `PERIOD_VALUES` or `CATEGORIES` entry, a year),
 * never caller text or an id, and the web translates the vocabularies.
 */
export const API_ERROR_PARAMS: Readonly<Partial<Record<ApiErrorCode, readonly string[]>>> =
  Object.freeze({
    evidence_required: Object.freeze(['category']),
    period_locked: Object.freeze(['period', 'year']),
  });

export type ApiErrorParams = Readonly<Record<string, string | number>>;

/**
 * The body of every API error. Additive over Nest's default — `statusCode`,
 * `message` and `error` keep their meaning — so older readers and the e2e
 * suite's message assertions keep working; a refusal may add fields of its
 * own (a calculation refusal's `coverage`, a batch's `failed` or `refused`).
 */
export interface ApiErrorBody {
  statusCode: number;
  code: ApiErrorCode;
  /** English. A DTO refusal lists one sentence per field. */
  message: string | string[];
  error?: string;
  params?: ApiErrorParams;
}

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(API_ERROR_STATUS, value);
}

export function isGenericErrorCode(value: unknown): value is GenericErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GENERIC_ERROR_STATUS, value);
}

/**
 * The generic code for a status the API answered with: `internal_error` for
 * any 5xx, the status's own code where one exists, otherwise `bad_request`.
 */
export function genericErrorCode(status: number): GenericErrorCode {
  if (status >= 500) return 'internal_error';
  for (const [code, codeStatus] of Object.entries(GENERIC_ERROR_STATUS)) {
    // `validation_failed` shares 400 with `bad_request`; only the pipe says which.
    if (codeStatus === status && code !== 'validation_failed') return code as GenericErrorCode;
  }
  return 'bad_request';
}

/** Anything resolution ranks: a factor or a conversion, with its release. */
export interface ReleaseRanked {
  release: Pick<FactorReleaseSnapshot, 'publisher' | 'ordinal' | 'status'>;
}

export type ReleaseSelection<T> =
  | { ok: true; selected: T }
  | { ok: false; reason: 'none' | 'placeholder_refused' | 'ambiguous' };

/**
 * Choose ONE of the candidates that match a lookup exactly — the rule the
 * engine, the seed and the coverage report all apply, so they cannot drift.
 *
 * 1. A withdrawn release never resolves.
 * 2. Without `allowPlaceholders`, only authoritative candidates count; when
 *    only non-authoritative ones matched, the answer is `placeholder_refused`,
 *    not `none` — the gap is a missing load, not a missing methodology.
 * 3. The highest `FACTOR_STATUS_RANK` wins.
 * 4. Within it there must be one publisher: two publishers for one key is a
 *    conflict a person settles (`ambiguous`), never a silent pick.
 * 5. The highest ordinal wins; a tie is `ambiguous`.
 */
function maxOf(values: readonly number[]): number {
  let max = -Infinity;
  for (const value of values) if (value > max) max = value;
  return max;
}

export function selectByRelease<T extends ReleaseRanked>(
  candidates: readonly T[],
  options: { allowPlaceholders: boolean },
): ReleaseSelection<T> {
  // Only statuses this contract knows: an unknown one ('Authoritative', a
  // typo) is never ranked, whatever `allowPlaceholders` says.
  const known = candidates.filter((c) =>
    Object.prototype.hasOwnProperty.call(FACTOR_STATUS_RANK, c.release.status),
  );
  const live = known.filter((c) => c.release.status !== 'withdrawn');
  const permitted = options.allowPlaceholders
    ? live
    : live.filter((c) => c.release.status === 'authoritative');
  if (permitted.length === 0) {
    return { ok: false, reason: live.length > 0 ? 'placeholder_refused' : 'none' };
  }
  // Loops, not `Math.max(...list)`: a spread of a very long list overflows
  // the call stack.
  const topRank = maxOf(permitted.map((c) => FACTOR_STATUS_RANK[c.release.status]));
  const top = permitted.filter(
    (c) => FACTOR_STATUS_RANK[c.release.status] === topRank,
  );
  if (new Set(top.map((c) => c.release.publisher)).size > 1) {
    return { ok: false, reason: 'ambiguous' };
  }
  const topOrdinal = maxOf(top.map((c) => c.release.ordinal));
  const winners = top.filter((c) => c.release.ordinal === topOrdinal);
  return winners.length === 1
    ? { ok: true, selected: winners[0] }
    : { ok: false, reason: 'ambiguous' };
}

/**
 * The single-step sourced conversions a record's unit family may take to
 * reach a factor quoted in another family, in order of preference. A family
 * absent here (a kWh, a litre, a kg) reaches only a factor in its own family.
 */
export const CONVERSION_TARGETS: Readonly<
  Partial<Record<UnitDimension, readonly UnitDimension[]>>
> = {
  metered_volume: ['energy', 'standard_volume'],
  standard_volume: ['energy'],
};

/**
 * The calorific basis a factor applied DIRECTLY to a record's quantity must
 * be on: a fuel's energy is billed gross (`BILLED_ENERGY_CALORIFIC_BASIS`);
 * anything else has none.
 */
export function directCalorificBasisFor(category: string, inputUnit: string): CalorificBasis {
  return FUEL_COMBUSTION_CATEGORIES.includes(category) &&
    unitDimensionOf(inputUnit) === 'energy'
    ? BILLED_ENERGY_CALORIFIC_BASIS
    : 'not_applicable';
}

/**
 * A factor row as path resolution needs it. `gas` and `scope2Method` are
 * checked here as well as in the caller's query: only the `CO2e` row of the
 * category's own Scope 2 method (`scope2MethodFor`) ever prices a record, so
 * a market-based row passed in by mistake is ignored, never chosen.
 */
export interface FactorPathCandidate extends ReleaseRanked {
  gas: string;
  scope2Method: string;
  normalizedUnit: string;
  calorificBasis: string;
}

/** A conversion row as path resolution needs it. */
export interface ConversionPathCandidate extends ReleaseRanked {
  fromUnit: string;
  toUnit: string;
  calorificBasis: string;
}

export type FactorPathResolution<F, C> =
  | { ok: true; factor: F; conversion: C | null }
  | {
      ok: false;
      code: Extract<
        CalculationRefusalCode,
        | 'unit_unknown'
        | 'no_factor'
        | 'placeholder_refused'
        | 'ambiguous_factor'
        | 'no_conversion'
        | 'calorific_basis_mismatch'
      >;
    };

function isLiveStatus(status: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(FACTOR_STATUS_RANK, status) &&
    status !== 'withdrawn'
  );
}

/**
 * Which factor — and which sourced conversion, if any — prices a record. The
 * one rule the engine, the seed and LP3-04's coverage report share.
 *
 * `factors` are every `CO2e` row of the lookup (category, activity type,
 * geography, reporting year, Scope 2 method) in ANY unit and basis;
 * `conversions` every conversion row of the same lookup from the base unit of
 * the record's family. A path is a factor in the record's own family on its
 * direct basis (`directCalorificBasisFor`), or a factor in a
 * `CONVERSION_TARGETS` family reached by one conversion on the factor's own
 * basis. Then, in order:
 *
 * 1. A path is as authoritative as its weakest link: without
 *    `allowPlaceholders`, factor AND conversion must be authoritative.
 * 2. The highest-ranked paths win, across every path — an authoritative
 *    converted path beats a placeholder direct one.
 * 3. Among those, a direct path beats a converted one, an earlier
 *    `CONVERSION_TARGETS` family a later one, and — into energy — a factor on
 *    `BILLED_ENERGY_CALORIFIC_BASIS` one on the other basis (a release holding
 *    both is consistent, not ambiguous).
 * 4. The factor is then chosen by `selectByRelease`, and its conversion the
 *    same way; a conflict is `ambiguous_factor`, never a silent pick.
 *
 * A refusal names its cause: no factor at all; only non-authoritative paths
 * (`placeholder_refused`); a factor that needs a conversion nobody loaded
 * (`no_conversion`); or only factors/conversions on the other calorific basis.
 */
export function resolveFactorPath<
  F extends FactorPathCandidate,
  C extends ConversionPathCandidate,
>(input: {
  category: string;
  inputUnit: string;
  factors: readonly F[];
  conversions: readonly C[];
  allowPlaceholders: boolean;
}): FactorPathResolution<F, C> {
  const refuse = (
    code: Extract<FactorPathResolution<F, C>, { ok: false }>['code'],
  ): FactorPathResolution<F, C> => ({ ok: false, code });
  const dimension = unitDimensionOf(input.inputUnit);
  if (dimension === undefined) return refuse('unit_unknown');
  const base = DIMENSION_BASE_UNIT[dimension];
  const directBasis = directCalorificBasisFor(input.category, input.inputUnit);
  const targets = CONVERSION_TARGETS[dimension] ?? [];
  const method = scope2MethodFor(input.category);

  type Path = { factor: F; conversion: C | null; preference: number };
  const paths: Path[] = [];
  let basisMismatch = false;
  let missingConversion = false;
  for (const factor of input.factors) {
    // A withdrawn or unknown-status factor is no factor: it must not turn the
    // refusal into a conversion or basis problem.
    if (!isLiveStatus(factor.release.status)) continue;
    if (factor.gas !== CALCULATION_GAS || factor.scope2Method !== method) continue;
    if (factor.normalizedUnit === base) {
      if (factor.calorificBasis === directBasis) {
        paths.push({ factor, conversion: null, preference: 0 });
      } else {
        basisMismatch = true;
      }
      continue;
    }
    const target = unitDimensionOf(factor.normalizedUnit);
    const order = target === undefined ? -1 : targets.indexOf(target);
    if (order < 0 || DIMENSION_BASE_UNIT[target!] !== factor.normalizedUnit) continue;
    // A withdrawn or unknown-status step counts as no step: the gap LP3-04
    // reports is a missing conversion, not a missing factor.
    const steps = input.conversions.filter(
      (c) =>
        c.fromUnit === base &&
        c.toUnit === factor.normalizedUnit &&
        isLiveStatus(c.release.status),
    );
    const onBasis = steps.filter((c) => c.calorificBasis === factor.calorificBasis);
    if (onBasis.length === 0) {
      if (steps.length > 0) basisMismatch = true;
      else missingConversion = true;
      continue;
    }
    // Direct is 0; each conversion family takes two slots, the billed basis
    // first.
    const offBasis = target === 'energy' && factor.calorificBasis !== BILLED_ENERGY_CALORIFIC_BASIS;
    for (const conversion of onBasis) {
      paths.push({ factor, conversion, preference: 2 * (order + 1) + (offBasis ? 1 : 0) });
    }
  }

  // Factors and conversions were filtered to live ones as the paths were built.
  const live = paths;
  const permitted = input.allowPlaceholders
    ? live
    : live.filter(
        (p) =>
          p.factor.release.status === 'authoritative' &&
          (p.conversion === null || p.conversion.release.status === 'authoritative'),
      );
  if (permitted.length === 0) {
    if (live.length > 0) return refuse('placeholder_refused');
    if (missingConversion) return refuse('no_conversion');
    if (basisMismatch) return refuse('calorific_basis_mismatch');
    return refuse('no_factor');
  }

  const rankOf = (p: Path) =>
    Math.min(
      FACTOR_STATUS_RANK[p.factor.release.status],
      p.conversion ? FACTOR_STATUS_RANK[p.conversion.release.status] : Infinity,
    );
  const topRank = maxOf(permitted.map(rankOf));
  const top = permitted.filter((p) => rankOf(p) === topRank);
  const bestPreference = -maxOf(top.map((p) => -p.preference));
  const chosen = top.filter((p) => p.preference === bestPreference);

  const factorPick = selectByRelease([...new Set(chosen.map((p) => p.factor))], {
    allowPlaceholders: input.allowPlaceholders,
  });
  if (!factorPick.ok) return refuse('ambiguous_factor');
  const factor = factorPick.selected;
  const forFactor = chosen.filter((p) => p.factor === factor);
  if (forFactor[0].conversion === null) return { ok: true, factor, conversion: null };
  const conversionPick = selectByRelease(
    forFactor.map((p) => p.conversion as C),
    { allowPlaceholders: input.allowPlaceholders },
  );
  return conversionPick.ok
    ? { ok: true, factor, conversion: conversionPick.selected }
    : refuse('ambiguous_factor');
}

/**
 * The import contract (LP4-02 loads authoritative releases through it). A
 * release file arrives untyped, so `validateFactorReleaseImport` checks every
 * value's type as well as its meaning and reports — never throws — and nothing
 * is written while any issue stands.
 */
export interface FactorReleaseImport {
  release: {
    publisher: string;
    title: string;
    edition: string;
    ordinal: number;
    status: string;
    sourceUrl: string | null;
    licence: string | null;
    publishedAt: string | null;
    gwpSet: string | null;
    reviewedBy: string | null;
    reviewedAt: string | null;
    notes: string | null;
  };
  factors: readonly FactorImportRow[];
  conversions: readonly UnitConversionImportRow[];
}

export interface FactorImportRow {
  category: string;
  activityType: string;
  gas: string;
  /** On a `CO2e` row, what its total includes; null on a per-gas row. */
  gasCoverage: string | null;
  geographyCode: string;
  reportingYear: number;
  dataYear: number;
  scope: number;
  /** kg CO₂e (of `gas`) per ONE `normalizedUnit`. */
  factorValue: number;
  /**
   * Always `factorUnitFor(normalizedUnit)`, e.g. "kgCO2e/kWh". The publisher's
   * own quote ("tCO2/TJ") and the arithmetic from it belong in `methodology`.
   */
  factorUnit: string;
  /** The base unit of its family (`DIMENSION_BASE_UNIT`) the value is per. */
  normalizedUnit: string;
  calorificBasis: string;
  scope2Method: string;
  methodology: string;
  /** Where in the publication this row comes from (sheet, table, row). */
  source: string;
}

export interface UnitConversionImportRow {
  category: string;
  activityType: string;
  geographyCode: string;
  reportingYear: number;
  dataYear: number;
  /** A base unit (`DIMENSION_BASE_UNIT`) — a definitional step runs in code first. */
  fromUnit: string;
  /** A base unit of another family. */
  toUnit: string;
  multiplier: number;
  calorificBasis: string;
  referenceConditions: string | null;
  basis: string;
}

export interface FactorImportIssue {
  /** Where, e.g. `release.sourceUrl` or `factors[12].gas`. */
  path: string;
  message: string;
}

/** How a factor's unit is written: kg CO₂e per one base unit. */
export function factorUnitFor(normalizedUnit: string): string {
  return `kgCO2e/${unitSymbol(normalizedUnit)}`;
}

/**
 * Length caps for imported text. Release fields are copied into every
 * snapshot that cites the release and printed in reports, so one oversized
 * field would bloat every record priced from it.
 */
export const FACTOR_IMPORT_TEXT_LIMITS = {
  publisher: 200,
  title: 500,
  edition: 100,
  licence: 500,
  notes: 2000,
  reviewedBy: 200,
  sourceUrl: 2000,
  factorUnit: 32,
  methodology: 1000,
  source: 1000,
  basis: 2000,
  referenceConditions: 200,
} as const;

/** Statuses a release can be loaded with — `withdrawn` is reached, not loaded. */
const LOADABLE_STATUSES: readonly string[] = ['authoritative', 'placeholder', 'fixture'];

/**
 * Control, formatting, surrogate and default-ignorable characters (bidi
 * overrides, zero-width marks, NUL, a lone surrogate, a Hangul filler, a
 * combining grapheme joiner). An invisible difference in a publisher's name
 * would rank as a SECOND publisher — turning its keys ambiguous and escaping
 * the per-publisher ordinal rule; a bidi override reorders a report.
 * (Look-alike letters from other scripts need a publisher registry — PR B.)
 */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;

/**
 * An https URL with a host and nothing before it: no `user@` part, which
 * would make `https://www.gov.uk@evil.example/` a link to evil.example, and
 * no backslash, which browsers read as a slash.
 */
const PROVENANCE_URL = /^https:\/\/[^\s/?#@\\]+(?:[/?#][^\s\\]*)?$/;

/** The definitional family of a unit token, or undefined for an unknown one. */
export function unitDimensionOf(unit: unknown): UnitDimension | undefined {
  return ACTIVITY_UNITS.find((u) => u.value === unit)?.dimension;
}

function isBaseUnit(unit: unknown): boolean {
  const dimension = unitDimensionOf(unit);
  return dimension !== undefined && DIMENSION_BASE_UNIT[dimension] === unit;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isYear(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1990 && (value as number) <= 2100;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf(value: unknown, list: readonly string[]): value is string {
  return typeof value === 'string' && list.includes(value);
}

/** Why a text value is unacceptable, or null when it is clean. */
function textIssue(value: unknown, max: number): string | null {
  if (!isText(value)) return 'is required';
  if (value !== value.trim()) return 'has leading or trailing white space';
  if (value.length > max) return `is longer than ${max} characters`;
  if (CONTROL_OR_FORMAT.test(value)) return 'contains a control or invisible formatting character';
  if (value !== value.normalize('NFC')) return 'is not in Unicode NFC form';
  return null;
}

/**
 * The activity types a factor or conversion of this category may carry under a
 * release of this status: the category's own (its implicit one included), and
 * `UNSPECIFIED_ACTIVITY_TYPE` only in a non-authoritative release.
 */
function factorActivityTypesFor(category: string, status: string | null): string[] {
  const own = (categoryActivityTypes(category)?.types ?? []).map((t) => t.value);
  return status === 'authoritative' ? own : [...own, UNSPECIFIED_ACTIVITY_TYPE];
}

/**
 * Every reason this release may not be loaded — empty when it may. Checks what
 * the database cannot: types and vocabulary, the provenance and review an
 * authoritative release must carry, the scope, basis, unit and gas rules, and
 * duplicates within the file.
 */
export function validateFactorReleaseImport(input: unknown): FactorImportIssue[] {
  const issues: FactorImportIssue[] = [];
  const fail = (path: string, message: string) => issues.push({ path, message });
  if (
    !isObject(input) ||
    !isObject(input.release) ||
    !Array.isArray(input.factors) ||
    !Array.isArray(input.conversions)
  ) {
    return [{ path: '', message: 'must be an object with release, factors[] and conversions[]' }];
  }
  const release = input.release;
  const factors: unknown[] = input.factors;
  const conversions: unknown[] = input.conversions;
  // Echoed into messages only once it is known to be one of ours.
  const status = isOneOf(release.status, LOADABLE_STATUSES) ? release.status : null;
  const authoritative = status === 'authoritative';
  const limits = FACTOR_IMPORT_TEXT_LIMITS;

  for (const field of ['publisher', 'title', 'edition'] as const) {
    const problem = textIssue(release[field], limits[field]);
    if (problem) fail(`release.${field}`, problem);
  }
  for (const field of ['licence', 'notes', 'reviewedBy', 'sourceUrl'] as const) {
    if (release[field] === null) continue;
    const problem = textIssue(release[field], limits[field]);
    if (problem) fail(`release.${field}`, problem);
  }
  if (!Number.isInteger(release.ordinal) || (release.ordinal as number) < 1) {
    fail('release.ordinal', 'must be a positive integer');
  }
  if (status === null) {
    fail('release.status', `must be one of ${LOADABLE_STATUSES.join(', ')}`);
  }
  if (release.gwpSet !== null && !isOneOf(release.gwpSet, GWP_SETS)) {
    fail('release.gwpSet', `must be one of ${GWP_SETS.join(', ')}`);
  }
  for (const field of ['publishedAt', 'reviewedAt'] as const) {
    if (release[field] !== null && !isIsoDate(release[field])) {
      fail(`release.${field}`, 'must be an ISO date (YYYY-MM-DD)');
    }
  }
  if (isIsoDate(release.publishedAt) && isIsoDate(release.reviewedAt) && release.reviewedAt < release.publishedAt) {
    fail('release.reviewedAt', 'is earlier than the publication it reviews');
  }
  if (release.sourceUrl !== null && !(typeof release.sourceUrl === 'string' && PROVENANCE_URL.test(release.sourceUrl))) {
    fail('release.sourceUrl', 'must be an https URL with a host and no user part');
  }
  if (authoritative) {
    // Provenance and review are what make a release authoritative (F01, D24);
    // a loaded release never changes but to withdrawn, so neither can be
    // added afterwards.
    for (const field of ['sourceUrl', 'licence', 'publishedAt', 'reviewedBy', 'reviewedAt'] as const) {
      // `== null`: an omitted key is as missing as a null one.
      if (release[field] == null) fail(`release.${field}`, 'is required for an authoritative release');
    }
  }
  if (factors.length === 0 && conversions.length === 0) {
    fail('release', 'holds no factor and no conversion');
  }

  const seenFactors = new Set<string>();
  const totals = new Map<string, { value: number; coverage: unknown }>();
  const perGas: { group: string; path: string; gas: string; value: number }[] = [];
  let needsGwp = false;
  factors.forEach((row, i) => {
    const at = (field: string) => `factors[${i}].${field}`;
    if (!isObject(row)) {
      fail(`factors[${i}]`, 'is not an object');
      return;
    }
    const category = row.category;
    if (!isOneOf(category, CATEGORIES)) {
      fail(at('category'), 'is not a category');
      return;
    }
    if (!isOneOf(row.activityType, factorActivityTypesFor(category, status))) {
      fail(
        at('activityType'),
        authoritative && row.activityType === UNSPECIFIED_ACTIVITY_TYPE
          ? `is reserved for non-authoritative releases`
          : `is not an activity type of ${category}`,
      );
    }
    const gas = isOneOf(row.gas, FACTOR_GASES) ? row.gas : null;
    if (gas === null) fail(at('gas'), `must be one of ${FACTOR_GASES.join(', ')}`);
    if (!isOneOf(row.geographyCode, GEOGRAPHY_CODES)) fail(at('geographyCode'), 'is not a geography code');
    if (!isYear(row.reportingYear)) fail(at('reportingYear'), 'is not a year');
    if (!isYear(row.dataYear)) fail(at('dataYear'), 'is not a year');
    else if (isYear(row.reportingYear) && row.dataYear > row.reportingYear) {
      fail(at('dataYear'), 'is later than the reporting year it is declared for');
    }
    const scope = CATEGORY_SCOPE_MAP[category as Category];
    if (row.scope !== scope) fail(at('scope'), `must be ${scope} for ${category}`);
    const value = typeof row.factorValue === 'number' && Number.isFinite(row.factorValue) && row.factorValue >= 0
      ? row.factorValue
      : null;
    if (value === null) fail(at('factorValue'), 'must be a finite, non-negative number');
    for (const field of ['methodology', 'source'] as const) {
      const problem = textIssue(row[field], limits[field]);
      if (problem) fail(at(field), problem);
    }
    const unit = row.normalizedUnit;
    const dimension = unitDimensionOf(unit);
    if (!CATEGORY_UNITS[category as Category]?.includes(unit as string)) {
      fail(at('normalizedUnit'), `is not a unit ${category} is measured in`);
    } else if (!isBaseUnit(unit)) {
      fail(at('normalizedUnit'), `must be the base unit of its family (${DIMENSION_BASE_UNIT[dimension!]})`);
    } else if (FUEL_COMBUSTION_CATEGORIES.includes(category) && dimension === 'metered_volume') {
      // A publisher's per-m³ combustion factor comes from a calorific value
      // per STANDARD m³; read as per metered m³ it would skip the volume
      // correction and understate every reading.
      fail(
        at('normalizedUnit'),
        'a combustion factor per cubic metre is not per metered m³ — load it per standard_cubic_metres only if the publisher states 15 °C and 101.325 kPa; a per-Nm³ (0 °C) factor needs its own unit',
      );
    } else if (row.factorUnit !== factorUnitFor(unit as string)) {
      fail(at('factorUnit'), `must be ${factorUnitFor(unit as string)}`);
    }
    const needsBasis = FUEL_COMBUSTION_CATEGORIES.includes(category) && dimension === 'energy';
    if (needsBasis ? !isOneOf(row.calorificBasis, ['gross', 'net']) : row.calorificBasis !== 'not_applicable') {
      fail(at('calorificBasis'), needsBasis ? 'must be gross or net for a fuel quoted per unit of energy' : 'must be not_applicable');
    }
    const isScope2 = scope === 2;
    if (isScope2 ? !isOneOf(row.scope2Method, ['location', 'market']) : row.scope2Method !== 'not_applicable') {
      fail(at('scope2Method'), isScope2 ? 'must be location or market' : 'must be not_applicable');
    }
    if (gas === CALCULATION_GAS) {
      if (!isOneOf(row.gasCoverage, FACTOR_GAS_COVERAGES)) {
        fail(at('gasCoverage'), `must be one of ${FACTOR_GAS_COVERAGES.join(', ')} on a ${CALCULATION_GAS} row`);
      } else if (category === 'Refrigerants' && row.gasCoverage !== 'all_ghg') {
        fail(at('gasCoverage'), 'must be all_ghg for a refrigerant — its total is the gas itself');
      }
      if (row.gasCoverage !== 'co2_only') needsGwp = true;
    } else if (gas !== null) {
      if (row.gasCoverage !== null) fail(at('gasCoverage'), 'must be null on a per-gas row');
      if (category === 'Refrigerants') fail(at('gas'), `a refrigerant is quoted as one ${CALCULATION_GAS} total`);
      if (gas === 'CH4' || gas === 'N2O') needsGwp = true;
    }
    const key = identityKey({ ...row, releaseId: null }, FACTOR_IDENTITY_FIELDS);
    if (seenFactors.has(key)) fail(at('gas'), 'duplicates an earlier factor row');
    seenFactors.add(key);
    // A calculation multiplies the CO2e row only, so a per-gas breakdown with
    // no total beside it would be disclosed but never priced.
    const group = identityKey({ ...row, releaseId: null, gas: null }, FACTOR_IDENTITY_FIELDS);
    if (gas === CALCULATION_GAS && value !== null) totals.set(group, { value, coverage: row.gasCoverage });
    else if (gas !== null && gas !== CALCULATION_GAS && value !== null) perGas.push({ group, path: at('gas'), gas, value });
  });
  for (const { group, path, gas, value } of perGas) {
    const total = totals.get(group);
    if (!total) {
      fail(path, `has no ${CALCULATION_GAS} total beside it`);
    } else if (total.coverage === 'co2_only' && (gas === 'CH4' || gas === 'N2O')) {
      fail(path, `contradicts a ${CALCULATION_GAS} total that covers CO2 only`);
    } else if (gas !== 'CO2_biogenic' && value > total.value) {
      // Biogenic CO2 sits outside the total and may exceed it; a share of the
      // total may not.
      fail(path, `exceeds the ${CALCULATION_GAS} total it is part of`);
    }
  }
  if (authoritative && needsGwp && release.gwpSet === null) {
    fail('release.gwpSet', 'is required for an authoritative release that weights any gas other than CO2');
  }

  const seenConversions = new Set<string>();
  conversions.forEach((row, i) => {
    const at = (field: string) => `conversions[${i}].${field}`;
    if (!isObject(row)) {
      fail(`conversions[${i}]`, 'is not an object');
      return;
    }
    const category = row.category;
    if (!isOneOf(category, CATEGORIES)) {
      fail(at('category'), 'is not a category');
      return;
    }
    if (!isOneOf(row.activityType, factorActivityTypesFor(category, status))) {
      fail(
        at('activityType'),
        authoritative && row.activityType === UNSPECIFIED_ACTIVITY_TYPE
          ? 'is reserved for non-authoritative releases'
          : `is not an activity type of ${category}`,
      );
    }
    if (!isOneOf(row.geographyCode, GEOGRAPHY_CODES)) fail(at('geographyCode'), 'is not a geography code');
    if (!isYear(row.reportingYear)) fail(at('reportingYear'), 'is not a year');
    if (!isYear(row.dataYear)) fail(at('dataYear'), 'is not a year');
    else if (isYear(row.reportingYear) && row.dataYear > row.reportingYear) {
      fail(at('dataYear'), 'is later than the reporting year it is declared for');
    }
    for (const field of ['fromUnit', 'toUnit'] as const) {
      if (!CATEGORY_UNITS[category as Category]?.includes(row[field] as string)) {
        fail(at(field), `is not a unit ${category} is measured in`);
      } else if (!isBaseUnit(row[field])) {
        fail(at(field), 'must be the base unit of its family — definitional steps run in code');
      }
    }
    const from = unitDimensionOf(row.fromUnit);
    const to = unitDimensionOf(row.toUnit);
    // A step inside one family is a definition, kept in code; only a step
    // across families depends on the fuel, the country and the year.
    if (from !== undefined && from === to) {
      fail(at('toUnit'), 'is in the same unit family as fromUnit — that conversion is definitional, not sourced');
    }
    if (!(typeof row.multiplier === 'number' && Number.isFinite(row.multiplier) && row.multiplier > 0)) {
      fail(at('multiplier'), 'must be a finite, positive number');
    }
    const energy = from === 'energy' || to === 'energy';
    if (energy ? !isOneOf(row.calorificBasis, ['gross', 'net']) : row.calorificBasis !== 'not_applicable') {
      fail(at('calorificBasis'), energy ? 'must be gross or net for a step to or from energy' : 'must be not_applicable');
    }
    const gasVolume = (d: UnitDimension | undefined) => d === 'metered_volume' || d === 'standard_volume';
    if (gasVolume(from) || gasVolume(to)) {
      const problem = textIssue(row.referenceConditions, limits.referenceConditions);
      if (problem) {
        fail(at('referenceConditions'), problem === 'is required' ? 'is required for a volume step' : problem);
      } else if (
        (from === 'standard_volume' || to === 'standard_volume') &&
        row.referenceConditions !== STANDARD_REFERENCE_CONDITIONS
      ) {
        // A step stated at other conditions (0 °C "normal" m³) is not a step
        // to or from a standard cubic metre.
        fail(at('referenceConditions'), `must be ${STANDARD_REFERENCE_CONDITIONS} for a step to or from standard_cubic_metres`);
      }
    } else if (row.referenceConditions !== null) {
      const problem = textIssue(row.referenceConditions, limits.referenceConditions);
      if (problem) fail(at('referenceConditions'), problem);
    }
    const problem = textIssue(row.basis, limits.basis);
    if (problem) fail(at('basis'), problem);
    const key = identityKey({ ...row, releaseId: null }, CONVERSION_IDENTITY_FIELDS);
    if (seenConversions.has(key)) fail(at('toUnit'), 'duplicates an earlier conversion row');
    seenConversions.add(key);
  });

  return issues;
}

// ---------------------------------------------------------------------------
// Activity records + review workflow (Phase 1, PR2)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of an activity record:
 *   draft -> submitted -> under_review -> approved | rejected
 * `approved` and `locked` are terminal & immutable; `rejected` records can be
 * edited (back to draft-like behaviour) and re-submitted.
 */
export const ACTIVITY_RECORD_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'locked',
  /**
   * An approved figure withdrawn from the inventory with a mandatory reason,
   * WITHOUT deleting the row.
   *
   * Carries the four elements FR §4.3 lists for a revision entry (comment, user,
   * timestamp, original-value visibility) but does **not** implement §4.3 — that
   * rule governs LOCKED records, which a void refuses; a closed period still
   * reopens only by unlocking it. Nor is there yet a revision *link* from a
   * correction to what it corrects, so a restatement is two unrelated rows.
   *
   * `approved` and `locked` are immutable, and rightly so — but that left a
   * record entered in error with no exit whatsoever, since the API refuses
   * update, delete, submit, review, approve and reject on both, and
   * `super_admin` does not override it (the status check is independent of the
   * role check). Deleting was the only remedy, and the API refuses that too.
   *
   * A voided record still exists, keeps its immutable calculation snapshot, and
   * **counts towards nothing**: it is absent from `COUNTED_STATUSES`, so every
   * total, export, matrix cell and anomaly baseline excludes it by
   * construction rather than by a filter someone has to remember to add.
   */
  'voided',
] as const;
export type ActivityRecordStatus = (typeof ACTIVITY_RECORD_STATUSES)[number];

/**
 * An activity record as returned/accepted by the API (DB-shaped). `calculation`
 * is the immutable snapshot produced by the calc engine at write time — the same
 * shape as a preview `CalculationResult`.
 */
export interface ActivityRecordDTO {
  id: string;
  subsidiaryId: string;
  /** Optional operational location this entry is attributed to (data_entry_page.md §5.2). When
   * set, it drives the emission-factor geography instead of the subsidiary's. */
  locationId: string | null;
  /** The location's name, resolved at read time (null for subsidiary-level
   *  records, or when the location has since been removed). Uniqueness includes
   *  `location_id`, so without this two records can be indistinguishable in a
   *  list while being different reporting entities. */
  locationName?: string | null;
  reportingYear: number;
  reportingPeriod: ReportingPeriod;
  periodValue: string;
  category: Category;
  /**
   * Which fuel, gas or activity within the category (LP3-03, K1 = A1; see
   * `CATEGORY_ACTIVITY_TYPES`). Null for an implicit category and for every
   * record written before LP3-03. Part of the record's identity: the unique
   * index ends `category, activity_type`.
   *
   * Optional in this type only so that fixtures written before LP3-03 still
   * compile: the API returns it on every record once LP3-03's schema change
   * lands, and a reader treats `undefined` as null.
   */
  activityType?: string | null;
  scope: number;
  status: ActivityRecordStatus;
  activityValue: number;
  activityUnit: string;
  input: Record<string, unknown> | null;
  /** Immutable snapshot written at create/update time. Narrow it with
   *  `isCalculated()` before reading `tCo2e` or any factor field — an
   *  invoice-tracked category with no seeded factor stores the explicit
   *  "not calculated" shape instead. */
  calculation: ActivityCalculationSnapshot;
  createdBy: string;
  /**
   * Who entered the record, resolved at read time. `null` means the profile is
   * gone: identity is joined at read time precisely so an erasure removes the
   * name, and `createdBy` survives as an opaque id.
   *
   * REQUIRED, and deliberately so. The first cut made this optional and
   * resolved it only on reads, on the reasoning that a write response answers
   * "what is the record now" rather than "who are these people". Three review
   * seats independently found the same defect: both screens splice a write
   * response into state built from a read, so the name vanished from the row at
   * the exact moment a reviewer took the record into review — and on the void
   * confirmation, which is the one irreversible act in the product.
   *
   * What REQUIRED actually buys, stated precisely because the first version of
   * this note got it wrong: a write path CANNOT OMIT the field. Leaving it out
   * of the single `toDTO` every response funnels through is a compile error,
   * which is the whole defence against the regression above.
   *
   * It is NOT what keeps a resolved name out of the audit snapshot — that was
   * true of the bare-`Omit` predecessor and is no longer true. The guard is now
   * `[K in ResolvedRecordFields]?: never`, an assignability check that fires on
   * a required field AND an optional one, and on a spread as well as a direct
   * property. Measured all four ways when `voidedByName` was added. `audit_log`
   * is append-only with no correction path, so that guard has to be real — and
   * it is real independently of this decision.
   *
   * The cost that motivated `optional` turned out to be near zero: the auth
   * guard already loads the caller's whole profile on every request, so a
   * create resolves without a query at all.
   */
  createdByName: string | null;
  anomalyFlag: boolean;
  /**
   * What the verdict above was taken against: how many comparable periods
   * carried a figure, and their rolling average in tCO₂e.
   *
   * `anomalyFlag: false` is not one claim but three — "clean against three
   * priors", "clean against fewer", and "never evaluated" — and until these
   * fields existed nothing on the wire could tell them apart. **THREE STATES:**
   *
   * - `null` — the pool was never queried, because the record carries no figure
   *   of its own. It may still sit on a full year of neighbours: "has no figure"
   *   and "has no priors" are different facts about different rows, and a `0`
   *   for both forced every reader outside TypeScript to re-implement
   *   `isCalculated()` to separate them.
   * - `0`–`2` — a short window. The rule did NOT run; the record is *not
   *   evaluated*, which is not the same claim as *not anomalous*.
   * - `ANOMALY_BASELINE_PERIODS` — evaluated, and `anomalyBaselineTCo2e` is the
   *   average it was judged against.
   *
   * `anomalyBaselineTCo2e` is non-null exactly when the count is
   * `ANOMALY_BASELINE_PERIODS`. **A value of `0` there is a fourth state**: a
   * full window whose average is zero yields no ratio, so the verdict is vacuous
   * rather than clean — 500 tCO₂e against three zero priors is reported
   * identically to a value in line with its history. Present it as *not
   * evaluated*, never as a baseline that was met.
   *
   * Not to be confused with `TargetDTO.baselineTCo2e`, which is a reduction
   * target's baseline-YEAR emissions and an unrelated quantity. Hence the
   * `anomalyBaseline` prefix on both fields.
   *
   * Written at the same three moments as `anomalyFlag` (create, update,
   * submit) and never revisited afterwards, so all three describe the pool as it
   * stood when the verdict was taken — not as it stands now. `pnpm anomaly:probe`
   * reports where the two have diverged; `pnpm anomaly:recompute` repairs it,
   * except on `approved`/`locked` records, which it reports and leaves alone.
   */
  anomalyBaselinePriorCount: number | null;
  anomalyBaselineTCo2e: number | null;
  /** The AUTHOR's justification for an anomalous value (VAR §4). */
  varianceReason: string | null;
  /** Who decided the review outcome, when, and why. `reviewNote` carries the
   * REVIEWER's words — a rejection reason never overwrites `varianceReason`. */
  reviewedBy: string | null;
  /**
   * Who decided the outcome, resolved at read time. `null` here carries one
   * more meaning than it does on `createdByName`: `reviewedBy` is itself null on
   * a record nobody has reviewed, so a null name can mean "no reviewer yet"
   * rather than "the reviewer's profile is gone". `reviewedBy` is what tells
   * those apart, which is why it stays on the DTO beside the name — rendering
   * an unreviewed record as "deleted user" would claim someone decided it.
   */
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /**
   * When this record was last SUBMITTED for review, or null if it never was.
   *
   * Most recent submit, not the first: a rejected record can be resubmitted, so
   * this answers "how long has the current reviewer had it" — which is what a
   * queue is for — and matches how `reviewedAt` is already overwritten on every
   * review outcome. `audit_log` keeps one `submit` row per attempt, so the full
   * history is not lost.
   *
   * Null on every record that predates the column and on every seeded record:
   * the seed writes straight to `approved` without ever submitting, so the
   * backfill finds nothing for them. Screens must render that as unknown, never
   * fall back to `createdAt` — that fallback IS the misstatement this field
   * exists to end.
   */
  submittedAt: string | null;
  /**
   * Why an approved figure was withdrawn, by whom, and when. Null on
   * every record that has not been voided.
   *
   * Separate from `reviewNote` deliberately — that is a reviewer's verdict on
   * data still in the inventory, this is the record of taking data OUT of it.
   * A screen that showed one where it meant the other would report a rejection
   * as a restatement.
   */
  voidReason: string | null;
  voidedBy: string | null;
  /**
   * Who withdrew the figure, resolved at read time.
   *
   * The third FK-less actor, and the last one to get a name. It was left out
   * deliberately when `createdByName` and `reviewedByName` landed — a third
   * REQUIRED field with no consumer is expensive to undo — and is added now
   * that a consumer exists. `null` carries the same two meanings it does on
   * `reviewedByName`: `voidedBy` is itself null on a record nobody withdrew, so
   * a null name can mean "never withdrawn" rather than "the profile is gone".
   * `voidedBy` stays on the DTO beside it as the discriminator.
   *
   * WHY IT MATTERS MORE HERE THAN ON THE OTHER TWO. A withdrawal is the one
   * action this product cannot undo: the reason is uncorrectable by design and
   * the record is terminal. FR §5.4 ties it to ISO 14064-1 §9.3.1
   * traceability, and until now a restatement said WHEN and WHY but never WHO
   * — the person was reachable only by opening `/audit` and knowing to look.
   */
  voidedByName: string | null;
  voidedAt: string | null;
  /** The bulk import that created this record, or null for one entered by hand. */
  importBatchId: string | null;
  /** Number of evidence files linked to this record (FR §4.1). */
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateActivityRecordInput {
  subsidiaryId: string;
  /** Optional location within the subsidiary; drives factor geography when set. */
  locationId?: string | null;
  reportingYear: number;
  reportingPeriod: ReportingPeriod;
  periodValue: string;
  category: Category;
  /**
   * See `ActivityRecordDTO.activityType` — one of `recordActivityTypesFor(category)`,
   * or null. Do not send it before LP3-03's schema change lands: until then
   * the API refuses it as an unknown property.
   */
  activityType?: string | null;
  activityValue: number;
  activityUnit: string;
  input?: Record<string, unknown> | null;
  varianceReason?: string | null;
}

/** All fields optional; `subsidiaryId` is immutable and cannot be changed here. */
export type UpdateActivityRecordInput = Partial<
  Omit<CreateActivityRecordInput, 'subsidiaryId'>
>;

/** Body of POST /activity-records/:id/reject — the reviewer's variance reason. */
export interface RejectInput {
  varianceReason: string;
}

/**
 * Body of POST /activity-records/:id/void — the mandatory reason a revision entry requires for
 * withdrawing an approved figure from the inventory.
 *
 * A separate type from `RejectInput` despite the identical shape, because they
 * are opposite acts: a rejection sends a record BACK to its author to fix, a
 * void takes an accepted figure OUT of what the organisation reports. Sharing
 * one type would invite sharing one screen and one sentence for the two.
 */
export interface VoidInput {
  voidReason: string;
}

/**
 * How long an explanation ABOUT a figure may be — one number for all three.
 *
 * This product now carries three of them, and they were three independent
 * literal `2000`s: `voidReason` (why a reported figure was withdrawn),
 * `reviewNote` (why a reviewer sent a record back — the field on
 * `RejectActivityRecordDto`, confusingly NAMED `varianceReason`), and
 * `varianceReason` itself (why a figure deviates from its baseline). They are
 * the same act — a person accounting for a number to another person who will
 * read it verbatim — so they take the same bound from one place.
 *
 * The alternative was to give `varianceReason` its own constant "mirroring"
 * the reviewer's 2,000. Three seats independently called that what it is:
 * coincidence dressed as a rule. Raising one of two matching literals is
 * exactly the drift `VOID_REASON_*` was extracted to prevent.
 */
export const EXPLANATION_MAX_LENGTH = 2000;

/**
 * How long a void reason has to be, in ONE place.
 *
 * The browser and the DTO used to hold these as independent literals, and a
 * mutation test proved what that costs: raising the client's maximum to 20,000
 * broke nothing in the suite, because the web spec pinned the constant against
 * itself. A user would then have typed 3,000 characters of restatement
 * justification into a box that accepted them and watched a 400 come back.
 *
 * The minimum fails the other way: a client stricter than the server blocks a
 * legitimate withdrawal for a rule the server does not have.
 *
 * Same reasoning as `COUNTED_STATUSES` — a rule written down twice is a rule
 * that will disagree with itself, and this one gates an irreversible write.
 */
export const VOID_REASON_MIN_LENGTH = 10;
export const VOID_REASON_MAX_LENGTH = EXPLANATION_MAX_LENGTH;

/**
 * The upper bound on a `periodValue`, on records and period locks alike.
 *
 * NOT the mechanism that keeps the two matchable — `canonicalPeriodValue`
 * is. Both write paths reduce the value to one of the seventeen tokens above
 * and reject anything else, so neither column can hold a string over nine
 * characters with or without this cap. (An earlier draft of this comment
 * claimed a one-sided cap would make a lock unmatchable by its own records.
 * It cannot: the canonicaliser refuses the long value first, on both sides.)
 *
 * What it buys is the refusal happening BEFORE the work: a bulk importer reads
 * cells out of a file it did not write, and a multi-megabyte cell should not
 * travel through the DTO pipeline and a vocabulary lookup — whose 400 echoes
 * the value back — to be told it is not `January`. 32 over a longest token of
 * `September` (9) is headroom for a vocabulary that grows, not for a user.
 */
export const PERIOD_VALUE_MAX_LENGTH = 32;

/**
 * The upper bound on an `activityUnit`, on both record write DTOs.
 *
 * NOT a refusal that comes earlier than the vocabulary's, and not a bound the
 * vocabulary already applies. `@IsActivityUnit` runs whatever this says —
 * class-validator evaluates every constraint on a property — and it ACCEPTS a
 * padded spelling of any length, because `canonicalUnit` collapses whitespace:
 * `cubic`, 30,000 spaces and `metres` is `cubic_metres` to it.
 *
 * What this bounds is what gets STORED and quoted. The column itself holds
 * the vocabulary's canonical spelling (the API resolves the alias at the
 * write), but the spelling AS SENT is frozen into the record's calculation
 * snapshot as `inputUnit`, reaches the audit row and is quoted back in a
 * refusal — the argument the other caps here were added for, on a column a
 * bulk import fills from a file nobody at this company wrote.
 *
 * 32 clears the longest spelling the vocabulary knows, `standard_cubic_metres`
 * (21; the longest it can actually calculate is `passenger_kilometres`, 20),
 * with headroom for a vocabulary that grows and for a spelling with its words
 * spaced out (`standard cubic metres`), not for a user.
 */
export const ACTIVITY_UNIT_MAX_LENGTH = 32;

/**
 * The upper bound on the free-text descriptors of a subsidiary — `legalName`,
 * `tradingName`, `location`, `businessArea`, `sector`, `designatedPerson`.
 *
 * All six, not just the names: they are one class of field, every one is
 * unbounded `text` in Postgres, and every one reaches a generated PDF, an
 * Excel sheet and a CSV cell verbatim. #81 decided what such a cell may START
 * with; nothing decided how long it may be.
 *
 * 200 clears UK Companies House's 160-character company-name limit and a full
 * Turkish legal form (`… Sanayi ve Ticaret Anonim Şirketi`) with room to
 * spare. It is the one cap here a real user can plausibly reach, which is why
 * the number is argued rather than assumed.
 *
 * Still uncapped and deliberately out of scope: the location, target and
 * intensity-denominator DTOs. Capping those belongs with the modules that own
 * them — and one E2E spec asserts a 413 on a 400-character location name.
 */
export const SUBSIDIARY_TEXT_MAX_LENGTH = 200;

/**
 * What a record with no location is called, everywhere it is named.
 *
 * TonyAI's tiers are organisation (the holding) -> subsidiary (a company) ->
 * location (a site), so a record attributed to the subsidiary itself is the
 * whole COMPANY, and "Whole organisation" means something else again (the
 * report scope filter). One constant because the app and the generated report
 * now both print this phrase, and the record drawer's confirmation dialog is
 * the one place a user reads it before an irreversible write.
 */
export const WHOLE_COMPANY_ENTITY_LABEL = 'Whole company';

/**
 * What a row attributed to a site whose NAME did not come back is called.
 *
 * Reachable only when a caller passes a record loaded without the location
 * join. Saying "whole company" there would misstate the reporting entity in an
 * audit-ready export; saying nothing would hide that a site is involved at all.
 */
export const UNNAMED_SITE_ENTITY_LABEL = 'Site (name unavailable)';

/**
 * The reporting entity in one phrase — the site's name, or the whole company.
 *
 * Keyed on the PAIR, never on the name alone. `locationName` is optional on the
 * contract because it is carried by an `include` only some queries ask for
 * (`ActivityRecordsService.toDTO` returns `Omit<…, 'locationName'>` precisely so
 * a read path cannot forget it), so a name-only test would call a SITE row "the
 * whole company" the first time a caller passed a record loaded without the
 * join — a misstatement of the reporting entity in an artifact an auditor
 * keeps, not a wording slip. `locationId` is the fact; the name is a decoration
 * on it. Data Entry has degraded on `locationId` for exactly this reason since
 * WP16, and this is that rule promoted to the one shared helper.
 *
 * A null name with no id is the genuine company level — or a location that has
 * since been removed, a case WP16's delete guards made unreachable.
 * Whitespace is trimmed first: a location named "   " would otherwise print as
 * a blank cell, which reads as a missing value rather than as a level.
 */
export function entityLabel(record: {
  locationId?: string | null;
  locationName?: string | null;
}): string {
  const named = record.locationName?.trim();
  if (named) return named;
  return record.locationId ? UNNAMED_SITE_ENTITY_LABEL : WHOLE_COMPANY_ENTITY_LABEL;
}

/**
 * The statuses a reviewer's queue is made of: a record that has left the
 * submitter's hands but has not yet been decided.
 *
 * This is one list, not two independent ones, because the two statuses mean
 * "waiting" in exactly the same sense — `under_review` only records that a
 * reviewer has opened it, and nothing collects records a reviewer abandoned
 * mid-review. Splitting the queue on that flag would strand those rows in a
 * tab nobody watches, which is the failure mode a review queue exists to
 * prevent. `period-locks` uses the same list to refuse closing a period that
 * still has undecided records, so the two must never drift apart.
 */
/**
 * The statuses whose records are part of the emissions inventory — what every
 * total, export, matrix cell and anomaly baseline counts.
 *
 * Lives here, beside the status list itself, because it was written out twice:
 * once in `emissions.service.ts` and once as a separate literal in
 * `targets.service.ts`, with nothing tying them together. Two hand-maintained
 * copies of "what counts" is how a status gets added to one and forgotten in
 * the other, and the symptom would be a target reporting progress against a
 * different number from the dashboard.
 *
 * An **allow-list**, deliberately: a new status counts towards nothing until
 * someone adds it here on purpose. That is what made `voided` safe to
 * introduce — it is excluded from every total by construction rather than by a
 * filter each call site had to remember.
 */
export const COUNTED_STATUSES = [
  'submitted',
  'under_review',
  'approved',
  'locked',
] as const satisfies readonly ActivityRecordStatus[];

export const PENDING_REVIEW_STATUSES = [
  'submitted',
  'under_review',
] as const satisfies readonly ActivityRecordStatus[];

/** VAR §4.2 — the deviation from the rolling average that raises the warning. */
export const ANOMALY_THRESHOLD = 0.5;

/**
 * VAR §4.1 — the rolling average is over the previous 3 comparable periods.
 * This is BOTH the window and the requirement: fewer than three priors with a
 * figure means the rule does not run.
 *
 * The implementation used to take "up to 3, minimum 1", which the spec does not
 * sanction and no surface disclosed: the gate degraded from a three-period
 * average to a single-period comparison with nothing recording that it had.
 * Measured before the change (`pnpm anomaly:probe`), 30 of 96 committed records
 * sat below three and NONE of them was flagged — so applying the spec literally
 * moved no figure, only what the absence of a flag is allowed to mean.
 *
 * Both numbers live here rather than in `activity-records.service.ts` because
 * the API is no longer the only thing that has to state the rule: a screen that
 * cannot say "2 of 3" is misleading about what a missing flag means, and a
 * second copy in `apps/web` is how the two halves come to disagree.
 */
export const ANOMALY_BASELINE_PERIODS = 3;

/**
 * The VAR §4 outcome AND what it was decided against.
 *
 * Lives here rather than in `activity-records.service.ts` because the API is no
 * longer the only thing that produces one: `pnpm anomaly:recompute` re-derives
 * verdicts outside the request path, and a second implementation of the fold
 * would differ from the service's in the last ULP at best and in the rule at
 * worst.
 */
export interface AnomalyVerdict {
  /** VAR §4.3 — the warning. False whenever the rule did not run. */
  anomalous: boolean;
  /** Comparable periods that carried a figure, 0..`ANOMALY_BASELINE_PERIODS` —
   *  or null when the pool was never queried at all. */
  priorCount: number | null;
  /** The rolling average — non-null exactly when the rule ran on a full window. */
  baseline: number | null;
}

/** The verdict for a record the rule cannot judge. `priorCount` carries how
 *  close it came, or null when no pool was ever looked at. */
export function anomalyNotEvaluated(priorCount: number | null = null): AnomalyVerdict {
  return { anomalous: false, priorCount, baseline: null };
}

/**
 * VAR §4's arithmetic, in ONE place.
 *
 * `orderedPriorTCo2e` is the comparable periods NEWEST FIRST, already scoped to
 * the reporting entity and to committed statuses by the caller — a `null`
 * element is a prior that carries no figure. Selecting that list is the
 * caller's job (it needs a database); judging it is this function's.
 *
 * The split matters: the caller can be a Prisma query or a script holding rows
 * in memory, and neither may re-derive the window, the drop rule, the strict
 * three, the zero-baseline case or the threshold comparison. Reimplementing the
 * fold is how two writers of the same column come to disagree by a ULP — which
 * was measured, at 3.6e-16, between this arithmetic and Postgres's `avg()`.
 */
export function computeAnomalyVerdict(
  currentTCo2e: number,
  orderedPriorTCo2e: readonly (number | null)[],
): AnomalyVerdict {
  const priorValues = orderedPriorTCo2e
    .slice(0, ANOMALY_BASELINE_PERIODS)
    // Dropped, not zero-filled: a zero would deflate the average and
    // manufacture a false anomaly. The slot it occupied is still spent, which
    // is what leaves the window short below.
    .filter((v): v is number => v !== null);

  // VAR §4.1 requires the previous THREE periods, so a short window means the
  // rule does not run rather than running on whatever is left. The count is
  // reported either way: it is the difference between "checked and clean" and
  // "never checked".
  if (priorValues.length < ANOMALY_BASELINE_PERIODS) {
    return anomalyNotEvaluated(priorValues.length);
  }
  const baseline = priorValues.reduce((sum, v) => sum + v, 0) / priorValues.length;
  // A full window averaging to zero yields no ratio. Still REPORTED rather than
  // nulled: three priors that are all zero is a fact about the series.
  if (baseline === 0) {
    return { anomalous: false, priorCount: priorValues.length, baseline };
  }
  return {
    anomalous: Math.abs(currentTCo2e - baseline) / baseline > ANOMALY_THRESHOLD,
    priorCount: priorValues.length,
    baseline,
  };
}

/**
 * Did the anomaly rule actually RUN on this record?
 *
 * One predicate everywhere, for the same reason `isCalculated()` is one: the
 * question has four wrong answers and they all look like `anomalyFlag: false`.
 * A record is evaluated only when the window was full AND the average it was
 * judged against is a usable divisor:
 *
 * - `anomalyBaselinePriorCount === null` — no figure of its own, no pool queried.
 * - `< ANOMALY_BASELINE_PERIODS` — a short window; VAR §4.1 needs three.
 * - `anomalyBaselineTCo2e === null` — the average was never taken.
 * - `anomalyBaselineTCo2e === 0` — a full window that averages to zero yields no
 *   ratio, so the verdict is vacuous: 500 tCO₂e against three zero priors reads
 *   exactly like a value in line with its history. The subtlest of the four,
 *   and the one a hand-written check at a call site would miss.
 *
 * When this is false, "not anomalous" is not a claim anyone made — and any
 * surface that renders a blank, a tick or a green cell is overstating.
 */
export function isAnomalyEvaluated(record: {
  anomalyBaselinePriorCount: number | null;
  anomalyBaselineTCo2e: number | null;
}): boolean {
  return (
    record.anomalyBaselinePriorCount === ANOMALY_BASELINE_PERIODS &&
    record.anomalyBaselineTCo2e !== null &&
    record.anomalyBaselineTCo2e !== 0
  );
}

/**
 * The counted statuses a PERSON has accepted — the other half of the partition
 * `PENDING_REVIEW_STATUSES` starts (asserted in this package's own spec).
 *
 * Exported because WP19 made it the definition of a green tracking-matrix cell,
 * and until then it lived as a private `REVIEWED_STATUSES` inside the emissions
 * service — a third hand-maintained copy of a list `COUNTED_STATUSES` was moved
 * here to stop having. `locked` belongs beside `approved`: a lock freezes data a
 * reviewer already accepted, so reading this as `approved` alone would turn
 * every locked period amber.
 */
export const ACCEPTED_STATUSES = [
  'approved',
  'locked',
] as const satisfies readonly ActivityRecordStatus[];

/**
 * Optional filters for GET /activity-records (all AND-combined).
 *
 * `status` is a set because the reviewer queue is defined by one, not by a
 * single state. Over the wire it is a comma-separated list, so a bare
 * `?status=draft` from an existing client still parses; the TypeScript side is
 * an array only — a scalar arm would buy nothing (no caller passes one) and
 * would seed an `Array.isArray` branch in every future multi-valued filter.
 */
export interface ListActivityRecordsParams {
  subsidiaryId?: string;
  year?: number;
  period?: ReportingPeriod;
  category?: Category;
  status?: readonly ActivityRecordStatus[];
}

// ---------------------------------------------------------------------------
// Period locking (Phase 1, FR §4.2) — closing a reporting period.
// A lock freezes one subsidiary's specific reporting period (e.g. 2024/Q1):
// no new records, no edits/deletes/submits; committed records flip to `locked`
// status (and back to `approved` on unlock). super_admin only.
// ---------------------------------------------------------------------------

export interface PeriodLockDTO {
  id: string;
  subsidiaryId: string;
  reportingYear: number;
  reportingPeriod: ReportingPeriod;
  periodValue: string;
  lockedBy: string;
  createdAt: string;
}

export interface CreatePeriodLockInput {
  subsidiaryId: string;
  reportingYear: number;
  reportingPeriod: ReportingPeriod;
  periodValue: string;
}

// ---------------------------------------------------------------------------
// Evidence (Phase 1, FR §4.1 / §6) — supporting files linked to a record.
// ---------------------------------------------------------------------------

/**
 * Categories that require at least one evidence file before a record may be
 * submitted / counted as "complete" (FR §4.1 "categories configured as evidence
 * required"). Scope 1 & 2 billed inputs are invoice/meter/fuel-log backed.
 *
 * `Water` was added in WP17, and the reasoning is worth keeping because the
 * first cut got it wrong. It was left out on the grounds that there is "no
 * factor to gate on" — which conflates two different gates. The evidence gate
 * is about proof of the READING, not about the factor. And a water record has
 * no other check at all: no factor means no figure, no figure means the anomaly
 * baseline skips it, so without the invoice any number whatsoever could be
 * typed in and nothing in the system could contradict it. The invoice is the
 * only verification such a record can ever carry — and it is the same artifact
 * the completeness engine counts.
 *
 * Adding it here rather than later is deliberate: a water draft saved while the
 * gate was absent would become unsubmittable the moment it appeared.
 */
export const EVIDENCE_REQUIRED_CATEGORIES: Category[] = [
  'Electricity',
  'Natural Gas',
  'Fuel',
  'Water',
];

/** True when the given category must have evidence attached to be complete. */
export function isEvidenceRequired(category: string): boolean {
  return (EVIDENCE_REQUIRED_CATEGORIES as string[]).includes(category);
}

/**
 * Does this record still need an evidence file before it can be submitted?
 *
 * Here, and not once per side, because it is a compliance rule and it has
 * already been copied wrongly once: the bulk importer held a row back on its
 * CATEGORY alone, which only looks like this rule because every imported row is
 * brand new and therefore has no files. A draft that has been sitting on the
 * record list with its invoice attached is submittable, and the category-only
 * copy refused it forever. The count is an INPUT — the API counts rows, the web
 * reads `ActivityRecordDTO.evidenceCount` — but the rule over those two values
 * is one rule.
 *
 * The refusal SENTENCE stays with the thrower (`EVIDENCE_REFUSAL_FRAGMENT`);
 * only the predicate lives here.
 */
export function needsEvidenceBeforeSubmit(row: {
  category: string;
  evidenceCount: number;
}): boolean {
  return isEvidenceRequired(row.category) && row.evidenceCount === 0;
}

/**
 * Categories tracked at INVOICE level for completeness: one invoice per
 * location per month (WP17 / round-1 DASH-3, product decision 2026-07-31).
 * Every other category stays a simple complete/incomplete.
 *
 * **This is deliberately NOT `EVIDENCE_REQUIRED_CATEGORIES`, despite the
 * overlap.** They answer different questions, and Fuel is the case that proves
 * the two sets are not the same one:
 *
 * | Category    | Evidence-required (submit gate) | Invoice-tracked (denominator)  |
 * | ----------- | ------------------------------- | ------------------------------ |
 * | Electricity | yes                             | yes                            |
 * | Natural Gas | yes                             | yes                            |
 * | Fuel        | yes                             | **no** — not a metered utility |
 * | Water       | yes                             | yes                            |
 *
 * Reusing the evidence list as the denominator would give Fuel a
 * `locations × 12 months` requirement it should not have.
 *
 * The completeness engine that consumes this ships in the next PR. It is
 * declared here because `compute()` already depends on it: the invariant
 * "recordable without a factor ⇒ invoice-tracked" is enforced at that call
 * site, which is what makes the stored `reason` string true.
 */
export const INVOICE_TRACKED_CATEGORIES: Category[] = [
  'Electricity',
  'Natural Gas',
  'Water',
];

/**
 * True when completeness for this category is measured in monthly invoices per
 * location rather than a simple yes/no.
 */
export function isInvoiceTracked(category: string): boolean {
  return (INVOICE_TRACKED_CATEGORIES as string[]).includes(category);
}

/**
 * Categories that may be RECORDED even though no emission factor resolves —
 * the entry is stored with an `UncalculatedSnapshot` instead of being refused.
 *
 * An explicit list, not the rule "invoice-tracked and no factor found". That
 * broader rule reads well and is wrong: `Electricity` is invoice-tracked, so a
 * request for a geography the library does not cover (`ZZ`, or a year before
 * the factor set) would have been quietly accepted with no emissions figure.
 * Electricity is the core of the inventory; a missing factor there is a gap to
 * refuse loudly, not to absorb.
 *
 * What is on this list is a category the product tracks by invoice while
 * *nothing anywhere* can calculate it. Today that is Water alone.
 *
 * This is a PERMISSION, not a claim: it never fires while a factor resolves. So
 * when the Phase-4 library seeds Water, water records calculate normally and
 * this entry simply stops being reached — but it should still be removed then,
 * together with the `normalize()` fix that Water will need (m³ is currently
 * converted at the natural-gas calorific value, which is wrong for water).
 */
export const FACTORLESS_RECORDABLE_CATEGORIES: Category[] = ['Water'];

/** True when a record in this category may be stored without a calculated figure. */
export function isRecordableWithoutFactor(category: string): boolean {
  return (FACTORLESS_RECORDABLE_CATEGORIES as string[]).includes(category);
}

/** Allowed evidence file MIME types (mirrors the `evidence` bucket config). */
export const EVIDENCE_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
] as const;

/** Max evidence file size in bytes (mirrors the bucket's 10 MiB limit). */
export const EVIDENCE_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * The most records one uploaded file may back. The upload is made from the
 * Data Entry selection list, whose own ceiling is the bulk submit's
 * (`BULK_SUBMIT_MAX_IDS`, the same number); a spec pins the two together.
 */
export const EVIDENCE_MAX_LINKED_RECORDS = 1000;

/**
 * One record an evidence file backs — what a reviewer needs to judge whether
 * one invoice can honestly evidence all of them (the same month? the same
 * site?). Every linked record is in the file's subsidiary, so whoever can read
 * the file can read each of these.
 */
export type EvidenceLinkedRecordDTO = Pick<
  ActivityRecordDTO,
  'id' | 'category' | 'reportingYear' | 'periodValue' | 'status'
> & {
  /** The record's site, or null for a whole-company record. */
  locationName: string | null;
};

/**
 * An evidence file's metadata as returned by the API (never the binary).
 *
 * A file belongs to a SUBSIDIARY and backs one or more of its records (WP8
 * decision 3a); `linkedRecords` lists all of them, the record it was fetched
 * through included, so "also backs N other records" is visible wherever the
 * file is.
 * LP4-05's paged GET /activity-records/:id/evidence preserves this complete
 * nested list, capped at EVIDENCE_MAX_LINKED_RECORDS. An excessive stored link
 * count is an integrity error, never a reason to silently omit links. The
 * outer CursorPage<EvidenceDTO> orders files by createdAt DESC, id DESC;
 * aggregate response work/bytes may additionally refuse query_too_broad.
 */
export interface EvidenceDTO {
  id: string;
  subsidiaryId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
  linkedRecords: EvidenceLinkedRecordDTO[];
}

/** Why one record refused a file in `POST /evidence` — the upload is all or nothing. */
export interface EvidenceLinkRefusal {
  recordId: string;
  reason: string;
}

/**
 * The 400 body of `POST /evidence` when any named record cannot take the file:
 * nothing is uploaded and nothing is linked, and every refused record is named.
 *
 * Not the only 400 that route returns. A request-level refusal — records of
 * more than one subsidiary, or a missing or refused file — is the ordinary
 * `{ message }` body, and malformed `recordIds` get the validation body
 * (`message: string[]`). Only this one carries `refused`.
 */
export interface EvidenceLinkRefusedDTO {
  message: string;
  refused: EvidenceLinkRefusal[];
}

/** Response of `DELETE /activity-records/:recordId/evidence/:evidenceId`. */
export interface EvidenceDetachDTO {
  evidenceId: string;
  recordId: string;
  /** True when that was the file's last link, so the file itself was deleted. */
  fileDeleted: boolean;
}

/** Response of GET /evidence/:id/url — a short-lived signed download link. */
export interface EvidenceUrlDTO {
  url: string;
  /** Seconds until the signed URL expires. */
  expiresIn: number;
}

// ---------------------------------------------------------------------------
// Emissions analytics summary (Phase 1) — aggregation of activity records.
// Computed server-side (tenant-scoped) from the immutable `calculation`
// snapshots, so the numbers are the single source of truth and reproducible.
// ---------------------------------------------------------------------------

/** tCO₂e split by GHG Protocol scope, plus the combined total. */
export interface EmissionsScopeTotals {
  scope1: number;
  scope2: number;
  scope3: number;
  total: number;
}

/** One category's contribution to the total inventory. */
export interface EmissionsByCategory {
  category: Category;
  scope: number;
  tCo2e: number;
  recordCount: number;
  /** Share of the (filtered) grand total, 0–100. */
  percentOfTotal: number;
}

/** One subsidiary's contribution — used for the "top contributors" view. */
export interface EmissionsBySubsidiary {
  subsidiaryId: string;
  subsidiaryName: string;
  tCo2e: number;
  recordCount: number;
  /** Share of the (filtered) grand total, 0–100. */
  percentOfTotal: number;
}

/** One point on a time-series trend, split by scope. */
export interface EmissionsTrendPoint {
  /** Bucket label, e.g. "2024", "2024-Q1" or "January 2024". */
  period: string;
  scope1: number;
  scope2: number;
  scope3: number;
  total: number;
}

/**
 * Aggregated emissions inventory for the caller's accessible subsidiaries,
 * after any requested filters. Trends are pre-bucketed at three granularities.
 */
export interface EmissionsSummary {
  totals: EmissionsScopeTotals;
  byCategory: EmissionsByCategory[];
  bySubsidiary: EmissionsBySubsidiary[];
  trend: {
    monthly: EmissionsTrendPoint[];
    quarterly: EmissionsTrendPoint[];
    yearly: EmissionsTrendPoint[];
  };
  /** Every committed activity record in scope, whether or not it produced a
   *  figure. Always equals `calculatedRecordCount + uncalculatedRecordCount`. */
  recordCount: number;
  /** Of those, the ones that contributed to `totals`. */
  calculatedRecordCount: number;
  /**
   * Of those, the ones EXCLUDED from every total because their stored snapshot
   * carries no usable figure — in practice a category with no emission factor
   * (WP17 — Water), but the test is the snapshot, not the category.
   *
   * Declared rather than silently dropped: those entries exist, they count
   * towards data completeness, and a user comparing "12 water invoices filed"
   * against a breakdown that never mentions water needs the two numbers to be
   * reconcilable. They are kept OUT of `byCategory` on purpose — a "Water,
   * 0 tCO₂e" row asserts a measurement nobody made.
   */
  uncalculatedRecordCount: number;
  /** Statuses included in the aggregation — drafts, rejected and voided
   *  records are all excluded. */
  statusesIncluded: ActivityRecordStatus[];
}

// ---------------------------------------------------------------------------
// Tracking matrix (Phase 1) — subsidiary × category completeness per FR §2.
// Status semantics (functional_requirements.md §2.2):
//   missing    — no activity record exists for the cell
//   incomplete — a record exists but is draft/rejected, or flagged as anomaly
//   complete   — all records are committed (submitted/under_review/approved/
//                locked) and none are flagged
// The FR "required evidence attached" condition IS implemented (it shipped with
// the evidence backend in Phase 1) — a committed record with no file in an
// evidence-required category holds its cell below `complete`.
//
// WP17 adds a second reading of `complete` for the three invoice-tracked
// categories on a location-measured subsidiary: `locations × 12` monthly
// invoices. `missing` keeps its meaning in BOTH — no record exists for the cell
// — so a cell holding records whose slots are not closed is `incomplete`.
// ---------------------------------------------------------------------------

/**
 * How many of the invoices a cell expects are actually in.
 *
 * Present ONLY on an invoice-tracked category of a `location`-granularity
 * subsidiary — the one case where completeness is a fraction rather than a
 * yes/no. Everywhere else it is absent, which is what stops a UI from rendering
 * "0/0" for a category the rule does not apply to.
 *
 * **The counters are not homogeneous.** The four `*Records` fields count
 * RECORDS and are disjoint from `covered` — each names committed data that
 * closed no slot. `awaitingReviewSlots` counts SLOTS and is a SUBSET of
 * `covered`. A consumer that lumps all five into one "explain the shortfall"
 * list computes nonsense; the first four explain why `covered < required`, the
 * fifth names WHICH months are waiting on a reviewer.
 *
 * None of the five decides the verdict on its own. Since WP19 the review gate
 * is `awaitingReviewRecords` — a RECORD count that lives beside this object,
 * not in it — because a fully covered, fully accepted slot set can still sit
 * behind a record nobody has reviewed.
 */
export interface CellCoverage {
  /**
   * `locations × 12 months` for this one category, for ONE reporting year.
   *
   * Only present on a year-scoped query. Without a year every year's records
   * fold into one cell while `required` stays twelve months' worth, so a
   * subsidiary with a complete 2024 and an empty 2025 would report 24 of 24.
   * The location count is likewise taken as at the end of that year, so a site
   * opened later does not retroactively make a closed year incomplete.
   */
  required: number;
  /** Slots closed by a committed monthly record carrying at least one file. */
  covered: number;
  /**
   * Committed records in this cell attached to NO location.
   *
   * They close nothing, and this is why the count is reported rather than
   * quietly ignored: on a database where 96 of 102 records are subsidiary-level,
   * "0 of 24 covered" next to "12 records exist" is the difference between a
   * user thinking the app lost their data and understanding that those entries
   * are not attributed to a site.
   */
  unattributedRecords: number;
  /**
   * Committed records here reported quarterly or annually.
   *
   * The rule counts one invoice per MONTH, which a quarterly entry cannot
   * satisfy — it closes no slot. Counted so the UI can say why, instead of
   * leaving the user staring at a shortfall they can see no cause for.
   */
  nonMonthlyRecords: number;
  /**
   * Committed monthly records at a location that carry no file.
   *
   * The fourth counter exists so the four numbers EXHAUST the committed
   * records: without it a record that was monthly, attributed and simply
   * unevidenced fell through every bucket, and the coverage object could not
   * explain its own shortfall — which is the single thing it is for.
   */
  missingEvidenceRecords: number;
  /**
   * Committed entries attributed to a site that is NOT in this year's
   * denominator — in practice a location created after the year ended.
   *
   * Reported rather than dropped: the grid cannot show a row for such a site,
   * so without this the invoice simply vanishes. It is also what keeps
   * `covered <= required` true: an earlier cut counted these into the numerator
   * while the denominator excluded their site, and produced a green "Complete"
   * cell reading `1/0`.
   */
  outOfScopeRecords: number;
  /**
   * Of the `covered` slots, how many are closed ONLY by a record nobody has
   * reviewed yet — `submitted` or `under_review` rather than `approved`/`locked`.
   *
   * WHICH months are waiting on a reviewer — a SUBSET of `covered`, never a
   * rival to it. It was round-1 **DE-2**'s answer for invoice-measured cells
   * until WP19 replaced the gate with the record-level
   * `TrackingMatrixCell.awaitingReviewRecords`, which catches the cases a slot
   * count cannot see; this survives as the projection that can NAME the months,
   * which a bare count never could. `COUNTED_STATUSES` treats a submitted record as
   * committed on purpose — the inventory must not lose data sitting in a review
   * queue — but the side effect was that a cell turned green the moment its last
   * invoice was *sent* for review, which is DE-2's complaint verbatim: "On submit
   * for review, the data-collection status turns green immediately."
   *
   * Kept as a separate number rather than deducted from `covered` so the two
   * claims stay independent: `covered` answers "is the data in?", this answers
   * "has anyone accepted it?". Deducting it would have made the emissions total
   * and the collection fraction disagree about the same records.
   */
  awaitingReviewSlots: number;
}

/** One subsidiary × category cell of the tracking matrix. */
export interface TrackingMatrixCell {
  category: Category;
  scope: number;
  status: DataStatus;
  /**
   * Sum of committed records' tCO₂e in this cell, or **null** when no COMMITTED
   * record produced a usable figure. That covers three cases, not the two an
   * earlier draft of this comment listed: no records at all, only drafts, or
   * only records whose category has no emission factor (WP17 — Water).
   *
   * `null` and `0` are different claims: `0` means something was measured and
   * came to zero. This was a plain `number` until the factor-less path shipped,
   * at which point a water cell reported a hard `0` and any consumer other than
   * the dashboard would have read it as a measurement.
   */
  tCo2e: number | null;
  /** All records touching this cell, any status. */
  recordCount: number;
  /** Of the committed ones, how many carried no usable figure. */
  uncalculatedRecordCount: number;
  /**
   * Committed records in this cell that were later WITHDRAWN by an audited void.
   *
   * Reported so the cell can account for rows a reader can see in the record
   * list but not in any total. Excluded from the verdict entirely: a cell whose
   * only record was voided is `missing`, because nothing is reported for it —
   * treating the row as presence once produced a green "Complete" over data
   * somebody had deliberately removed from the inventory.
   */
  voidedRecordCount: number;
  /**
   * Committed records in this cell that no human has accepted yet —
   * `submitted` or `under_review`, i.e. the complement of the reviewed
   * statuses within COUNTED_STATUSES.
   *
   * COUNTS RECORDS, not slots. `coverage.awaitingReviewSlots` counts SLOTS and
   * the two disagree routinely — two unreviewed entries for one site-month are
   * two records and one slot. Never compare them, and never add either to
   * `recordCount`, which includes drafts that neither counter explains.
   *
   * LOAD-BEARING on EVERY cell, invoice-measured or not: a cell holding any
   * unreviewed committed record is `incomplete`. That is round-1 DE-2 ("on
   * submit for review, the status turns green immediately") applied to every
   * category, which is what WP19 decided.
   *
   * THIS field is what the verdict reads — not `coverage.awaitingReviewSlots`,
   * which is reporting only and names WHICH months are waiting. The record form
   * subsumes the slot form (`awaitingReview` is `covered` minus the accepted
   * slots, so an awaiting slot implies an awaiting record and never the
   * reverse) and it catches a case the slot form cannot see at all: an
   * unreviewed record that closed no slot — filed for the whole company, or
   * against a period the monthly rule does not recognise — while its tonnage is
   * already inside the cell's figure.
   *
   * Named to pair with `awaitingReviewSlots` rather than with this object's
   * `*Count` siblings, deliberately: the pair is what makes the unit visible at
   * every call site, and the two sit side by side on `CategoryCompleteness`.
   *
   * On a YEAR-LESS matrix query this folds every year's unreviewed records into
   * one cell, exactly as the rest of that view folds every year's data — so a
   * stray old `submitted` record holds its cell amber in the all-years view.
   *
   * `0`, never absent — including on a `missing` cell.
   */
  awaitingReviewRecords: number;
  /** Invoice coverage — see CellCoverage. Absent unless the rule applies. */
  coverage?: CellCoverage;
  /**
   * ISO timestamp of the most recent update among the cell's LIVE records, or
   * null when it has none.
   *
   * Voided rows do not bump it, and that is a deliberate narrowing rather than
   * an oversight: withdrawing a figure is not an update to the data anyone is
   * still counting, and a cell reading "updated 2 minutes ago" because
   * something was REMOVED from it would point a reader at work that does not
   * exist.
   */
  lastUpdate: string | null;
  /** true when any LIVE record in the cell carries an anomaly flag. A voided
   *  record's flag is ignored — it describes data that no longer counts. */
  anomaly: boolean;
  /**
   * Committed records in this cell that HAVE a figure but that the anomaly rule
   * never ran on — a window shorter than `ANOMALY_BASELINE_PERIODS`, or one
   * averaging to zero (see `isAnomalyEvaluated`).
   *
   * `anomaly: false` alone overstates: it reads as "checked, nothing unusual"
   * for a cell nobody checked. This counter is deliberately NOT a cap on the
   * cell's status (decision 2026-08-27) — a short window is the normal state of
   * any series' first months, and capping would paint every new site's first
   * quarter amber forever. It is reported so the surface can SAY so instead.
   *
   * Records with no figure at all are counted by `uncalculatedRecordCount`, not
   * here: they are a different absence and double-counting them would make the
   * two counters unreconcilable against the cell's own record count.
   */
  notEvaluatedRecordCount: number;
}

/** One subsidiary row of the tracking matrix (cells ordered as CATEGORIES). */
export interface TrackingMatrixRow {
  subsidiaryId: string;
  subsidiaryName: string;
  sector: string | null;
  designatedPerson: string | null;
  /**
   * Sum of the row's MEASURED cells. Stays a plain number, deliberately, even
   * though a cell's `tCo2e` is nullable: this mirrors `EmissionsSummary`, which
   * keeps numeric totals and reports the excluded records alongside them. The
   * pairing is what makes `0` readable — a zero total next to a non-zero
   * `uncalculatedRecordCount` is "nothing was calculable", not "we measured
   * zero".
   */
  totalTCo2e: number;
  /** Committed records across the row that produced no figure. */
  uncalculatedRecordCount: number;
  completeCount: number;
  categoryCount: number;
  /** How this row's completeness was measured — the denominator behind its
   *  cells, so a UI never has to guess why a subsidiary reads incomplete. */
  trackingGranularity: TrackingGranularity;
  /** Locations owned by this subsidiary; the multiplier in `CellCoverage`. */
  locationCount: number;
  cells: TrackingMatrixCell[];
}

/**
 * One `(location, month)` slot of the invoice rule, for the drill-down.
 *
 * The matrix answers "how many are missing"; this answers "which ones", which
 * is the half of round-1 DASH-3 that asks a subsidiary to show *what is keyed
 * in and what is missing* rather than just a fraction.
 */
export interface CompletenessSlot {
  /** Canonical month name, as stored on the record (`January` … `December`). */
  month: string;
  /** True when a committed monthly record with a file closes this slot. */
  covered: boolean;
  /**
   * True when the record closing this slot is still awaiting review. Always
   * `false` where `covered` is `false` — an open slot has nothing to review —
   * so the pair reads as three states, not four: open, in review, accepted.
   */
  awaitingReview: boolean;
}

/** One location's twelve slots for a single invoice-tracked category. */
export interface CompletenessLocationRow {
  locationId: string;
  locationName: string;
  months: CompletenessSlot[];
}

/**
 * One invoice-tracked category's completeness for a subsidiary and year.
 *
 * `covered`/`required` are the same numbers the matrix cell reports — computed
 * by the same function, so the drill-down cannot disagree with the cell that
 * opened it.
 */
export interface CategoryCompleteness extends CellCoverage {
  category: Category;
  /**
   * FR §2.2's verdict for this category — the SAME value the matrix cell
   * carries, produced by the same derivation on the server.
   *
   * On the wire because it cannot be recomputed from the numbers beside it. Two
   * of the four caps behind `incomplete` — a draft in the cell, an anomaly
   * flag — correspond to no field in this object, so a client deriving its own
   * verdict from `covered >= required` badges a cell green that the dashboard is
   * showing amber. That is round-1 DE-2's own failure (a green that overstates),
   * one level up. (Four, not three, since WP19 added the review gate — which is
   * why `awaitingReviewRecords` below had to come with it.)
   */
  status: DataStatus;
  /**
   * The review gate's own number, in RECORDS — see
   * `TrackingMatrixCell.awaitingReviewRecords`, which this mirrors exactly.
   *
   * Here because without it this DTO carries a verdict it cannot explain. Take
   * 24 approved invoices closing all 24 slots plus one `submitted` whole-company
   * record: `covered` is 24 of 24, `awaitingReviewSlots` is 0, and all four
   * shortfall counters produce sentences that would read identically if that
   * record were approved and the cell green. The drill-down and the Data Entry
   * panel could not tell their own two states apart — the unexplained amber
   * WP17's review caught, reappearing in the surfaces built to prevent it.
   */
  awaitingReviewRecords: number;
  /**
   * Committed records in this category that HAVE a figure but that the anomaly
   * rule never ran on. Mirrors `TrackingMatrixCell.notEvaluatedRecordCount`
   * exactly, for the same reason `awaitingReviewRecords` mirrors its twin: the
   * panel and the dashboard cell must not be able to disagree about one cell.
   */
  notEvaluatedRecordCount: number;
  /**
   * Months (lower-cased) that already hold a WHOLE-COMPANY entry for this
   * category and year.
   *
   * They close no site slot — the rule counts one invoice per SITE — but the
   * screen has to know about them, because inviting a user to key a site
   * invoice for a month already recorded at company level produces two rows for
   * one month, both of which feed the emissions total. The uniqueness index
   * cannot stop it (different `location_id`, different key), and nothing
   * downstream deduplicates.
   */
  companyLevelMonths: string[];
  locations: CompletenessLocationRow[];
}

/**
 * The drill-down behind a subsidiary in the tracking matrix.
 *
 * `categories` is EMPTY for a `subsidiary`-granularity subsidiary — not an
 * error and not a zero, but "this entity is measured as a whole, so there are
 * no per-location slots to show". The granularity is returned alongside so a
 * caller can say which of those two it is looking at.
 */
export interface SubsidiaryCompletenessDTO {
  subsidiaryId: string;
  reportingYear: number;
  trackingGranularity: TrackingGranularity;
  locationCount: number;
  categories: CategoryCompleteness[];
}

/** Tenant-scoped tracking matrix for the caller's accessible subsidiaries. */
export interface TrackingMatrixDTO {
  reportingYear: number | null;
  rows: TrackingMatrixRow[];
  /** Cell-status counts across the whole matrix. */
  totals: { complete: number; incomplete: number; missing: number };
}

// ---------------------------------------------------------------------------
// Audit trail (WP7)
// ---------------------------------------------------------------------------

/**
 * Offset envelope retained for the audit trail. LP4-05's history endpoints
 * use CursorPage<T>; tenant ownership alone does not bound a growing list.
 */
export interface Paginated<T> {
  items: T[];
  /** Total rows matching the filter, ignoring limit/offset. */
  total: number;
  limit: number;
  offset: number;
}

/** Every action the audit trail records. Workflow transitions are their own
 * verbs — before WP7 they were all logged as `update`. */
export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'submit',
  'review',
  'approve',
  'reject',
  'lock',
  'unlock',
  /** An approved figure withdrawn from the inventory, with a reason.
   *  Its own verb rather than a generic `update`, so "what was restated and
   *  why" is filterable in the audit trail instead of buried in a diff. */
  'void',
  /** An anomaly verdict re-derived against the pool as it stands now, by
   *  `pnpm anomaly:recompute` rather than by a user action.
   *
   *  Its own verb, not `update`: the row's DATA did not change, only the
   *  system's judgement about it, and "who changed this figure" must stay
   *  answerable separately from "when did we re-score it". These rows carry a
   *  null `userId` — no person performed them — which the viewer already
   *  renders, since a deleted profile produces the same shape. */
  'rescore',
  'generate',
  // A batch act on activity records — the import of a file, the submit of
  // many ids — beside the per-record rows the create/submit path writes. The
  // row carries `entityId: null` and a `diff.bulk` summary (file name, counts,
  // or `refused` with a reason). Its own verb, so the trail can be filtered by
  // it and a refusal is never mistaken for a record that was created.
  'bulk_import',
  'bulk_submit',
  /** An evidence file taken off ONE record while it still backs others
   *  (`entity: 'evidence'`, `diff.before.recordId`). Taking off the LAST link
   *  deletes the file, and that row is a `delete`. */
  'detach',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Entities the audit trail covers. */
export const AUDIT_ENTITIES = [
  'subsidiary',
  'location',
  'activity_record',
  'evidence',
  'period_lock',
  'target',
  'denominator',
  'report',
  // The `bulk_import` row of an APPLIED import points at its batch. Dry runs
  // and refusals, which create no batch, keep `activity_record` and a null id;
  // rows written before batches existed keep `activity_record` too.
  'import_batch',
  // A role change (LP1-03's AccessAdminService); `entityId` is the profile.
  'profile',
  // A subsidiary granted to or withdrawn from a data_entry user; `entityId` is
  // the profile, the subsidiary is in the diff.
  'subsidiary_access',
] as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

/**
 * One audit row, as rendered by the trail viewer.
 *
 * Two asymmetries worth knowing before consuming this:
 *  - `role` is a SNAPSHOT taken at write time, while `userEmail`/`userFullName`
 *    are resolved from the profile at READ time. A renamed user therefore
 *    changes how year-old rows read, and a deleted profile loses the name while
 *    the row survives. Snapshotting identity too is a real option — it collides
 *    with GDPR erasure, so it is a decision, not an oversight.
 *  - `action`/`entity` are typed as the CURRENT taxonomy, but the columns are
 *    TEXT so historic rows can carry a verb that has since been retired.
 *    Consumers should look up with a fallback rather than assume exhaustiveness.
 */
/**
 * The `diff` of a `bulk_import` audit row, as the API WRITES it. One source
 * for the keys the importer's `batchDiff` builds and the audit page's
 * `summariseBatch` reads — spelt in three files before this, where a typo
 * rendered as "—" silently. The read side stays `Record<string, unknown>`
 * (`AuditLogDTO.diff`): historic rows are never migrated, so a reader checks
 * each key defensively.
 *
 * Rows written before the retry-without-caller-text path was removed may lack
 * `fileName` and carry `callerTextOmitted: true`; a reader tolerates both.
 */
export type BulkImportAuditDiff = {
  bulk: true;
  dryRun: boolean;
  fileName: string;
  sizeBytes: number;
} & (
  | { refused: true; reason?: string }
  | {
      refused?: never;
      totalRows: number;
      acceptedCount: number;
      /** Examined rows refused; excludes rows not started before a deadline. */
      rejectedCount: number;
      /** Absent on pre-PR-B audit rows; PR B writes both fields, even on dry runs. */
      completion?: import('./bounded-access').BulkOperationCompletion;
      /** totalRows - acceptedCount - rejectedCount; zero when completed. */
      notProcessedCount?: number;
      /** The batch an apply created; absent on a dry run, which creates none. */
      batchId?: string;
    }
);

/**
 * The `diff` of a `bulk_submit` audit row, as the API writes it. `received` is
 * the number of ids as typed and `requested` the number after canonical
 * de-duplication, so a thousand spellings of one id cannot inflate the count.
 */
export type BulkSubmitAuditDiff = {
  bulk: true;
  requested: number;
  received: number;
  /** Set when the ids came from an import batch (`POST /import-batches/:id/submit`), refused or not. */
  batchId?: string;
} & (
  | { refused: true; reason: string }
  | {
      refused?: never;
      submittedCount: number;
      /** Includes unstarted ids, so submittedCount + failedCount = requested. */
      failedCount: number;
      /** Absent on pre-PR-B audit rows; PR B writes both fields. */
      completion?: import('./bounded-access').BulkOperationCompletion;
      /** The subset of failedCount with not_processed_deadline. */
      notProcessedCount?: number;
      recordIds: string[];
    }
);

export interface AuditLogDTO {
  id: string;
  action: AuditAction;
  entity: AuditEntity;
  /**
   * Null for `report` rows — a generation has no persisted entity to point at
   * — and for the `bulk_import` / `bulk_submit` batch rows, whose subject is a
   * file or a request rather than one record (their per-record rows carry the
   * ids). An import-batch entity would give the former an id; see the WP8
   * retrospective plan.
   */
  entityId: string | null;
  /** Actor identity, resolved from `profiles` at read time. Null when the
   * profile has since been deleted — the row itself is never rewritten. */
  userId: string | null;
  userEmail: string | null;
  userFullName: string | null;
  /**
   * The role the actor held AT THE TIME of the action — read from the row, not
   * from the profile. Null on rows written before WP7 added the column; they
   * are deliberately not back-dated with a guess.
   */
  role: UserRole | null;
  /** Raw change payload. Shape varies by entity; the viewer renders a summary. */
  diff: Record<string, unknown> | null;
  createdAt: string;
}

/** Filters accepted by `GET /audit`. */
export interface ListAuditParams {
  entity?: AuditEntity;
  action?: AuditAction;
  entityId?: string;
  userId?: string;
  /** ISO dates, inclusive lower / exclusive upper bound on `createdAt`. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Bulk upload (WP8)
// ---------------------------------------------------------------------------

/**
 * The columns a bulk file must carry, in the order the template writes them.
 *
 * Reporting entities are named by ID, not by name. A name would need
 * resolution rules this PR is not the place to invent — two sites legitimately
 * share a name, and guessing which one a row means would silently attribute
 * emissions to the wrong entity. The template download (PR 3) is what makes
 * ids typeable: it arrives pre-filled with the entities the user can reach.
 */
export const BULK_UPLOAD_COLUMNS = [
  'subsidiaryId',
  'locationId',
  'reportingYear',
  'reportingPeriod',
  'periodValue',
  'category',
  'activityValue',
  'activityUnit',
  'varianceReason',
] as const;

export type BulkUploadColumn = (typeof BULK_UPLOAD_COLUMNS)[number];

/** Columns a row cannot omit. `locationId` blank means the whole company. */
export const BULK_UPLOAD_REQUIRED_COLUMNS = [
  'subsidiaryId',
  'reportingYear',
  'reportingPeriod',
  'periodValue',
  'category',
  'activityValue',
  'activityUnit',
] as const satisfies readonly BulkUploadColumn[];

/**
 * The row cap, and the arithmetic behind it.
 *
 * Every row goes through the same service path a single create uses. A dry run
 * is four to five uncached queries (period lock, subsidiary, optional location,
 * emission factor, anomaly baseline); an APPLY adds the insert and the record's
 * own audit row, so **six to seven**. At the cap that is ~6,000-7,000 round
 * trips inside one synchronous HTTP request, and ~12,000 for the realistic
 * dry-run-then-apply cycle.
 * The alternative — a queue — is not available: Azure Container Apps scales to
 * zero, so post-response background work is not safe to start.
 *
 * 1,000 is ~10x the entire seeded dataset (102 records), so it is generous for
 * the data this product actually holds, and small enough that the request
 * finishes. If real files outgrow it, the escape hatch is ACA Jobs, not a
 * bigger number here.
 */
export const BULK_UPLOAD_MAX_ROWS = 1000;

/**
 * 2 MiB, deliberately NOT evidence's 10 MiB.
 *
 * An evidence file is streamed to storage; a bulk file is parsed into memory
 * AND expanded into row objects, so the resident cost is a multiple of the
 * bytes on the wire.
 */
export const BULK_UPLOAD_MAX_SIZE_BYTES = 2 * 1024 * 1024;

/**
 * The most TEXT a bulk-upload report's `message` carries, in code points. A
 * message that was cut is this long plus the `…` that marks the cut.
 *
 * A sentence can quote the file, and the report used to repeat it whole: one
 * 32,000-character XLSX shared string behind a thousand rows came back as a
 * 32,092,008-byte report from a 12,416-byte workbook (measured). The sentences
 * that quote a value now quote an excerpt of it, bounded where they are
 * written. This is the report's own bound on top, for a sentence a service
 * passes through without quoting.
 *
 * The arithmetic, and why the issue COUNT needs no cap of its own: every data
 * row is either accepted or carries exactly one error, so a report holds at
 * most `BULK_UPLOAD_MAX_ROWS` errors, and its warnings are fixed sentences, at
 * most three per accepted row. A thousand errors at this bound is about half a
 * megabyte of ASCII, and two megabytes only if every character took four bytes.
 *
 * 500 clears the longest sentence a row can receive today — the reason a
 * normal-cubic-metre unit is refused with, 269 code points — with room for
 * guidance that grows.
 */
export const BULK_UPLOAD_MESSAGE_MAX_LENGTH = 500;

/**
 * The extension is the gate, and there is deliberately no MIME list. Browsers
 * disagree about spreadsheets — Windows sends `.csv` as
 * `application/vnd.ms-excel` and sometimes `application/octet-stream` — so an
 * exact MIME match refuses a perfectly ordinary "Save as CSV". The declared
 * type is client-controlled and buys no security; the extension picks the
 * parser, and the parser refuses a file that is not a spreadsheet.
 */
export const BULK_UPLOAD_ALLOWED_EXTENSIONS = ['.csv', '.xlsx'] as const;

/**
 * Why one row was refused, or what a caller should look at before applying.
 *
 * `row` is the file's own line number with the header as line 1, so it matches
 * what the user sees in Excel. Machine-readable `code` plus human `message`:
 * the code is what a client groups by, the message is what a person reads.
 *
 * `message` can quote the file, so it arrives cleaned and bounded: at most
 * `BULK_UPLOAD_MESSAGE_MAX_LENGTH` code points of text, plus `…` where it was
 * cut. The API's caller-text rule has already dropped the characters that
 * disguise text — control characters, the bidi embeddings, overrides and
 * isolates, and the zero-width ones — and may drop more of them over time. It
 * is not a full sanitiser, so render the message as text.
 */
export interface BulkUploadRowIssue {
  row: number;
  column: BulkUploadColumn | null;
  code: BulkUploadIssueCode;
  message: string;
}

/**
 * Why a row was REFUSED. Split from the warnings deliberately: a report's two
 * lists are different kinds of thing — these stop a row, those do not — and one
 * union let `errors[]` legally carry `formula_lead`.
 */
export const BULK_UPLOAD_ERROR_CODES = [
  /** The row failed DTO validation (type, range, vocabulary, length). */
  'invalid',
  /** Another row in the SAME file already claims this reporting slot. */
  'duplicate_in_file',
  /** A stored record already claims this reporting slot. */
  'duplicate_existing',
  /** The reporting entity named by the row could not be resolved. */
  'not_found',
  /**
   * No emission factor covers this category, geography and year.
   *
   * Its own code because it is the archetypal bulk-import failure — importing
   * 2019-2020 history for a category whose factor library starts in 2021 —
   * and because it used to be reported as `not_found`, which told the user
   * they had an access problem and sent them hunting for a permissions bug.
   */
  'no_factor',
  /** The reporting period is closed. */
  'period_locked',
  /** Anything the server did not anticipate; the row is refused, not applied. */
  'unexpected',
  /** The request's deadline passed before this row began. Nothing was applied
   * for this row; other rows' successful outcomes are retained. */
  'not_processed_deadline',
] as const;

export type BulkUploadErrorCode = (typeof BULK_UPLOAD_ERROR_CODES)[number];

/** Things worth saying about a row that was, or would be, imported anyway. */
export const BULK_UPLOAD_WARNING_CODES = [
  /** The cell would be read as a formula by a spreadsheet. */
  'formula_lead',
  /**
   * Anomalous with no variance reason: it imports, but it cannot then be
   * submitted for review until someone explains it.
   */
  'would_block_submit',
  /**
   * This category cannot be submitted without an evidence file, and the
   * import itself attaches none — the file is added afterwards, one upload
   * for as many of the drafts as it really evidences. Derived from the
   * category alone, no query — and worth saying, because a user importing 500
   * electricity rows would otherwise see no warnings at all and meet the wall
   * later.
   */
  'evidence_required',
] as const;

export type BulkUploadWarningCode = (typeof BULK_UPLOAD_WARNING_CODES)[number];

/** Every code a report can carry — for an exhaustive client-side label map. */
export const BULK_UPLOAD_ISSUE_CODES = [
  ...BULK_UPLOAD_ERROR_CODES,
  ...BULK_UPLOAD_WARNING_CODES,
] as const;

export type BulkUploadIssueCode = BulkUploadErrorCode | BulkUploadWarningCode;

/**
 * A row that would be, or was, written.
 *
 * Carries the row's IDENTITY, not just its outcome: a dry-run preview has to
 * show the user what is about to be imported, and a client that had only
 * `{row, tCo2e}` would have to re-parse the file in the browser to name the
 * entity, period and category — a second implementation of row semantics.
 * `periodValue` is the CANONICAL spelling the server will store, not the one
 * the file wrote, so the preview shows what actually lands.
 *
 * `tCo2e` is `null` when the category is tracked but not calculated (Water).
 * Sum only the non-null values — a client folding with `?? 0` turns "no figure
 * exists" into a reported zero, which is the defect this null exists to avoid.
 */
export interface BulkUploadAcceptedRow {
  row: number;
  /** `null` on a dry run — nothing was written, so there is no id. */
  recordId: string | null;
  subsidiaryId: string;
  locationId: string | null;
  reportingYear: number;
  reportingPeriod: ReportingPeriod;
  periodValue: string;
  category: Category;
  tCo2e: number | null;
  anomalous: boolean;
}

export interface BulkUploadReportDTO {
  /** Absent on legacy servers. PR B emits this on every completed response;
   * deadline_exceeded preserves accepted rows and accounts for every unstarted
   * row in errors as not_processed_deadline. completed does not mean all rows
   * succeeded. Clients must always inspect the per-row outcomes. */
  completion?: import('./bounded-access').BulkOperationCompletion;
  dryRun: boolean;
  /**
   * The upload's own name, cleaned by the rule `BulkUploadRowIssue.message`
   * describes and cut at 255 code points, with nothing marking the cut.
   */
  fileName: string;
  sizeBytes: number;
  /** Data rows found in the file, excluding the header. */
  totalRows: number;
  accepted: BulkUploadAcceptedRow[];
  /**
   * One per refused row, and never more: a row is accepted or it carries a
   * single error, so `accepted.length + errors.length === totalRows` and the
   * row cap bounds this list. Warnings are NOT one per row — a row can carry
   * several — and they are published only for rows that are, or would be,
   * imported.
   */
  errors: BulkUploadRowIssue[];
  warnings: BulkUploadRowIssue[];
  /**
   * The batch an apply created — the handle that survives a page refresh
   * (`GET /import-batches/:id`, `POST /import-batches/:id/submit`). Null on a
   * dry run, which creates none.
   */
  batchId: string | null;
}

// ---------------------------------------------------------------------------
// Import batches (WP8 retrospective, PR6)
// ---------------------------------------------------------------------------

export const IMPORT_BATCH_STATUSES = ['processing', 'completed', 'failed'] as const;
/**
 * `processing` with null counts after its request is long gone is an
 * INTERRUPTED import: the process died mid-loop. The records it did create are
 * still linked to it — the foreign key, not the counts, is what says which.
 */
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

/** How many batches `GET /import-batches` returns at most. */
export const IMPORT_BATCH_LIST_MAX = 50;

/**
 * One applied bulk import, as a reader may see it. Visible to super_admin,
 * consultant and executive_viewer across their organisation, and to a
 * data_entry user only for a batch they uploaded while they can still reach
 * every subsidiary it names (the source file holds every row). The storage
 * key is never exposed; `hasSourceFile` says whether a download exists.
 */
export interface ImportBatchDTO {
  id: string;
  fileName: string;
  fileFormat: 'csv' | 'xlsx';
  sizeBytes: number;
  /** Hex SHA-256 of the file as received — proves which bytes were imported. */
  sha256: string;
  status: ImportBatchStatus;
  totalRows: number;
  /** Null while processing or after an interruption without finalized counts.
   * Cooperative deadlines finalize both counts and status=failed. Unstarted rows
   * are totalRows - acceptedCount - rejectedCount when both counts are known;
   * null counts mean unknown, never zero unstarted rows. */
  acceptedCount: number | null;
  /** Only examined, refused rows; excludes unstarted rows. */
  rejectedCount: number | null;
  subsidiaryIds: string[];
  uploadedBy: string;
  uploadedByName: string | null;
  hasSourceFile: boolean;
  /** Drafts of this batch the caller may send (their own, or any for a super_admin). */
  draftCount: number;
  /**
   * Of those, the ones that can go NOW: no evidence file missing. The batch
   * submit sends exactly these; the rest wait for a file (`draftCount -
   * submittableDraftCount`). Every other gate is still the server's, per record.
   */
  submittableDraftCount: number;
  createdAt: string;
  completedAt: string | null;
}

/** A record a batch produced, as its detail lists it (tenant-filtered for the caller). */
export interface ImportBatchRecordRef {
  id: string;
  status: ActivityRecordStatus;
  subsidiaryId: string;
  locationId: string | null;
  reportingYear: number;
  reportingPeriod: ReportingPeriod;
  periodValue: string;
  category: Category;
  createdBy: string;
}

export interface ImportBatchDetailDTO extends ImportBatchDTO {
  records: ImportBatchRecordRef[];
}

// ---------------------------------------------------------------------------
// Bulk submit (WP8) — send many imported drafts for review at once.
// ---------------------------------------------------------------------------

/**
 * The id cap, and the arithmetic behind it.
 *
 * Every id goes through `ActivityRecordsService.submit`: four to seven uncached
 * queries — the scoped load, the period lock, the evidence count (only for an
 * evidence-required category), the anomaly baseline (only for a record with a
 * figure), the status write, the audit row, plus a profile lookup when a
 * rejected record's reviewer is not the caller. Six, typically. At the cap that
 * is ~6,000 round trips in one synchronous request — and unlike the import
 * there is no dry-run-then-apply doubling, so this is the CHEAPER half of the
 * pair that produced the rows.
 *
 * Deliberately the same number as `BULK_UPLOAD_MAX_ROWS`, and deliberately NOT
 * an alias of it. Two budgets that happen to coincide: that one bounds a
 * FILE's rows, this one a JSON array's length. Aliasing would mean raising
 * either one for its own reason silently raises the other — and the pairing
 * (one import of a thousand rows, one submit of a thousand ids) is exactly why
 * both have to be separately stateable.
 *
 * One bound the import does not have: the API installs no body-parser limit,
 * so Express's 100 KB JSON default applies. A thousand UUIDs is ~39 KB of
 * body; two thousand would be ~78 KB. Raising this cap means setting an
 * explicit limit first.
 */
export const BULK_SUBMIT_MAX_IDS = 1000;

/**
 * The statuses a record can be submitted FROM — the lifecycle rule, in the
 * contract rather than in three places.
 *
 * It was already written down twice: a module-local `Set` in the API service,
 * and a hand-written `status === 'draft' || status === 'rejected'` on the Data
 * Entry screen's own submission list. A bulk-submit UI over that list would
 * have made three.
 */
export const SUBMITTABLE_STATUSES = [
  'draft',
  'rejected',
] as const satisfies readonly ActivityRecordStatus[];

/** True when a record is at a point in its life where it can be submitted. */
export function isSubmittable(
  status: string,
): status is (typeof SUBMITTABLE_STATUSES)[number] {
  return (SUBMITTABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * What a BULK submit will accept, which is narrower than what `submit` will.
 *
 * `rejected` is deliberately excluded. Resubmitting reverses a reviewer's
 * decision — the single-record path treats that as serious enough to carry an
 * author gate — and a route that would flip a thousand of them at once is a
 * mass reviewer-decision-reversal endpoint, which is not what "the other half
 * of an import" means. Those go back one at a time, where someone reads the
 * reviewer's note before overturning it.
 */
export const BULK_SUBMITTABLE_STATUSES = [
  'draft',
] as const satisfies readonly ActivityRecordStatus[];

/**
 * True when a record is at a point in its life where a BULK submit accepts it.
 *
 * The predicate rather than the array, because two gates have to agree — the
 * server's `preflight` and the checkbox the client offers — and the one thing
 * that must never happen is the client offering a selection the server refuses
 * as `not_submittable`. `isSubmittable` is the trap: it admits `rejected`,
 * which this path excludes on purpose.
 *
 * Deliberately NOT called `isBulkSubmittable`. That name shares a prefix with
 * the wider predicate, so an editor offers `isSubmittable` first and the
 * narrower one never surfaces — the completion list would quietly hand every
 * caller the trap. This name reads as a statement about the ROUTE, which is
 * what it is: `preflight`'s rule, not the lifecycle's.
 *
 * The return is a type guard so that code after an early `continue` on a
 * refusal has `status` narrowed to `'draft'` — a future branch that tries to
 * handle `rejected` there fails to compile instead of shipping.
 */
export function acceptsBulkSubmit(
  status: string,
): status is (typeof BULK_SUBMITTABLE_STATUSES)[number] {
  return (BULK_SUBMITTABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * Every way a bulk submit can refuse ONE record — one code per precondition in
 * `ActivityRecordsService.submit`, in the order that method checks them.
 *
 * There is no warning half, unlike the import's codes. The import needed one
 * because a row could be written and still be unusable; a submit either moves
 * the record or does not.
 *
 * The ROLE gate is absent on purpose: a role cannot change mid-batch, so it is
 * one 403 for the whole request rather than N identical issues.
 */
export const BULK_SUBMIT_ISSUE_CODES = [
  /**
   * No such record, or its subsidiary is not yours. One code for both,
   * deliberately: the API never discloses which, or it becomes an existence
   * oracle for another tenant's ids.
   */
  'not_found',
  /**
   * Not a `draft`. The commonest bulk failure by far — a second click after a
   * partial success hits this on every id that worked the first time — and it
   * also covers a `rejected` record, which this route deliberately refuses
   * (see `BULK_SUBMITTABLE_STATUSES`).
   */
  'not_submittable',
  /**
   * Someone else wrote it.
   *
   * The same rule as the single-record path since decision D02 (2026-09-29):
   * only a record's author submits it, `super_admin` included. Before that the
   * single-record path gated only a RESUBMISSION; at a thousand ids in one
   * call that was a way to sweep a colleague's half-finished month into
   * review, where they can no longer edit it and only a reviewer can send it
   * back.
   */
  'not_author',
  /** The reporting period is closed. */
  'period_locked',
  /**
   * The category requires an evidence file and this record has none.
   *
   * The import reports `evidence_required` as a WARNING on these same rows;
   * here it is the refusal that warning was about. The bulk submit cannot
   * clear it: a file is attached by a person who picks the records it
   * evidences. One file may back several records of one subsidiary (WP8
   * decision 3a, which replaced "one file, one record"); the ISO 14064-1
   * control is now that every file shows each record it backs, so the
   * reviewer judges whether one invoice can honestly cover all of them.
   */
  'evidence_required',
  /**
   * Anomalous against the baseline as recomputed NOW, with no variance reason.
   * The import's `would_block_submit` warning, arrived at.
   */
  'variance_reason_required',
  /** Anything the server did not anticipate. The record was NOT submitted. */
  'unexpected',
  /** No operation started for this id before the deadline; no existence or
   * access check is implied. The id is the normalized request UUID. */
  'not_processed_deadline',
] as const;

export type BulkSubmitIssueCode = (typeof BULK_SUBMIT_ISSUE_CODES)[number];

/**
 * Why one record was not submitted.
 *
 * Keyed by `recordId`, not by a row number: there is no file here, and
 * `BulkUploadRowIssue.row` is the spreadsheet line the user sees in Excel. A
 * synthetic index would be a number the client sorts by and the user cannot
 * find anywhere.
 */
export interface BulkSubmitIssue {
  /**
   * The spelling the DATABASE holds, which is not always the one the caller
   * sent: the route's id check is case-insensitive, so `A0EE…` is a valid
   * request and is reported back as `a0ee…`. Echoing the stored id is what
   * lets this entry be joined to the record and to its `audit_log` rows —
   * the accepted rows above already carry it, and a report whose two halves
   * disagreed about an id would be unjoinable. A client matching an entry
   * back to what it sent must compare case-insensitively. For
   * not_processed_deadline no lookup took place: use the normalized request
   * UUID instead, making no claim that a stored record exists.
   */
  recordId: string;
  code: BulkSubmitIssueCode;
  /** The server's own sentence, already written for the person reading it. */
  message: string;
}

/** A record that moved to `submitted`. */
export interface BulkSubmitAcceptedRecord {
  recordId: string;
  subsidiaryId: string;
  locationId: string | null;
  reportingYear: number;
  reportingPeriod: ReportingPeriod;
  periodValue: string;
  category: Category;
  /**
   * `null` when the category is tracked but not calculated (Water). Sum only
   * the non-null values — folding with `?? 0` turns "no figure exists" into a
   * reported zero, the same rule as `BulkUploadAcceptedRow.tCo2e`.
   */
  tCo2e: number | null;
  /**
   * The verdict as RE-DERIVED at submit, which can differ from the one the
   * import stamped: `submit` recomputes against the baseline as it stands now.
   *
   * And within one batch it is ORDER-DEPENDENT, which the import is not.
   * `BASELINE_STATUSES` excludes `draft`, so imported rows cannot shift each
   * other's verdict — but `submitted` is in `COUNTED_STATUSES`, so record N+1's
   * baseline can include record N, submitted moments earlier in this same loop.
   * Submitting twelve months January-first is not the same as December-first.
   */
  anomalous: boolean;
}

/**
 * The outcome of one bulk submit.
 *
 * No transaction spans the batch — `ActivityRecordsService` opens none — so a
 * failure part-way leaves the earlier records submitted. `submitted` lists them
 * individually for the same reason the import's `accepted` does: a partial
 * application the caller cannot enumerate is a data-integrity incident.
 */
export interface BulkSubmitReportDTO {
  /** Absent on legacy servers; PR B emits a value on every response. A
   * deadline accounts for unstarted ids in failed as not_processed_deadline,
   * preserving submitted and requested = submitted.length + failed.length. */
  completion?: import('./bounded-access').BulkOperationCompletion;
  /** Ids the caller asked for, after de-duplication. */
  requested: number;
  submitted: BulkSubmitAcceptedRecord[];
  failed: BulkSubmitIssue[];
}

export * from './bounded-access';
