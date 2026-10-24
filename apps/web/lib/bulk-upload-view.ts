import { deadlineSummary, type DeadlineTranslator } from './bulk-submit-view';
import {
  BULK_UPLOAD_ALLOWED_EXTENSIONS,
  BULK_UPLOAD_MAX_SIZE_BYTES,
  unitSymbol,
  type Locale,
} from '@/lib/types';
import { formatNumber, formatReadAmount } from '@/lib/i18n/number';
import type { ViewCopy } from '@/lib/i18n/view-translator';
import type {
  BulkUploadAcceptedRow,
  BulkUploadColumn,
  BulkUploadIssueCode,
  BulkUploadReportDTO,
  BulkUploadRowIssue,
} from '@/lib/types';
import { ApiError } from '@/lib/api';
import type { DescribeError, ErrorWords } from './bulk-submit-view';
import enErrors from '@/messages/en/errors.json';
import enEntry from '@/messages/en/dataEntry.json';

/**
 * The client half of bulk upload: whether a file is worth sending, what the
 * server's report means, and what the screen says at each step.
 *
 * All of it lives here rather than in the panel because `vitest.config.ts`
 * collects only `lib/**` — logic left in a component has no coverage in either
 * direction, permanently. So the component renders already-decided strings and
 * decides nothing itself.
 */

export {
  BULK_UPLOAD_ALLOWED_EXTENSIONS,
  BULK_UPLOAD_MAX_ROWS,
  BULK_UPLOAD_MAX_SIZE_BYTES,
} from '@/lib/types';

/**
 * How many rows of one problem to render before folding the rest away.
 *
 * A thousand-row file can carry several thousand issues, and a list that long
 * is not something a user scrolls — it is a hung tab. The server takes the
 * same view, truncating its own offending-row list at ten.
 */
export const MAX_ISSUE_ROWS_PER_GROUP = 50;

/** The `bulkUpload` catalogue keys this module words its sentences with. */
export type BulkUploadKey =
  | 'sizeCap'
  | 'rowsOne'
  | 'rowsMany'
  | 'or'
  | 'preflight.extension'
  | 'preflight.tooLarge'
  | 'preflight.empty'
  | 'summary.refusedPreview'
  | 'summary.refusedApplied'
  | 'summary.refusedOne'
  | 'summary.refusedMany'
  | 'summary.refusedNone'
  | 'summary.cleanOnePreview'
  | 'summary.cleanOneApplied'
  | 'summary.cleanManyPreview'
  | 'summary.cleanManyApplied'
  | 'summary.partialPreview'
  | 'summary.partialAppliedOne'
  | 'summary.partialAppliedMany'
  | 'summary.notOne'
  | 'summary.notMany'
  | 'summary.retryPreviewOne'
  | 'summary.retryPreviewMany'
  | 'summary.retryAppliedOne'
  | 'summary.retryAppliedMany'
  | 'summary.warnedOne'
  | 'summary.warnedMany'
  | 'summary.draftOne'
  | 'summary.draftMany'
  | 'tonnes.none'
  | 'tonnes.figure'
  | 'tonnes.partialOne'
  | 'tonnes.partialMany'
  | 'applyConfirmOne'
  | 'applyConfirmMany'
  | 'appliedOne'
  | 'appliedMany'
  | 'appliedNone'
  | 'error.rateLimited'
  | 'error.tooLarge'
  | 'error.roleForbidden'
  | 'error.failed'
  | 'template.rateLimited'
  | 'template.failed';

export type BulkUploadCopy = ViewCopy<BulkUploadKey>;

/** What the file picker offers. Derived, so it cannot drift from the server. */
export function fileAcceptAttribute(): string {
  return BULK_UPLOAD_ALLOWED_EXTENSIONS.join(',');
}

/** The size cap as the screen says it. Derived for the same reason. */
export function sizeCapLabel({ t, locale }: BulkUploadCopy): string {
  return t('sizeCap', { value: formatNumber(BULK_UPLOAD_MAX_SIZE_BYTES / 1024 / 1024, locale) });
}

/** `1 row` / `2 rows`, in one place rather than five. */
export function rowCount(n: number, { t, locale }: BulkUploadCopy): string {
  const count = formatNumber(n, locale);
  return n === 1 ? t('rowsOne', { count }) : t('rowsMany', { count });
}

/**
 * Why this file should not be sent, or `null` when it may be.
 *
 * Mirrors the server's own checks so an obvious refusal costs no request —
 * which matters more than it looks: the import budget is five a minute per
 * user, and a dry run plus an apply already spends two of them.
 *
 * Structural parameter rather than `File` so a spec need not fake one.
 */
export function preflightFile(
  file: {
    name: string;
    size: number;
  },
  copy: BulkUploadCopy,
): string | null {
  const { t } = copy;
  const dot = file.name.lastIndexOf('.');
  const extension = dot < 0 ? '' : file.name.slice(dot).toLowerCase();
  if (!(BULK_UPLOAD_ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    return t('preflight.extension', { extensions: BULK_UPLOAD_ALLOWED_EXTENSIONS.join(` ${t('or')} `) });
  }
  if (file.size > BULK_UPLOAD_MAX_SIZE_BYTES) {
    return t('preflight.tooLarge', { cap: sizeCapLabel(copy) });
  }
  if (file.size === 0) return t('preflight.empty');
  return null;
}

/**
 * A short name for every issue the server can report.
 *
 * Exhaustive on purpose: `Record<BulkUploadIssueCode, string>` means adding a
 * code in `@tonyai/shared-types` is a COMPILE ERROR here rather than a blank
 * label in front of a user. The audit screen's action-colour map already works
 * this way for the same reason.
 */
export const ISSUE_CODE_LABEL: Record<BulkUploadIssueCode, string> = enErrors.bulkUploadIssues;

/** The column names as a person reads them. Exhaustive for the same reason. */
export const COLUMN_LABEL: Record<BulkUploadColumn, string> = enEntry.bulkColumns;

export const ACTIVITY_TYPE_LABEL = enEntry.activityTypes;

export function bulkActivityLabel(activityType: string | null,
  translate: (key: `activityTypes.${keyof typeof ACTIVITY_TYPE_LABEL}` | 'bulkPreview.noActivityType') => string,
): string {
  if (activityType === null) return translate('bulkPreview.noActivityType');
  // Unknown future values remain visible instead of silently reading as blank.
  return Object.hasOwn(ACTIVITY_TYPE_LABEL, activityType)
    ? translate(`activityTypes.${activityType as keyof typeof ACTIVITY_TYPE_LABEL}`)
    : activityType;
}

/**
 * An accepted row's amount as the server read it, in the user's locale with
 * its unit (`1,234 kWh` in Turkish for a file's `1.234`; D15). Formatted from
 * the number, never the file's text, so a language change cannot change it.
 */
export function readAmountLabel(row: Pick<BulkUploadAcceptedRow, 'activityValue' | 'activityUnit'>, locale: Locale): string {
  return `${formatReadAmount(row.activityValue, locale)} ${unitSymbol(row.activityUnit)}`;
}

export interface IssueGroup {
  code: BulkUploadIssueCode;
  label: string;
  count: number;
  /** Every issue with this code, row ascending. */
  rows: BulkUploadRowIssue[];
}

/**
 * Group issues by what is wrong, commonest first.
 *
 * A user fixing a file works one problem at a time — "seventeen rows name a
 * period that is closed" is a decision; seventeen separate lines scattered
 * through a thousand are a search.
 */
export function groupIssues(
  issues: BulkUploadRowIssue[],
  // The screen passes the catalogue's (`errors.bulkUploadIssues.<code>`, LP4-04);
  // no English default (LP4-04 slice 2 follow-up 2).
  labelOf: (code: BulkUploadIssueCode) => string,
): IssueGroup[] {
  const byCode = new Map<BulkUploadIssueCode, BulkUploadRowIssue[]>();
  for (const issue of issues) {
    const list = byCode.get(issue.code) ?? [];
    list.push(issue);
    byCode.set(issue.code, list);
  }
  return [...byCode.entries()]
    .map(([code, rows]) => ({
      code,
      label: labelOf(code),
      count: rows.length,
      rows: [...rows].sort((a, b) => a.row - b.row),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * The total of what would be, or was, imported — or `null` when nothing in it
 * has a figure.
 *
 * Sums only the non-null values. A client folding with `?? 0` turns "this
 * category is tracked but never calculated" into a reported zero, which is the
 * exact defect the nullable `tCo2e` exists to prevent.
 */
export function totalTonnes(rows: BulkUploadAcceptedRow[]): number | null {
  const figures = rows
    .map((r) => r.tCo2e)
    .filter((v): v is number => v !== null);
  if (figures.length === 0) return null;
  return figures.reduce((sum, v) => sum + v, 0);
}

export interface BulkUploadSummary {
  tone: 'clean' | 'partial' | 'refused';
  headline: string;
  detail: string | null;
  acceptedCount: number;
  errorCount: number;
  /** DISTINCT rows carrying at least one error — not `errors.length`. */
  affectedRows: number;
  warningCount: number;
  /**
   * DISTINCT rows carrying at least one warning — the number the verdict
   * prints. `warningCount` counts issues, and an anomalous electricity row
   * carries two: printing that count told a user importing ONE row that
   * "2 rows need attention" (measured against the real report).
   */
  warnedRows: number;
}

/** The one-glance verdict above the report. */
export function summarise(report: BulkUploadReportDTO, translate: DeadlineTranslator, copy: BulkUploadCopy): BulkUploadSummary {
  const { t, locale } = copy;
  const acceptedCount = report.accepted.length;
  const affectedRows = new Set(report.errors.map((e) => e.row)).size;
  const warnedRows = new Set(report.warnings.map((w) => w.row)).size;

  const counts = {
    acceptedCount,
    errorCount: report.errors.length,
    affectedRows,
    warningCount: report.warnings.length,
    warnedRows,
  };

  const deadline = deadlineSummary(acceptedCount, report.errors, translate, copy.locale, report.dryRun);
  if (deadline) return { ...counts, ...deadline };

  if (acceptedCount === 0) {
    return {
      ...counts,
      tone: 'refused',
      headline: report.dryRun ? t('summary.refusedPreview') : t('summary.refusedApplied'),
      detail:
        affectedRows === 1
          ? t('summary.refusedOne')
          : affectedRows > 1
            ? t('summary.refusedMany', { rows: rowCount(affectedRows, copy) })
            : t('summary.refusedNone'),
    };
  }
  if (affectedRows === 0) {
    return {
      ...counts,
      tone: 'clean',
      headline:
        acceptedCount === 1
          ? t(report.dryRun ? 'summary.cleanOnePreview' : 'summary.cleanOneApplied')
          : t(report.dryRun ? 'summary.cleanManyPreview' : 'summary.cleanManyApplied', { rows: rowCount(acceptedCount, copy) }),
      detail: afterword(report, warnedRows, copy),
    };
  }
  const values = { accepted: formatNumber(acceptedCount, locale), total: formatNumber(report.totalRows, locale) };
  return {
    ...counts,
    tone: 'partial',
    headline: report.dryRun
      ? t('summary.partialPreview', values)
      : acceptedCount === 1
        ? t('summary.partialAppliedOne', values)
        : t('summary.partialAppliedMany', values),
    detail: [
      affectedRows === 1 ? t('summary.notOne') : t('summary.notMany', { count: formatNumber(affectedRows, locale) }),
      retryAdvice(report, affectedRows, copy),
      afterword(report, warnedRows, copy),
    ]
      .filter((part): part is string => part !== null)
      .join(' '),
  };
}

/**
 * What to do about the rows that failed.
 *
 * Branches on `dryRun`, and it has to: after a real partial import, telling a
 * user to fix their file and upload it AGAIN means re-sending the rows that
 * already succeeded, which comes back as a wall of `duplicate_existing`.
 */
function retryAdvice(report: BulkUploadReportDTO, failedRows: number, { t }: BulkUploadCopy): string {
  const one = failedRows === 1;
  return report.dryRun
    ? t(one ? 'summary.retryPreviewOne' : 'summary.retryPreviewMany')
    : t(one ? 'summary.retryAppliedOne' : 'summary.retryAppliedMany');
}

/**
 * The two things a user would otherwise discover afterwards: that some rows
 * carry a warning, and that everything imported lands as a draft.
 *
 * `draft` is in neither the counted statuses nor the review queue's, so an
 * import moves no total and no invoice fraction — including on the
 * completeness panel sitting on the same screen, which this panel deliberately
 * refreshes (a cell holding a draft does turn amber: a draft is something left
 * to look at). Saying it only in a dialog the user dismisses and a toast that
 * fades is saying it nowhere.
 */
function afterword(
  report: BulkUploadReportDTO,
  warnedRows: number,
  { t, locale }: BulkUploadCopy,
): string | null {
  const parts: string[] = [];
  if (warnedRows > 0) {
    const count = formatNumber(warnedRows, locale);
    parts.push(warnedRows === 1 ? t('summary.warnedOne', { count }) : t('summary.warnedMany', { count }));
  }
  if (!report.dryRun) {
    parts.push(report.accepted.length === 1 ? t('summary.draftOne') : t('summary.draftMany'));
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * A tonnage for the screen, or the honest absence of one — and, when it covers
 * only part of the set, how much of it.
 *
 * The partial case is the one that matters. A file mixing Water (tracked but
 * never calculated) with Electricity produces one figure and one row count,
 * and an unqualified `4.000 tCO₂e` beside `40 rows` reads as the total for all
 * forty. In a compliance product that is a number someone pastes into a
 * report. Avoiding `?? 0` at the row level and then re-creating it at the
 * aggregate would be the same defect one layer up.
 */
export function tonnesLabel(rows: BulkUploadAcceptedRow[], copy: BulkUploadCopy): string {
  const { t, locale } = copy;
  const total = totalTonnes(rows);
  if (total === null) return t('tonnes.none');
  const counted = rows.filter((r) => r.tCo2e !== null).length;
  const figure = t('tonnes.figure', {
    value: formatNumber(total, locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 }),
  });
  if (counted === rows.length) return figure;
  const missing = rows.length - counted;
  const values = {
    figure,
    counted: formatNumber(counted, locale),
    rows: rowCount(rows.length, copy),
    missing: formatNumber(missing, locale),
  };
  return missing === 1 ? t('tonnes.partialOne', values) : t('tonnes.partialMany', values);
}

/**
 * What the confirm step says before anything is written.
 *
 * Names the count, the tonnage, and the thing a user would otherwise discover
 * afterwards: the rows land as drafts. `draft` is in neither the counted
 * statuses nor the review queue's, so an import moves no total and fills no
 * queue until each row is submitted.
 */
export function canApplyPreview(report: BulkUploadReportDTO): boolean {
  return report.dryRun && report.accepted.length > 0
    && report.completion !== 'deadline_exceeded'
    && !report.errors.some((issue) => issue.code === 'not_processed_deadline');
}

export function applyConfirmation(report: BulkUploadReportDTO, copy: BulkUploadCopy): string {
  const count = report.accepted.length;
  const tonnes = tonnesLabel(report.accepted, copy);
  return count === 1
    ? copy.t('applyConfirmOne', { tonnes })
    : copy.t('applyConfirmMany', { count: formatNumber(count, copy.locale), tonnes });
}

/**
 * The toast after a successful apply.
 *
 * It used to end "Submit them for review to count them towards your
 * inventory" — true, and for one release the only way to do it was opening
 * every draft in the form below. The panel now offers the remedy directly, so
 * the sentence points at it.
 */
export function applySuccessMessage(report: BulkUploadReportDTO, { t, locale }: BulkUploadCopy): string {
  const count = report.accepted.length;
  return count === 1 ? t('appliedOne') : t('appliedMany', { count: formatNumber(count, locale) });
}

/**
 * The toast after an apply returned — which is not the same thing as "it
 * worked".
 *
 * A 200 can carry zero accepted rows (every row refused at write time — a
 * period locked between the dry run and the apply, say), and the success toast
 * used to fire for it anyway: "0 records imported as drafts".
 */
export function applyToast(report: BulkUploadReportDTO, translate: DeadlineTranslator, copy: BulkUploadCopy): {
  kind: 'success' | 'warning';
  message: string;
  description?: string;
} {
  const deadline = deadlineSummary(report.accepted.length, report.errors, translate, copy.locale);
  if (deadline) return { kind: 'warning', message: deadline.headline, description: deadline.detail };
  return report.accepted.length > 0
    ? { kind: 'success', message: applySuccessMessage(report, copy) }
    : { kind: 'warning', message: copy.t('appliedNone') };
}

/**
 * The sentence for a failure that refused the whole request.
 *
 * Branches on status rather than trusting the body: a 413 comes from multer
 * before any of our code runs and may carry no usable message at all, and a
 * 429 needs to explain the budget rather than repeat "Too Many Requests".
 * Everything else already carries the server's own sentence, which is written
 * for the person reading it.
 */
export function uploadErrorMessage(
  error: unknown,
  translate: (key: 'bulkQueryTooBroad') => string,
  copy: BulkUploadCopy,
  describe: DescribeError,
): ErrorWords {
  const { t, locale } = copy;
  if (error instanceof ApiError) {
    if (error.code === 'query_too_broad') return { title: translate('bulkQueryTooBroad') };
    if (error.status === 429) return { title: t('error.rateLimited') };
    if (error.status === 413) {
      return { title: t('error.tooLarge', { cap: t('sizeCap', { value: formatNumber(BULK_UPLOAD_MAX_SIZE_BYTES / 1024 / 1024, locale) }) }) };
    }
    if (error.status === 403) return { title: t('error.roleForbidden') };
  }
  if (!(error instanceof Error)) return { title: t('error.failed') };
  return describe(error);
}

/**
 * The sentence for a failed template download.
 *
 * It used to borrow `uploadErrorMessage`, whose 429 blames "import attempts"
 * and dry runs — neither of which a download spends: throttler keys include
 * the handler, so the template route has a budget of its own.
 */
export function templateErrorMessage(error: unknown, { t }: BulkUploadCopy, describe: DescribeError): ErrorWords {
  if (error instanceof ApiError && error.status === 429) return { title: t('template.rateLimited') };
  if (!(error instanceof Error)) return { title: t('template.failed') };
  return describe(error);
}
