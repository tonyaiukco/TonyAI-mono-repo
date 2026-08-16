import { isCalculated, type ActivityCalculationSnapshot } from '@/lib/types';

/**
 * How every screen renders a record whose category has no emission factor.
 *
 * One module because three pages show these records — the emissions ledger and
 * its detail sheet, the reviewer's queue, and Data Entry's submission list —
 * and the compliance rule is the same in all of them: a figure that was never
 * produced must never be displayed as a number, least of all as `0`. A zero is
 * a measurement; "not calculated" is the absence of one, and an auditor reading
 * a report cannot tell the two apart after the fact.
 *
 * Water is the only category taking this path today: the product tracks its
 * invoices for completeness (round-1 DASH-3) while no authoritative water factor
 * exists, and inventing one is forbidden.
 */

/** Shown in place of a tCO₂e figure. Deliberately not "0" and not "—". */
export const NOT_CALCULATED_LABEL = 'Not calculated';

/** Shown in place of a factor/methodology field. */
export const NO_FACTOR_LABEL = 'No factor available';

/**
 * The explanation to put next to the label, or null when the record does carry
 * a real figure. Comes from the stored snapshot, so the text a user reads is
 * the reason the API recorded at write time rather than something the UI
 * invented afterwards.
 */
export function notCalculatedReason(
  calculation: ActivityCalculationSnapshot,
): string | null {
  return isCalculated(calculation) ? null : calculation.reason;
}

/**
 * Format a snapshot's tCO₂e, or the "not calculated" label.
 *
 * `format` is supplied by the caller so each page keeps its own number style
 * (the ledger uses `formatNumber`, the review queue uses `toLocaleString`)
 * without this module having to know about either.
 */
export function formatTCo2e(
  calculation: ActivityCalculationSnapshot,
  format: (value: number) => string,
): string {
  return isCalculated(calculation)
    ? format(calculation.tCo2e)
    : NOT_CALCULATED_LABEL;
}
