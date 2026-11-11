import { ApiError } from "@/lib/api";
import type { ErrorDescription } from "@/lib/i18n/errors";
import type { ViewCopy } from "@/lib/i18n/view-translator";
import { PERIOD_VALUES, type EmissionsSummary, type EmissionsTrendPoint, type ReportingIntensityMetric, type ReportScope3Disclosure } from "@/lib/types";
import type { RecordWords } from "@/lib/vocabulary";

/**
 * The Emissions screen's words that are not markup: its error sentences and
 * the trend axis' period labels (LP4-04 slice 2). Pure, so both languages are
 * testable without React.
 */

/**
 * The page-local URL key that opens one of Emissions' tabs (UAT round 2,
 * BUG-R2-06): the matrix cell's "View record history" link. Not a reporting
 * context key — it is this page's view, read once on load and never written
 * back. Only `history` is honoured; anything else opens the summary.
 */
export const EMISSIONS_TAB_PARAM = "tab";
export const EMISSIONS_HISTORY_TAB = "history";

export function initialEmissionsTab(params: { get(name: string): string | null }): string {
  return params.get(EMISSIONS_TAB_PARAM) === EMISSIONS_HISTORY_TAB ? EMISSIONS_HISTORY_TAB : "summary";
}

/** The `emissions` keys an error is worded with. */
export type EmissionsErrorKey = "errors.sessionExpired" | "errors.forbidden" | "errors.unavailable";

/**
 * A failed analytics read in the user's words. The screen explains the three
 * statuses it always has (a lapsed session, a seat without access, an
 * outage); anything else is the API's own refusal, described by its code
 * (`describe`, which keeps the server's English beneath a generic Turkish
 * sentence — K5).
 */
export function emissionsError(
  error: unknown,
  { t }: ViewCopy<EmissionsErrorKey>,
  describe: (error: unknown) => ErrorDescription,
): ErrorDescription {
  if (error instanceof ApiError) {
    if (error.status === 401) return { title: t("errors.sessionExpired") };
    if (error.status === 403) return { title: t("errors.forbidden") };
    if (error.status >= 500) return { title: t("errors.unavailable") };
  }
  return describe(error);
}

/** The `emissions` keys a trend period is labelled with. */
export type TrendLabelKey = "trend.month" | "trend.quarter";

const MONTHS: readonly string[] = PERIOD_VALUES.monthly;

/**
 * A trend bucket's label in the user's language. The API labels buckets in
 * one fixed form (`EmissionsTrendPoint.period`: "2024", "2024-Q1",
 * "January 2024", the month a canonical `PERIOD_VALUES` entry), so the parts
 * are read back and re-worded here; anything else is shown as sent.
 */
export function trendLabel(period: string, { t }: ViewCopy<TrendLabelKey>, words: RecordWords): string {
  const quarter = /^(\d{4})-(Q[1-4])$/.exec(period);
  if (quarter) return t("trend.quarter", { year: quarter[1], quarter: words.period(quarter[2]) });
  const month = /^(\S+) (\d{4})$/.exec(period);
  if (month && MONTHS.includes(month[1])) return t("trend.month", { month: words.period(month[1]), year: month[2] });
  return period;
}

/**
 * The figures a summary shows that are not authoritative now (a placeholder or
 * fixture factor, a pre-release snapshot, a release withdrawn since), for the
 * screen to label them explicitly: null when there are none, or when an older
 * server does not say. The banner above them states no standing of its own (QA L10).
 */
export function nonAuthoritativeFigures(
  summary: Pick<EmissionsSummary, "calculatedRecordCount" | "nonAuthoritativeRecordCount"> | null | undefined,
): { count: number; of: number } | null {
  const count = summary?.nonAuthoritativeRecordCount ?? 0;
  return summary && count > 0 ? { count, of: summary.calculatedRecordCount } : null;
}

/**
 * A metric whose denominator holds a subsidiary with no Scope 1 or 2 figure: it
 * reads low if that subsidiary's figures are only missing (D14). Null when every
 * contributor has a figure, or an older server does not say.
 */
export function intensityFigureGap(
  metric: Pick<ReportingIntensityMetric, 'contributingSubsidiaryIds' | 'contributingWithFigureCount'>,
): { withFigure: number; contributing: number } | null {
  const contributing = metric.contributingSubsidiaryIds.length;
  const withFigure = metric.contributingWithFigureCount ?? contributing;
  return withFigure < contributing ? { withFigure, contributing } : null;
}

type TrendReading = Pick<EmissionsTrendPoint, 'total' | 'scope3' | 'scope12RecordCount' | 'scope3RecordCount'>;

/**
 * First to last point of a trend series, in percent. A Scope 3 selection reads
 * Scope 3; any other reads the main total. A bucket joins only if it holds a
 * calculated record on that side: tonnes cannot tell a measured zero, which is a
 * real reduction, from a bucket of Scope 3 alone, which is none (Decisions
 * 2026-11-09 (3)). 0 when there is nothing to compare.
 */
export function trendChangePercent(points: readonly TrendReading[], scope3Only: boolean): number {
  const reading = (p: TrendReading) => (scope3Only ? p.scope3 : p.total);
  const held = points.filter((p) => (scope3Only ? p.scope3RecordCount : p.scope12RecordCount) > 0);
  if (held.length < 2) return 0;
  const first = reading(held[0]);
  if (first === 0) return 0;
  return ((reading(held[held.length - 1]) - first) / first) * 100;
}

/** The live report preview's figures: its Scope 1/2 summary and the Scope 3 tonnes it discloses beside it. */
export function liveReportNonAuthoritative(
  summary: Pick<EmissionsSummary, "calculatedRecordCount" | "nonAuthoritativeRecordCount"> | null | undefined,
  scope3: Pick<ReportScope3Disclosure, "recordCount" | "uncalculatedRecordCount" | "nonAuthoritativeRecordCount"> | null | undefined,
): { count: number; of: number } | null {
  if (!summary) return null;
  const s3 = scope3 ?? { recordCount: 0, uncalculatedRecordCount: 0, nonAuthoritativeRecordCount: 0 };
  return nonAuthoritativeFigures({
    calculatedRecordCount: summary.calculatedRecordCount + (s3.recordCount - s3.uncalculatedRecordCount),
    nonAuthoritativeRecordCount: (summary.nonAuthoritativeRecordCount ?? 0) + (s3.nonAuthoritativeRecordCount ?? 0),
  });
}
