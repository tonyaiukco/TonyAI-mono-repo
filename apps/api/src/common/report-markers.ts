/**
 * The two words every report export writes in place of a number (their full
 * rationale is at their use in `reports/report-columns.ts`). Here, in common,
 * because the live exports AND the issued tables (LP4-03 K5) write them, and
 * the reports module is a sink nothing else may import.
 */

/** Where a tCO₂e figure would go when the record's category has no emission factor — never 0. */
export const NOT_CALCULATED = 'Not calculated';

/** What a CSV writes in a withdrawn row's aggregatable cells, which share one table with the counted rows. */
export const WITHDRAWN = 'Withdrawn';
