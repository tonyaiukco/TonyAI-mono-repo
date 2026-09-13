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
  target: 'kWh' | 'litres' | 'kilometres' | 'passenger_kilometres' | 'tonnes';
  /** Present when the unit is selectable but not yet calculable. */
  blocked?: string;
}

export const ACTIVITY_UNITS: readonly ActivityUnitSpec[] = [
  { value: 'kWh', label: 'kWh (electricity / gas)', symbol: 'kWh', target: 'kWh' },
  { value: 'MWh', label: 'MWh (electricity)', symbol: 'MWh', target: 'kWh' },
  {
    value: 'cubic_metres',
    // No parenthetical: the same token is offered for Natural Gas and for Water,
    // and it read as "Cubic metres — m³ (natural gas)" in the Water dropdown,
    // where it is the ONLY option. `target` describes the natural-gas path only;
    // a Water record is never normalised (see UncalculatedSnapshot).
    label: 'Cubic metres — m³',
    symbol: 'm³',
    target: 'kWh',
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
    blocked:
      'Standard cubic metres need a sourced calorific value to become kWh, and this prototype does not have one yet — it arrives with the Phase-4 factor library. Enter the volume in m³, or the energy in kWh.',
  },
  { value: 'therms', label: 'Therms (natural gas)', symbol: 'therms', target: 'kWh' },
  { value: 'gj', label: 'GJ (natural gas)', symbol: 'GJ', target: 'kWh' },
  { value: 'litres', label: 'Litres (liquid fuel)', symbol: 'L', target: 'litres' },
  { value: 'uk_gallons', label: 'UK gallons (liquid fuel)', symbol: 'UK gal', target: 'litres' },
  { value: 'us_gallons', label: 'US gallons (liquid fuel)', symbol: 'US gal', target: 'litres' },
  { value: 'kilometres', label: 'Kilometres', symbol: 'km', target: 'kilometres' },
  {
    value: 'passenger_kilometres',
    label: 'Passenger-km',
    symbol: 'p-km',
    target: 'passenger_kilometres',
  },
  { value: 'tonnes', label: 'Tonnes', symbol: 't', target: 'tonnes' },
] as const;

/**
 * Which units make sense for which category.
 *
 * Without this the only guard is the unit FAMILY check in the calc service, so
 * litres on Electricity is refused (litres vs kWh) while `therms` on Electricity
 * or `MWh` on Natural Gas sail straight through and produce a number — a silent
 * wrong figure rather than an error. Categories absent from this map have no
 * seeded factor yet, so they are unconstrained until they do.
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


// Data Entry Types
// Canonical 4-role enum (aligned with docs/tech_docs technical_analysis.md §4 and Prisma user_role)
export type UserRole = 'super_admin' | 'consultant' | 'data_entry' | 'executive_viewer';

export type SubmissionStatus = 'draft' | 'submitted' | 'in_review' | 'approved' | 'revision_requested';

/**
 * The reporting years the product will accept data for, newest first.
 *
 * Round-1 UAT (DE-9) asked for 2015–2026: a group reports history, not just the
 * current year.
 *
 * Listing a year is NOT a promise that it calculates. Factor coverage is a
 * per-year/geography/category question, and the demo library currently covers
 * DEMO_YEAR (plus one prior-year row to prove versioning) — so most selections
 * outside it return "no emission factor for this selection", which the UI states
 * plainly rather than failing silently. Real coverage arrives with the Phase-4
 * factor library.
 *
 * The first entry is what screens default to, and the demo dataset is seeded in
 * that same year so the default is never a year with nothing in it.
 */
export const REPORTING_YEARS = [
  2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015,
] as const;
export type ReportingYear = (typeof REPORTING_YEARS)[number];
export const DEFAULT_REPORTING_YEAR: ReportingYear = REPORTING_YEARS[0];

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
  language: string;
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
 * either has a full factor-backed result, or an explicit statement that no
 * figure was produced.
 */
export type ActivityCalculationSnapshot =
  | CalculationResult
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

/** An evidence file's metadata as returned by the API (never the binary). */
export interface EvidenceDTO {
  id: string;
  activityRecordId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
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
 * Envelope for paginated list endpoints. The audit trail is the first list in
 * the API that cannot return everything — every other list is bounded by the
 * tenant's own data, while `audit_log` grows forever. New paginated endpoints
 * should reuse this shape rather than inventing a second one.
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
export interface AuditLogDTO {
  id: string;
  action: AuditAction;
  entity: AuditEntity;
  /** Null for `report` rows — a generation has no persisted entity to point at. */
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
 * The extension is the gate; the MIME list is advisory.
 *
 * Browsers disagree about spreadsheets — Windows sends `.csv` as
 * `application/vnd.ms-excel` and sometimes `application/octet-stream` — so an
 * exact MIME match (which is what the evidence module does) refuses a
 * perfectly ordinary "Save as CSV". The declared type is client-controlled and
 * buys no security; the extension picks the parser, and the parser itself is
 * what actually refuses a file that is not a spreadsheet.
 *
 * The list is still exported because the browser's file picker needs it for
 * its `accept=` attribute.
 */
export const BULK_UPLOAD_ALLOWED_MIME_TYPES = [
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/octet-stream',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

export const BULK_UPLOAD_ALLOWED_EXTENSIONS = ['.csv', '.xlsx'] as const;

/**
 * Why one row was refused, or what a caller should look at before applying.
 *
 * `row` is the file's own line number with the header as line 1, so it matches
 * what the user sees in Excel. Machine-readable `code` plus human `message`:
 * the code is what a client groups by, the message is what a person reads.
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
   * This category cannot be submitted without an evidence file, and bulk
   * upload cannot attach one. Derived from the category alone, no query — and
   * worth saying, because a user importing 500 electricity rows would
   * otherwise see no warnings at all and meet the wall later.
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
  dryRun: boolean;
  fileName: string;
  sizeBytes: number;
  /** Data rows found in the file, excluding the header. */
  totalRows: number;
  accepted: BulkUploadAcceptedRow[];
  errors: BulkUploadRowIssue[];
  warnings: BulkUploadRowIssue[];
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
   * Stricter than the single-record path, which gates only a RESUBMISSION and
   * so lets any colleague who can see the subsidiary submit a draft. At one
   * click that is a curiosity; at a thousand ids in one call it is a way to
   * sweep a colleague's half-finished month into review, where they can no
   * longer edit it and only a reviewer can send it back. Enumerability is a
   * forensics property, not a control.
   */
  'not_author',
  /** The reporting period is closed. */
  'period_locked',
  /**
   * The category requires an evidence file and this record has none.
   *
   * The import reports `evidence_required` as a WARNING on these same rows;
   * here it is the refusal that warning was about. Nothing in the bulk path can
   * clear it — a bulk import cannot attach a file, and `Evidence` belongs to
   * exactly one record, so one invoice cannot cover twelve months. These are
   * cleared one record at a time, on purpose: it is an ISO 14064-1 evidence
   * control, not a convenience.
   */
  'evidence_required',
  /**
   * Anomalous against the baseline as recomputed NOW, with no variance reason.
   * The import's `would_block_submit` warning, arrived at.
   */
  'variance_reason_required',
  /** Anything the server did not anticipate. The record was NOT submitted. */
  'unexpected',
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
  /** Ids the caller asked for, after de-duplication. */
  requested: number;
  submitted: BulkSubmitAcceptedRecord[];
  failed: BulkSubmitIssue[];
}

/**
 * Every requested id lands in exactly one of the two lists.
 *
 * Stated because a client summarising the outcome depends on it — "N of M
 * submitted, the rest are still drafts" is only true if nothing fell through —
 * and because a loop that `break`s instead of `continue`s would quietly
 * violate it while every count still looked plausible.
 */
export function bulkSubmitReportIsComplete(
  report: BulkSubmitReportDTO,
): boolean {
  return report.submitted.length + report.failed.length === report.requested;
}

