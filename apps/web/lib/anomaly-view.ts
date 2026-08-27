import {
  ANOMALY_BASELINE_PERIODS,
  ANOMALY_THRESHOLD,
  isAnomalyEvaluated,
} from '@/lib/types';

/**
 * What a screen may say about a record's VAR §4 verdict.
 *
 * The copy lives here, with its own spec, for the reason WP18 extracted
 * `void-view.ts` and WP20 extracted `report-view.ts`: three screens render this
 * verdict (Data Entry, the review queue and its sheet, the emissions drawer)
 * and a sentence duplicated three times is a sentence that will be corrected in
 * two of them.
 *
 * The distinction it exists to carry: `anomalyFlag: false` is not one claim.
 * Since 2026-08-27 the rule needs three comparable periods carrying a figure,
 * so a record on a shorter window was never checked at all — and a screen that
 * renders nothing for it says "fine" about data nobody looked at.
 */
export type AnomalyTone = 'flagged' | 'clean' | 'not_evaluated';

export interface AnomalyStatement {
  tone: AnomalyTone;
  headline: string;
  /** The sentence under the headline. Always names the window, so a reader
   *  never has to ask what "historical average" meant for THIS record. */
  detail: string;
}

/** Enough of an activity record to state its verdict. Structural on purpose —
 *  the review queue, the drawer and the entry form each hold a different slice
 *  of the DTO, and none of them should have to hold all of it. */
export interface AnomalyVerdictFields {
  anomalyFlag: boolean;
  anomalyBaselinePriorCount: number | null;
  anomalyBaselineTCo2e: number | null;
}

const pct = Math.round(ANOMALY_THRESHOLD * 100);

/** tCO₂e as the rest of the app prints it — three decimals, no trailing noise. */
function tonnes(value: number): string {
  return `${value.toFixed(3).replace(/\.?0+$/, '')} tCO₂e`;
}

export function anomalyStatement(record: AnomalyVerdictFields): AnomalyStatement {
  const priors = record.anomalyBaselinePriorCount;
  const baseline = record.anomalyBaselineTCo2e;

  if (record.anomalyFlag) {
    return {
      tone: 'flagged',
      headline: 'Flagged as anomalous',
      // VAR §4.3 PRESCRIBES this sentence ("This value deviates significantly
      // from historical average. Please verify."), so it is kept verbatim in
      // substance and the missing half is appended rather than substituted.
      // The average was never shown before: the banner asserted a deviation
      // from "the historical average" without ever naming it, so the one number
      // that would let an author judge the warning was the one number absent.
      detail:
        baseline === null
          ? `This value deviates significantly from the historical average for this reporting entity.`
          : `This value deviates significantly from the historical average for this reporting entity — ${tonnes(baseline)} over the previous ${ANOMALY_BASELINE_PERIODS} comparable periods, a deviation of more than ${pct}%.`,
    };
  }

  if (isAnomalyEvaluated(record)) {
    return {
      tone: 'clean',
      headline: 'Within the expected range',
      detail: `Compared against ${tonnes(baseline as number)}, the average of the previous ${ANOMALY_BASELINE_PERIODS} comparable periods, and within ${pct}%.`,
    };
  }

  // Everything below is NOT a verdict. Each branch says which absence it is,
  // because "no figure of its own", "not enough history" and "every prior was
  // zero" are three different things to do something about.
  if (priors === null) {
    return {
      tone: 'not_evaluated',
      headline: 'Not checked for anomalies',
      detail:
        'This category produces no calculated figure, so there is nothing to compare against its history.',
    };
  }

  if (priors >= ANOMALY_BASELINE_PERIODS) {
    return {
      tone: 'not_evaluated',
      headline: 'Not checked for anomalies',
      detail: `The previous ${ANOMALY_BASELINE_PERIODS} comparable periods average zero, so no deviation can be computed from them.`,
    };
  }

  return {
    tone: 'not_evaluated',
    headline: 'Not checked for anomalies',
    detail:
      priors === 0
        ? `No earlier committed period exists for this reporting entity, so there is no history to compare against. The check needs ${ANOMALY_BASELINE_PERIODS}.`
        : `Only ${priors} earlier committed ${priors === 1 ? 'period' : 'periods'} exist${priors === 1 ? 's' : ''} for this reporting entity; the check needs ${ANOMALY_BASELINE_PERIODS}.`,
  };
}

/**
 * The one-line form for a dashboard cell or a completeness panel, or null when
 * there is nothing to say. Takes a COUNT rather than a record: the cell knows
 * how many of its records went unchecked, not which.
 */
export function notEvaluatedNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 entry was not checked for anomalies — too few comparable periods.'
    : `${count} entries were not checked for anomalies — too few comparable periods.`;
}
