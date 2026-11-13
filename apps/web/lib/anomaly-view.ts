import { formatNumber } from '@/lib/i18n/number';
import type { ViewTranslator } from '@/lib/i18n/view-translator';
import {
  ANOMALY_BASELINE_PERIODS,
  ANOMALY_THRESHOLD,
  anomalyBasis,
  firstPeriodCeiling,
  isLegacyShortWindowVerdict,
  REFRIGERANT_LINE_CEILING_KG,
  unitSymbol,
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
 * A record may have been checked against three periods, checked against one or
 * two (limited history, BUG-R2-07, 2026-11-11), or never checked at all — and a
 * screen that words these alike says "fine" about data nobody looked at, or
 * claims a three-period average for a one-period comparison.
 */
export type AnomalyTone = 'flagged' | 'clean' | 'not_evaluated';

export interface AnomalyStatement {
  tone: AnomalyTone;
  headline: string;
  /** The sentence under the headline. Always names the window, so a reader
   *  never has to ask what "historical average" meant for THIS record. */
  detail: string;
  /**
   * True when an unflagged record must still be given its statement: it was
   * not checked, or it is clean on LIMITED history. A screen that shows a
   * verdict only when there is a flag (Data Entry, the review sheet) renders
   * nothing for "checked against three periods, clean" — and nothing must not
   * also stand for "never checked" or "checked against one".
   */
  qualified: boolean;
}

/** Enough of an activity record to state its verdict. Structural on purpose —
 *  the review queue, the drawer and the entry form each hold a different slice
 *  of the DTO, and none of them should have to hold all of it. */
export interface AnomalyVerdictFields {
  anomalyFlag: boolean;
  anomalyBaselinePriorCount: number | null;
  anomalyBaselineTCo2e: number | null;
  /** The record's own amount, for a first-period ceiling flag's figures
   *  (BUG-R2-07 tier 3). Optional: a screen that does not hold them states the
   *  flag without its figures, never without the flag. */
  category?: string;
  activityType?: string | null;
  activityValue?: number;
  activityUnit?: string;
  parameters?: unknown;
}

const pct = Math.round(ANOMALY_THRESHOLD * 100);

/** The `anomaly` catalogue keys this module words its statements with. */
export type AnomalyKey =
  | 'tonnes'
  | 'flagged.headline'
  | 'flagged.detail'
  | 'flagged.detailLimitedOne'
  | 'flagged.detailLimited'
  | 'flagged.detailNoBaseline'
  | 'ceiling.headline'
  | 'ceiling.detail'
  | 'ceiling.detailLine'
  | 'ceiling.detailRefillRatio'
  | 'ceiling.detailRefillCap'
  | 'ceiling.detailUnknown'
  | 'clean.headline'
  | 'clean.detail'
  | 'cleanLimited.headline'
  | 'cleanLimited.detailOne'
  | 'cleanLimited.detail'
  | 'notEvaluated.headline'
  | 'notEvaluated.noFigure'
  | 'notEvaluated.zeroAverage'
  | 'notEvaluated.zeroAverageLimited'
  | 'firstPeriod.headline'
  | 'firstPeriod.detail'
  | 'notEvaluated.scoredBefore'
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
  // `limited` — judged on one or two periods. A weaker claim than `full`, so
  // both the warning and the all-clear name the number of periods.
  const basis = anomalyBasis(record);

  // A first period above its typo ceiling (BUG-R2-07 tier 3, Decisions
  // 2026-11-12). There is no history, so no average may be named: the sentence
  // states the amount and the ceiling it passed, in the unit the user entered,
  // and asks for the two things an extra zero hides behind — the evidence and
  // the unit. The figures are derived from the CURRENT table; when they no
  // longer show the record above it (a later revision), the flag is still
  // stated, without figures.
  if (basis === 'ceiling') {
    return { tone: 'flagged', headline: t('ceiling.headline'), detail: ceilingDetail(record, t, locale), qualified: false };
  }

  if (record.anomalyFlag && basis === 'limited') {
    const values = { baseline: tonnes(baseline as number, t, locale), percent: pct };
    return {
      tone: 'flagged',
      headline: t('flagged.headline'),
      detail:
        priors === 1
          ? t('flagged.detailLimitedOne', values)
          : t('flagged.detailLimited', { ...values, count: priors as number }),
      qualified: false,
    };
  }

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
      qualified: false,
    };
  }

  if (basis === 'limited') {
    // Its own headline: "Within the expected range" has always meant a
    // three-period average, and one period has not earned that sentence.
    const values = { baseline: tonnes(baseline as number, t, locale), percent: pct };
    return {
      tone: 'clean',
      headline: t('cleanLimited.headline'),
      detail:
        priors === 1
          ? t('cleanLimited.detailOne', values)
          : t('cleanLimited.detail', { ...values, count: priors as number }),
      qualified: true,
    };
  }

  if (basis === 'full') {
    return {
      tone: 'clean',
      headline: t('clean.headline'),
      detail: t('clean.detail', { baseline: tonnes(baseline as number, t, locale), periods, percent: pct }),
      qualified: false,
    };
  }

  // Everything below is NOT a verdict. Each branch says which absence it is,
  // because "no figure of its own", "not enough history" and "every prior was
  // zero" are three different things to do something about.
  const headline = t('notEvaluated.headline');
  if (priors === null) {
    return { tone: 'not_evaluated', headline, detail: t('notEvaluated.noFigure'), qualified: true };
  }

  // A first-period record (UAT round 2, K4-3a option A): a figure with no
  // earlier period. Named for what it is, with what the reviewer can still
  // check — the evidence and the unit — never a count of periods it lacks.
  // Still not flagged, still counted as not checked.
  if (priors === 0) {
    return { tone: 'not_evaluated', headline: t('firstPeriod.headline'), detail: t('firstPeriod.detail'), qualified: true };
  }

  // Scored when one or two periods were not enough for the rule to run, and
  // not re-scored since (a committed record keeps the verdict it was given).
  // Said as what happened, not as a rule: one period IS enough today.
  if (isLegacyShortWindowVerdict(record)) {
    return {
      tone: 'not_evaluated',
      headline,
      detail: t('notEvaluated.scoredBefore', { count: priors, periods }),
      qualified: true,
    };
  }

  return {
    tone: 'not_evaluated',
    headline,
    detail:
      priors >= ANOMALY_BASELINE_PERIODS
        ? t('notEvaluated.zeroAverage', { periods })
        : t('notEvaluated.zeroAverageLimited'),
    qualified: true,
  };
}

function ceilingDetail(record: AnomalyVerdictFields, t: AnomalyTranslator, locale: Locale): string {
  const { category, activityValue, activityUnit } = record;
  const result =
    category !== undefined && activityValue !== undefined && activityUnit !== undefined
      ? firstPeriodCeiling({
          category,
          activityType: record.activityType ?? null,
          activityValue,
          activityUnit,
          parameters: record.parameters,
        })
      : null;
  if (!result?.above) return t('ceiling.detailUnknown');
  const symbol = unitSymbol(result.unit);
  // The amount as entered; the ceiling rounded to whole units, for display
  // only — the comparison was made in base units, unrounded.
  const amount = `${formatNumber(result.amount, locale, { maximumFractionDigits: 3 })} ${symbol}`;
  const ceiling = `${formatNumber(result.ceiling, locale, { maximumFractionDigits: 0 })} ${symbol}`;
  if (result.kind === 'equipment_refill') {
    // Which limit it passed: 125% of the line's capacity, or the 500 kg cap
    // (a line with no capacity, or a large one). Kilograms, to three places:
    // 125% of 10 kg is 12.5 kg, not 13.
    const kg = (v: number) => `${formatNumber(v, locale, { maximumFractionDigits: 3 })} ${symbol}`;
    const capacityKg = result.capacityKg ?? 0;
    const byRatio = capacityKg > 0 && result.ceiling < REFRIGERANT_LINE_CEILING_KG;
    return byRatio
      ? t('ceiling.detailRefillRatio', { refill: amount, ceiling: kg(result.ceiling), capacity: kg(capacityKg) })
      : t('ceiling.detailRefillCap', { refill: amount, ceiling: kg(result.ceiling) });
  }
  return result.kind === 'equipment_line'
    ? t('ceiling.detailLine', { capacity: amount, ceiling })
    : t('ceiling.detail', { amount, ceiling });
}

/**
 * True for a first-period record: it has a figure of its own and no earlier
 * period to compare it with. The review queue marks such a row, apart from the
 * flag's amber triangle.
 */
export function isFirstPeriodRecord(record: AnomalyVerdictFields): boolean {
  return !record.anomalyFlag && record.anomalyBaselinePriorCount === 0;
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
