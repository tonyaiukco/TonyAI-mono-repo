/** Types for `anomaly-probe.lib.mjs`, for the integration suite that runs its SQL. */
export const ANOMALY_THRESHOLD: number;
export const BASELINE_MAX_PERIODS: number;
export const BASELINE_MIN_PERIODS: number;
export const BASELINE_TOLERANCE: number;
export const BASELINE_STATUSES: readonly string[];
/** Copies of the contract's first-period ceiling constants (BUG-R2-07 tier 3). */
export const FIRST_PERIOD_CEILINGS: Readonly<Record<string, Readonly<Record<string, number>>>>;
export const MARINE_GAS_OIL_CEILING_KG: number;
export const MARINE_GAS_OIL_ACTIVITY_TYPE: string;
export const REFRIGERANT_LINE_CEILING_KG: number;
export const REFRIGERANT_REFILL_RATIO: number;
export const REFILL_CEILING_TOLERANCE: number;
export const CEILING_UNIT_MULTIPLIERS: Readonly<Record<string, { readonly base: string; readonly multiplier: number }>>;
/** The SQL CASE over a record's columns: above its first-period ceiling, or NULL. */
export const CEILING_ABOVE_SQL: string;
/** The `WITH ... verdict AS (...)` prefix every report query starts from. */
export const BASE_SQL: string;
/** The predicate over `verdict` that selects a drifted stored verdict. */
export const DRIFT_WHERE: string;
/** The predicate over `verdict` that selects a verdict kept from before the short-history check. */
export const LEGACY_WHERE: string;
/** The predicate over `verdict` that selects a first period kept from before the typo ceilings. */
export const PRE_CEILING_WHERE: string;
