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
  target: 'kWh' | 'litres' | 'kilometres' | 'passenger_kilometres' | 'tonnes';
  /** Present when the unit is selectable but not yet calculable. */
  blocked?: string;
}

export const ACTIVITY_UNITS: readonly ActivityUnitSpec[] = [
  { value: 'kWh', label: 'kWh (electricity / gas)', target: 'kWh' },
  { value: 'MWh', label: 'MWh (electricity)', target: 'kWh' },
  {
    value: 'cubic_metres',
    label: 'Cubic metres — m³ (natural gas)',
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
    target: 'kWh',
    blocked:
      'Standard cubic metres need a sourced calorific value to become kWh, and this prototype does not have one yet — it arrives with the Phase-4 factor library. Enter the volume in m³, or the energy in kWh.',
  },
  { value: 'therms', label: 'Therms (natural gas)', target: 'kWh' },
  { value: 'gj', label: 'GJ (natural gas)', target: 'kWh' },
  { value: 'litres', label: 'Litres (liquid fuel)', target: 'litres' },
  { value: 'uk_gallons', label: 'UK gallons (liquid fuel)', target: 'litres' },
  { value: 'us_gallons', label: 'US gallons (liquid fuel)', target: 'litres' },
  { value: 'kilometres', label: 'Kilometres', target: 'kilometres' },
  {
    value: 'passenger_kilometres',
    label: 'Passenger-km',
    target: 'passenger_kilometres',
  },
  { value: 'tonnes', label: 'Tonnes', target: 'tonnes' },
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
  designatedPerson: string | null;
  reportingStatus: SubsidiaryStatus;
  includedScopes: number[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateSubsidiaryInput {
  legalName: string;
  tradingName?: string | null;
  location?: string | null;
  geographyCode: string;
  businessArea?: string | null;
  sector?: string | null;
  designatedPerson?: string | null;
  reportingStatus?: SubsidiaryStatus;
  includedScopes?: number[];
}

export type UpdateSubsidiaryInput = Partial<CreateSubsidiaryInput>;

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
  /** Determines the emission factor when a record targets this location (FR §5.2). */
  geographyCode: string;
  address: string | null;
  authorizedPerson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocationInput {
  subsidiaryId: string;
  name: string;
  geographyCode: string;
  address?: string | null;
  authorizedPerson?: string | null;
}

/** `subsidiaryId` is immutable — a location cannot move between subsidiaries. */
export type UpdateLocationInput = Partial<Omit<CreateLocationInput, 'subsidiaryId'>>;

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
  /** Optional operational location this entry is attributed to (FR §5.2). When
   * set, it drives the emission-factor geography instead of the subsidiary's. */
  locationId: string | null;
  reportingYear: number;
  reportingPeriod: ReportingPeriod;
  periodValue: string;
  category: Category;
  scope: number;
  status: ActivityRecordStatus;
  activityValue: number;
  activityUnit: string;
  input: Record<string, unknown> | null;
  calculation: CalculationResult;
  createdBy: string;
  anomalyFlag: boolean;
  /** The AUTHOR's justification for an anomalous value (VAR §4). */
  varianceReason: string | null;
  /** Who decided the review outcome, when, and why. `reviewNote` carries the
   * REVIEWER's words — a rejection reason never overwrites `varianceReason`. */
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
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
export const PENDING_REVIEW_STATUSES = [
  'submitted',
  'under_review',
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
 */
export const EVIDENCE_REQUIRED_CATEGORIES: Category[] = [
  'Electricity',
  'Natural Gas',
  'Fuel',
];

/** True when the given category must have evidence attached to be complete. */
export function isEvidenceRequired(category: string): boolean {
  return (EVIDENCE_REQUIRED_CATEGORIES as string[]).includes(category);
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
  /** Number of activity records counted into this summary. */
  recordCount: number;
  /** Statuses included in the aggregation (drafts/rejected are excluded). */
  statusesIncluded: ActivityRecordStatus[];
}

// ---------------------------------------------------------------------------
// Tracking matrix (Phase 1) — subsidiary × category completeness per FR §2.
// Status semantics (functional_requirements.md §2.2):
//   missing    — no activity record exists for the cell
//   incomplete — a record exists but is draft/rejected, or flagged as anomaly
//   complete   — all records are committed (submitted/under_review/approved/
//                locked) and none are flagged
// NOTE: the FR "required evidence attached" condition for `complete` is
// deferred until the evidence backend ships (tracked in the roadmap).
// ---------------------------------------------------------------------------

/** One subsidiary × category cell of the tracking matrix. */
export interface TrackingMatrixCell {
  category: Category;
  scope: number;
  status: DataStatus;
  /** Sum of committed records' tCO₂e in this cell (drafts excluded). */
  tCo2e: number;
  /** All records touching this cell, any status. */
  recordCount: number;
  /** ISO timestamp of the most recent record update, or null when missing. */
  lastUpdate: string | null;
  /** true when any record in the cell carries an anomaly flag. */
  anomaly: boolean;
}

/** One subsidiary row of the tracking matrix (cells ordered as CATEGORIES). */
export interface TrackingMatrixRow {
  subsidiaryId: string;
  subsidiaryName: string;
  sector: string | null;
  designatedPerson: string | null;
  /** Sum of committed tCO₂e across the row. */
  totalTCo2e: number;
  completeCount: number;
  categoryCount: number;
  cells: TrackingMatrixCell[];
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
