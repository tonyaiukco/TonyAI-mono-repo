import { ApiError } from "@/lib/api";
import type { ErrorDescription } from "@/lib/i18n/errors";
import type { ViewCopy } from "@/lib/i18n/view-translator";
import { PERIOD_VALUES } from "@/lib/types";
import type { RecordWords } from "@/lib/vocabulary";

/**
 * The Emissions screen's words that are not markup: its error sentences and
 * the trend axis' period labels (LP4-04 slice 2). Pure, so both languages are
 * testable without React.
 */

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
