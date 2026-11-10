/** Types for `anomaly-probe.lib.mjs`, for the integration suite that runs its SQL. */
export const ANOMALY_THRESHOLD: number;
export const BASELINE_MAX_PERIODS: number;
export const BASELINE_MIN_PERIODS: number;
export const BASELINE_TOLERANCE: number;
export const BASELINE_STATUSES: readonly string[];
/** The `WITH ... verdict AS (...)` prefix every report query starts from. */
export const BASE_SQL: string;
/** The predicate over `verdict` that selects a drifted stored verdict. */
export const DRIFT_WHERE: string;
/** The predicate over `verdict` that selects a verdict kept from before the short-history check. */
export const LEGACY_WHERE: string;
