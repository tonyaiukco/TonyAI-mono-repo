import { IntlMessageFormat } from 'intl-messageformat';
import {
  ANOMALY_BASELINE_PERIODS,
  CATEGORY_ACTIVITY_TYPES,
  LOCALE_FORMAT_TAGS,
  UNSPECIFIED_ACTIVITY_TYPE,
  type Category,
  type Locale,
} from '@tonyai/shared-types';
import { escapeHtmlText } from '../common/html-escape';
import { ISSUANCE_CATALOGUES, type IssuanceMessageKey } from '../report-issuances/issuance-html';
import en from './i18n/en.json';
import tr from './i18n/tr.json';

/**
 * A live report's words in one language (D16; LP4-03 K6). The PDF and the
 * workbook print every heading, note, column label and categorical cell
 * through one of these; the CSV keeps its English machine vocabulary and never
 * takes one. English is the identity: `EN_VOCABULARY` prints exactly what the
 * writers printed before LP4-03, so a filed English export reads the same.
 *
 * Category and period names come from the issued report's catalogue — one
 * Turkish word for "Elektrik" across a live and an issued report.
 */

export type ReportMessageKey = keyof typeof en;
export const REPORT_CATALOGUES: Readonly<Record<Locale, Readonly<Record<ReportMessageKey, string>>>> = { en, tr };

type Values = Record<string, string | number>;

export interface ReportVocabulary {
  readonly locale: Locale;
  /** A message, formatted — plain text (Excel cells; escaped by the PDF writer where it lands in HTML). */
  text(key: ReportMessageKey, values?: Values): string;
  /**
   * A message for the PDF: formatted, then escaped whole; each `markup` value
   * is trusted HTML put in after the escape (a `<strong>` figure), never user
   * text — every user string goes in `values`, and is escaped with the rest.
   */
  html(key: ReportMessageKey, values?: Values, markup?: Record<string, string>): string;
  /** A column's printed label; its key is the English label. */
  label(english: string): string;
  /** The PDF's figures: one decimal, the language's separators. */
  readonly number: Intl.NumberFormat;
  category(category: string): string;
  period(periodValue: string): string;
  reportingPeriod(reportingPeriod: string): string;
  recordStatus(status: string): string;
  entity(r: { locationId?: string | null; locationName?: string | null }): string;
  activityType(r: { category: string; activityType: string | null }): string;
  anomaly(r: { anomalyFlag: boolean; anomalyEvaluated: boolean; anomalyBaselinePriorCount: number | null }): string;
  readonly notCalculated: string;
  /**
   * A stored figure in full inside a text cell (the workbook's notes, K6):
   * its shortest round-trip digits — never rounded, never an exponent — with
   * the language's decimal mark and no grouping. `1.5e-21` stays nonzero in
   * every language (Codex's B9 P2-1 on LP4-03 PR A).
   */
  fullFigure(n: number): string;
}

/** `String(n)`'s digits with any exponent moved into place: `1.5e-21` → `0.0000000000000000000015`. */
export function plainDigits(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const text = String(n);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (match === null) return text;
  const [, sign, whole, fraction = '', exponent] = match;
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

const MARK_OPEN = '\u0001';
const MARK_CLOSE = '\u0002';

const cache = new Map<Locale, ReportVocabulary>();

export function reportVocabulary(locale: Locale): ReportVocabulary {
  const cached = cache.get(locale);
  if (cached !== undefined) return cached;
  const messages = REPORT_CATALOGUES[locale];
  const issued = ISSUANCE_CATALOGUES[locale];
  const tag = LOCALE_FORMAT_TAGS[locale];
  const text = (key: ReportMessageKey, values?: Values): string =>
    String(new IntlMessageFormat(messages[key], tag).format(values));
  const keyed = (key: string, fallback: string): string =>
    key in messages ? messages[key as ReportMessageKey] : fallback;
  // The language's own decimal mark, as its number format writes one.
  const decimalMark = new Intl.NumberFormat(tag).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.';
  const issuedLabel = (key: string, fallback: string): string =>
    key in issued ? issued[key as IssuanceMessageKey] : fallback;

  const vocabulary: ReportVocabulary = {
    locale,
    text,
    html(key, values = {}, markup = {}) {
      // A user string cannot carry a marker, so it can never be swapped for markup.
      const marked: Values = Object.fromEntries(Object.entries(values).map(([name, v]) =>
        [name, typeof v === 'string' ? v.split(MARK_OPEN).join('').split(MARK_CLOSE).join('') : v]));
      for (const name of Object.keys(markup)) marked[name] = `${MARK_OPEN}${name}${MARK_CLOSE}`;
      let out = escapeHtmlText(text(key, marked));
      for (const [name, html] of Object.entries(markup)) out = out.split(`${MARK_OPEN}${name}${MARK_CLOSE}`).join(html);
      return out;
    },
    label: (english) => keyed(`label ${english}`, english),
    number: new Intl.NumberFormat(locale === 'en' ? 'en-GB' : tag, { maximumFractionDigits: 1 }),
    // English prints the stored word, as it always has; Turkish its catalogue's.
    category: (c) => (locale === 'en' ? c : issuedLabel(`category ${c}`, c)),
    period: (v) => (locale === 'en' ? v : issuedLabel(`period ${v}`, v)),
    reportingPeriod: (p) => keyed(`reportingPeriod ${p}`, p),
    recordStatus: (s) => keyed(`status ${s}`, s),
    entity(r) {
      const named = r.locationName?.trim();
      if (named) return named;
      return r.locationId ? text('unnamedSite') : text('wholeCompany');
    },
    activityType(r) {
      if (!r.activityType) return '';
      if (r.activityType === UNSPECIFIED_ACTIVITY_TYPE) return text('activityNotSpecified');
      const english = CATEGORY_ACTIVITY_TYPES[r.category as Category]?.types.find((t) => t.value === r.activityType)?.label
        ?? r.activityType;
      return keyed(`activity ${english}`, english);
    },
    anomaly(r) {
      if (r.anomalyFlag) return text('anomalyYes');
      if (r.anomalyEvaluated) return '';
      const priors = r.anomalyBaselinePriorCount;
      if (priors === null) return text('notEvaluatedNoFigure');
      if (priors >= ANOMALY_BASELINE_PERIODS) return text('notEvaluatedZeroBaseline');
      return text('notEvaluatedPriors', { priors, needed: ANOMALY_BASELINE_PERIODS });
    },
    notCalculated: text('notCalculated'),
    fullFigure(n) {
      const plain = plainDigits(n);
      return locale === 'en' ? plain : plain.replace('.', decimalMark);
    },
  };
  cache.set(locale, vocabulary);
  return vocabulary;
}

export const EN_VOCABULARY = reportVocabulary('en');
