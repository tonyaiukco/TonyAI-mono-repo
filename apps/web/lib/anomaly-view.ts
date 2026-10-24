import { formatNumber } from '@/lib/i18n/number';
import type { ViewTranslator } from '@/lib/i18n/view-translator';
import {
  ANOMALY_BASELINE_PERIODS,
  ANOMALY_THRESHOLD,
  isAnomalyEvaluated,
  type Locale,
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

/** The `anomaly` catalogue keys this module words its statements with. */
export type AnomalyKey =
  | 'tonnes'
  | 'flagged.headline'
  | 'flagged.detail'
  | 'flagged.detailNoBaseline'
  | 'clean.headline'
  | 'clean.detail'
  | 'notEvaluated.headline'
  | 'notEvaluated.noFigure'
  | 'notEvaluated.zeroAverage'
  | 'notEvaluated.noHistory'
  | 'notEvaluated.oneEarlier'
  | 'notEvaluated.someEarlier'
  | 'note.one'
  | 'note.other';

export type AnomalyTranslator = ViewTranslator<AnomalyKey>;

/** tCO₂e as the rest of the app prints it — three decimals, no trailing noise,
 *  no grouping (the English text the screens showed before LP4-04). */
function tonnes(value: number, t: AnomalyTranslator, locale: Locale): string {
  return t('tonnes', { value: formatNumber(value, locale, { maximumFractionDigits: 3, useGrouping: false }) });
}

export function anomalyStatement(record: AnomalyVerdictFields, t: AnomalyTranslator, locale: Locale): AnomalyStatement {
  const priors = record.anomalyBaselinePriorCount;
  const baseline = record.anomalyBaselineTCo2e;
  const periods = ANOMALY_BASELINE_PERIODS;

  if (record.anomalyFlag) {
    return {
      tone: 'flagged',
      headline: t('flagged.headline'),
      // VAR §4.3 PRESCRIBES this sentence ("This value deviates significantly
      // from historical average. Please verify."), so it is kept verbatim in
      // substance and the missing half is appended rather than substituted.
      // The average was never shown before: the banner asserted a deviation
      // from "the historical average" without ever naming it, so the one number
      // that would let an author judge the warning was the one number absent.
      detail:
        baseline === null
          ? t('flagged.detailNoBaseline')
          : t('flagged.detail', { baseline: tonnes(baseline, t, locale), periods, percent: pct }),
    };
  }

  if (isAnomalyEvaluated(record)) {
    return {
      tone: 'clean',
      headline: t('clean.headline'),
      detail: t('clean.detail', { baseline: tonnes(baseline as number, t, locale), periods, percent: pct }),
    };
  }

  // Everything below is NOT a verdict. Each branch says which absence it is,
  // because "no figure of its own", "not enough history" and "every prior was
  // zero" are three different things to do something about.
  const headline = t('notEvaluated.headline');
  if (priors === null) {
    return { tone: 'not_evaluated', headline, detail: t('notEvaluated.noFigure') };
  }

  if (priors >= ANOMALY_BASELINE_PERIODS) {
    return { tone: 'not_evaluated', headline, detail: t('notEvaluated.zeroAverage', { periods }) };
  }

  return {
    tone: 'not_evaluated',
    headline,
    detail:
      priors === 0
        ? t('notEvaluated.noHistory', { periods })
        : priors === 1
          ? t('notEvaluated.oneEarlier', { periods })
          : t('notEvaluated.someEarlier', { count: priors, periods }),
  };
}

/**
 * The one-line form for a dashboard cell or a completeness panel, or null when
 * there is nothing to say. Takes a COUNT rather than a record: the cell knows
 * how many of its records went unchecked, not which.
 */
export function notEvaluatedNote(count: number, t: AnomalyTranslator): string | null {
  if (count <= 0) return null;
  return count === 1 ? t('note.one') : t('note.other', { count });
}
