import {
  BULK_UPLOAD_ALLOWED_EXTENSIONS,
  BULK_UPLOAD_MAX_SIZE_BYTES,
} from '@/lib/types';
import type {
  BulkUploadAcceptedRow,
  BulkUploadColumn,
  BulkUploadIssueCode,
  BulkUploadReportDTO,
  BulkUploadRowIssue,
} from '@/lib/types';
import { ApiError, SESSION_EXPIRED_MESSAGE } from '@/lib/api';
import { formatNumber } from '@/lib/utils';

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

/** What the file picker offers. Derived, so it cannot drift from the server. */
export function fileAcceptAttribute(): string {
  return BULK_UPLOAD_ALLOWED_EXTENSIONS.join(',');
}

/** The size cap as the screen says it. Derived for the same reason. */
export function sizeCapLabel(): string {
  return `${formatNumber(BULK_UPLOAD_MAX_SIZE_BYTES / 1024 / 1024)} MB`;
}

/** `1 row` / `2 rows`, in one place rather than five. */
export function rowCount(n: number): string {
  return `${formatNumber(n)} ${n === 1 ? 'row' : 'rows'}`;
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
export function preflightFile(file: {
  name: string;
  size: number;
}): string | null {
  const dot = file.name.lastIndexOf('.');
  const extension = dot < 0 ? '' : file.name.slice(dot).toLowerCase();
  if (!(BULK_UPLOAD_ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    return `Upload a ${BULK_UPLOAD_ALLOWED_EXTENSIONS.join(' or ')} file.`;
  }
  if (file.size > BULK_UPLOAD_MAX_SIZE_BYTES) {
    // The measured size is deliberately NOT quoted: at 2.04 MB, one decimal
    // place read "That file is 2.0 MB. The limit is 2 MB." — a sentence that
    // argues with itself.
    return `That file is over the ${sizeCapLabel()} limit — split it and upload the parts.`;
  }
  if (file.size === 0) return 'That file is empty.';
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
export const ISSUE_CODE_LABEL: Record<BulkUploadIssueCode, string> = {
  invalid: 'Invalid value',
  duplicate_in_file: 'Duplicated in this file',
  duplicate_existing: 'Already recorded',
  not_found: 'Unknown reporting entity',
  no_factor: 'No emission factor',
  period_locked: 'Period closed',
  unexpected: 'Could not be imported',
  formula_lead: 'Reads as a formula',
  would_block_submit: 'Cannot be submitted yet',
  evidence_required: 'Needs an evidence file',
};

/** The column names as a person reads them. Exhaustive for the same reason. */
export const COLUMN_LABEL: Record<BulkUploadColumn, string> = {
  subsidiaryId: 'Reporting entity',
  locationId: 'Site',
  reportingYear: 'Year',
  reportingPeriod: 'Granularity',
  periodValue: 'Period',
  category: 'Category',
  activityValue: 'Activity value',
  activityUnit: 'Unit',
  varianceReason: 'Variance reason',
};

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
export function groupIssues(issues: BulkUploadRowIssue[]): IssueGroup[] {
  const byCode = new Map<BulkUploadIssueCode, BulkUploadRowIssue[]>();
  for (const issue of issues) {
    const list = byCode.get(issue.code) ?? [];
    list.push(issue);
    byCode.set(issue.code, list);
  }
  return [...byCode.entries()]
    .map(([code, rows]) => ({
      code,
      label: ISSUE_CODE_LABEL[code],
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
export function summarise(report: BulkUploadReportDTO): BulkUploadSummary {
  const acceptedCount = report.accepted.length;
  // A refused row carries exactly one error today (the API's own rule), but a
  // row can carry several warnings — and `errors.length` is only "rows that
  // failed" while that rule holds, so both are counted from the ROWS. Telling
  // a user 1,400 rows failed out of 1,000 is the kind of arithmetic that costs
  // trust in every other number on the screen.
  const affectedRows = new Set(report.errors.map((e) => e.row)).size;
  // The same arithmetic for the warnings, which did not get it.
  const warnedRows = new Set(report.warnings.map((w) => w.row)).size;

  const counts = {
    acceptedCount,
    errorCount: report.errors.length,
    affectedRows,
    warningCount: report.warnings.length,
    warnedRows,
  };

  if (acceptedCount === 0) {
    return {
      ...counts,
      tone: 'refused',
      headline: `No rows ${report.dryRun ? 'can be imported' : 'were imported'}.`,
      detail:
        affectedRows === 1
          ? 'The one row in the file has a problem to fix.'
          : affectedRows > 1
            ? `All ${rowCount(affectedRows)} in the file have a problem to fix.`
            : 'The file has no rows to import.',
    };
  }
  if (affectedRows === 0) {
    return {
      ...counts,
      tone: 'clean',
      // Never "All 1 row were imported." — measured, and the one-row file is
      // the first thing anyone tries.
      headline:
        acceptedCount === 1
          ? `1 row ${report.dryRun ? 'would be imported' : 'was imported'}.`
          : `All ${rowCount(acceptedCount)} ${
              report.dryRun ? 'would be imported' : 'were imported'
            }.`,
      // Never null any more. A clean verdict used to say nothing else, which
      // is how a file whose every row warns `evidence_required` rendered as
      // an unqualified success — and, after an apply, how the persistent
      // surface stayed silent about the drafts while the completeness panel
      // one column away showed identical numbers.
      detail: afterword(report, warnedRows),
    };
  }
  return {
    ...counts,
    tone: 'partial',
    headline: `${formatNumber(acceptedCount)} of ${formatNumber(report.totalRows)} rows ${
      report.dryRun
        ? 'would be imported'
        : acceptedCount === 1
          ? 'was imported'
          : 'were imported'
    }.`,
    // Joined with a space. Concatenated, the screen read "…upload it again.5
    // rows need attention before they can be submitted" (measured).
    detail: [
      `${affectedRows === 1 ? '1 row was' : `${formatNumber(affectedRows)} rows were`} not.`,
      retryAdvice(report, affectedRows),
      afterword(report, warnedRows),
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
function retryAdvice(report: BulkUploadReportDTO, failedRows: number): string {
  const one = failedRows === 1;
  return report.dryRun
    ? `Fix ${one ? 'it' : 'them'} in your file and upload the file again.`
    : `Fix ${one ? 'it' : 'them'} and upload a file containing only ${
        one ? 'that row' : 'those rows'
      } — re-sending the whole file would report the imported ones as duplicates.`;
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
): string | null {
  const parts: string[] = [];
  if (warnedRows > 0) {
    parts.push(
      `${formatNumber(warnedRows)} ${
        warnedRows === 1 ? 'row needs' : 'rows need'
      } attention before ${
        warnedRows === 1 ? 'it' : 'they'
      } can be submitted — see below.`,
    );
  }
  if (!report.dryRun) {
    parts.push(
      report.accepted.length === 1
        ? 'The imported row is a draft: it counts towards no total and does not appear in the review queue until it is submitted below.'
        : 'Imported rows are drafts: they count towards no total and do not appear in the review queue until they are submitted below.',
    );
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
export function tonnesLabel(rows: BulkUploadAcceptedRow[]): string {
  const total = totalTonnes(rows);
  if (total === null) return 'No calculated figure';
  const counted = rows.filter((r) => r.tCo2e !== null).length;
  const figure = `${formatNumber(total, 3)} tCO₂e`;
  if (counted === rows.length) return figure;
  const missing = rows.length - counted;
  return `${figure} across ${counted} of ${rowCount(rows.length)}; ${missing} ${
    missing === 1 ? 'has' : 'have'
  } no calculated figure`;
}

/**
 * What the confirm step says before anything is written.
 *
 * Names the count, the tonnage, and the thing a user would otherwise discover
 * afterwards: the rows land as drafts. `draft` is in neither the counted
 * statuses nor the review queue's, so an import moves no total and fills no
 * queue until each row is submitted.
 */
export function applyConfirmation(report: BulkUploadReportDTO): string {
  const count = report.accepted.length;
  const tonnes = tonnesLabel(report.accepted);
  if (count === 1) {
    // "Each becomes its own record … cannot be undone in bulk" is a sentence
    // about many rows; said about one it reads as a warning that does not apply.
    return (
      `Import 1 row (${tonnes}). ` +
      `It arrives as a draft: it is not counted towards any total and does not ` +
      `appear in the review queue until it is submitted.`
    );
  }
  return (
    `Import ${formatNumber(count)} rows (${tonnes}). ` +
    `Each becomes its own record, and this cannot be undone in bulk. ` +
    `They arrive as drafts: they are not counted towards any total and do not ` +
    `appear in the review queue until they are submitted.`
  );
}

/**
 * The toast after a successful apply.
 *
 * It used to end "Submit them for review to count them towards your
 * inventory" — true, and for one release the only way to do it was opening
 * every draft in the form below. The panel now offers the remedy directly, so
 * the sentence points at it.
 */
export function applySuccessMessage(report: BulkUploadReportDTO): string {
  const count = report.accepted.length;
  return count === 1
    ? '1 record imported as a draft. Send it for review below to count it towards your inventory.'
    : `${formatNumber(count)} records imported as drafts. Send them for review below to count them towards your inventory.`;
}

/**
 * The toast after an apply returned — which is not the same thing as "it
 * worked".
 *
 * A 200 can carry zero accepted rows (every row refused at write time — a
 * period locked between the dry run and the apply, say), and the success toast
 * used to fire for it anyway: "0 records imported as drafts".
 */
export function applyToast(report: BulkUploadReportDTO): {
  kind: 'success' | 'warning';
  message: string;
} {
  return report.accepted.length > 0
    ? { kind: 'success', message: applySuccessMessage(report) }
    : { kind: 'warning', message: 'No rows were imported — the report below says why.' };
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
export function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 429) {
      return 'Too many import attempts. Wait a minute and try again — a dry run and an import each count towards the limit.';
    }
    if (error.status === 413) {
      return `That file is over the ${formatNumber(
        BULK_UPLOAD_MAX_SIZE_BYTES / 1024 / 1024,
      )} MB limit. Split it and upload the parts.`;
    }
    if (error.status === 403) {
      return 'Your role cannot import activity records.';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'The import failed.';
}

/**
 * The sentence for a failed template download.
 *
 * It used to borrow `uploadErrorMessage`, whose 429 blames "import attempts"
 * and dry runs — neither of which a download spends: throttler keys include
 * the handler, so the template route has a budget of its own.
 */
export function templateErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 429) {
      return 'Too many template downloads. Wait a minute and try again.';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'The template could not be downloaded.';
}

