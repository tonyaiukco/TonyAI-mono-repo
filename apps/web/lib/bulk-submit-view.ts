import {
  acceptsBulkSubmit,
  BULK_SUBMIT_MAX_IDS,
  isSubmittable,
  needsEvidenceBeforeSubmit,
  mayAuthorRecords,
} from '@/lib/types';
import type {
  ActivityRecordPageItemDTO,
  AuthUser,
  BulkSubmitIssue,
  BulkSubmitIssueCode,
  BulkSubmitReportDTO,
  BulkUploadAcceptedRow,
  Locale,
} from '@/lib/types';
import { ApiError } from '@/lib/api';
import { formatNumber } from '@/lib/i18n/number';
import type { ViewCopy } from '@/lib/i18n/view-translator';
import type { ErrorDescription } from '@/lib/i18n/errors';
import type { RecordWords } from '@/lib/vocabulary';

/**
 * The client half of bulk submit: which imported rows can even be sent, what
 * the outcome means, and what the screen says about it.
 *
 * Here rather than in the panel for the reason `bulk-upload-view.ts` gives:
 * `vitest.config.ts` collects only `lib/**`, so a sentence decided in a
 * component has no coverage in either direction.
 */

export { BULK_SUBMIT_MAX_IDS, needsEvidenceBeforeSubmit } from '@/lib/types';

/** The `bulkSubmit` catalogue keys this module words its sentences with. */
export type BulkSubmitKey =
  | 'blockedOne'
  | 'blockedMany'
  | 'confirmOne'
  | 'confirmMany'
  | 'refusedHeadline'
  | 'refusedOne'
  | 'refusedMany'
  | 'refusedNone'
  | 'cleanOne'
  | 'cleanMany'
  | 'partialHeadline'
  | 'partialOne'
  | 'partialMany'
  | 'rateLimited'
  | 'roleForbidden'
  | 'failed'
  | 'block.role'
  | 'block.rejected'
  | 'block.already'
  | 'block.notAuthor'
  | 'block.locked'
  | 'block.evidence'
  | 'capRefused'
  | 'selectedFirst'
  | 'sendOne'
  | 'sendMany';

export type BulkSubmitCopy = ViewCopy<BulkSubmitKey>;

/** What `submitErrorMessage` falls back to: the error described in the
 *  user's language (`useDescribeError`). */
/** An error as a screen shows it: a sentence, and — for a generic code in
 *  Turkish — the server's English beneath it (K5), which a toast's
 *  description carries. */
export type ErrorWords = ErrorDescription;

export type DescribeError = (error: unknown) => ErrorDescription;

export type SubmitIssueTranslator = (key: `bulkIssues.${BulkSubmitIssueCode}` | 'codes.calculation_stale') => string;

export function submitIssueLabel(code: BulkSubmitIssueCode, translate: SubmitIssueTranslator): string {
  return translate(`bulkIssues.${code}`);
}

export function submitIssueMessage(issue: BulkSubmitIssue, translate: SubmitIssueTranslator): string | null {
  if (issue.code === 'not_processed_deadline') return null;
  return issue.code === 'calculation_stale' ? translate('codes.calculation_stale') : issue.message;
}

export interface SubmitEligibility {
  /** Record ids worth sending. */
  recordIds: string[];
  /** How many were held back because their category needs an evidence file. */
  needingEvidence: number;
  /**
   * How many eligible records did NOT fit in one request.
   *
   * Unreachable while the import's row cap and the submit's id cap are the
   * same number — but they are deliberately not aliases and may be raised
   * independently, and the day the import's goes first, silently dropping the
   * overflow would show "Send 1,000 records for review" after a 1,010-row
   * import and leave ten as drafts with nothing said.
   */
  overCap: number;
  /** Why the button is not offered, when it is not. `null` when it is. */
  blockedReason: string | null;
}

/**
 * Which of the rows just imported can be sent for review.
 *
 * Evidence-required categories are held back rather than sent and refused: the
 * server would reject every one of them, and a report that is entirely
 * `evidence_required` teaches a user nothing they were not already warned
 * about during the import. **On the seeded demo data this holds back
 * everything** — the factor library covers only Electricity, Natural Gas and
 * Fuel, all three of which require evidence, so the set of rows that can be
 * imported and the set that can be bulk-submitted are disjoint. That is a
 * property of the seeded factor library, not of this code, and the copy says
 * so rather than presenting an empty result as a failure.
 *
 * The anomaly cases are NOT pre-excluded: the row type carries `anomalous` but
 * not `varianceReason`, so a row flagged at import may well have an
 * explanation. Those go to the server and come back per record — which is what
 * the failure report is for.
 */
export function eligibleForSubmit(
  rows: BulkUploadAcceptedRow[],
  { t, locale }: BulkSubmitCopy,
): SubmitEligibility {
  const withIds = rows.filter(
    (r): r is BulkUploadAcceptedRow & { recordId: string } => r.recordId !== null,
  );
  // `evidenceCount: 0` is not an assumption — an import cannot attach a file,
  // so a row this function has just been handed provably has none. Stated as a
  // literal rather than left implicit in a category-only check, because the
  // rule now has a second caller whose rows may carry files.
  const needsEvidence = (r: BulkUploadAcceptedRow) =>
    needsEvidenceBeforeSubmit({ category: r.category, evidenceCount: 0 });
  const needingEvidence = withIds.filter(needsEvidence).length;
  const submittable = withIds
    .filter((r) => !needsEvidence(r))
    .map((r) => r.recordId);
  // From the FRONT: the caller's order is the import's order, and a tail slice
  // would silently prefer the end of the file.
  const recordIds = submittable.slice(0, BULK_SUBMIT_MAX_IDS);
  const overCap = submittable.length - recordIds.length;

  let blockedReason: string | null = null;
  if (withIds.length === 0) {
    blockedReason = null;
  } else if (recordIds.length === 0) {
    // Never "All 1 imported record needs … Open each record below", which is
    // what a one-row import used to read. Both sentences are pinned verbatim
    // in this module's spec, which is now the only place they are: the e2e
    // that repeated them through a browser asserts the gate they name.
    blockedReason =
      needingEvidence === 1
        ? t('blockedOne')
        : t('blockedMany', { count: formatNumber(needingEvidence, locale) });
  }

  return { recordIds, needingEvidence, overCap, blockedReason };
}

/**
 * How many of the failures the panel shows before folding the rest away.
 *
 * The same number the import's issue groups use, and for the same reason: a
 * list of several hundred is not something a user scrolls.
 */
export const MAX_FAILURES_SHOWN = 50;

/** The failures to render, and how many were left out. */
export function failuresToShow(failed: BulkSubmitIssue[]): {
  shown: BulkSubmitIssue[];
  remainder: number;
} {
  return {
    shown: failed.slice(0, MAX_FAILURES_SHOWN),
    // The list used to truncate at fifty with no remainder, under a verdict
    // reading "900 records were not — see below". The screen contradicted
    // itself and 850 records vanished from the user's work list.
    remainder: Math.max(0, failed.length - MAX_FAILURES_SHOWN),
  };
}

/** What the confirm step says. */
export function submitConfirmation(n: number, { t, locale }: BulkSubmitCopy): string {
  return n === 1 ? t('confirmOne') : t('confirmMany', { count: formatNumber(n, locale) });
}

export interface SubmitSummary {
  tone: 'clean' | 'partial' | 'refused';
  headline: string;
  detail: string | null;
}

/** The verdict after a bulk submit. */
export type DeadlineTranslator = (key: 'bulkDeadline.title' | 'bulkDeadline.detail' | 'bulkDeadline.previewDetail',
  values?: { accepted: string; refused: string; unstarted: string }) => string;

export function deadlineSummary(accepted: number, issues: readonly { code: string }[], translate: DeadlineTranslator, locale: Locale, dryRun = false) {
  const unstarted = issues.filter((i) => i.code === 'not_processed_deadline').length;
  if (!unstarted) return null;
  // Counts written in the user's language before they are passed (a simple
  // argument prints a number ungrouped).
  const count = (n: number) => formatNumber(n, locale);
  const values = { accepted: count(accepted), refused: count(issues.length - unstarted), unstarted: count(unstarted) };
  const detailKey = dryRun ? 'previewDetail' : 'detail';
  const detail = translate(`bulkDeadline.${detailKey}`, values);
  return { tone: 'partial' as const, headline: translate('bulkDeadline.title'), detail };
}

export function summariseSubmit(report: BulkSubmitReportDTO, translate: DeadlineTranslator, { t, locale }: BulkSubmitCopy): SubmitSummary {
  const deadline = deadlineSummary(report.submitted.length, report.failed, translate, locale);
  if (deadline) return deadline;
  const moved = report.submitted.length;
  const failed = report.failed.length;

  if (moved === 0) {
    return {
      tone: 'refused',
      headline: t('refusedHeadline'),
      detail:
        failed === 1
          ? t('refusedOne')
          : failed > 1
            ? t('refusedMany', { count: formatNumber(failed, locale) })
            : t('refusedNone'),
    };
  }
  if (failed === 0) {
    return {
      tone: 'clean',
      headline: moved === 1 ? t('cleanOne', { count: formatNumber(moved, locale) }) : t('cleanMany', { count: formatNumber(moved, locale) }),
      detail: null,
    };
  }
  return {
    tone: 'partial',
    headline: t('partialHeadline', { moved: formatNumber(moved, locale), requested: formatNumber(report.requested, locale) }),
    detail: failed === 1 ? t('partialOne', { count: formatNumber(failed, locale) }) : t('partialMany', { count: formatNumber(failed, locale) }),
  };
}

/** The sentence for a failure that refused the whole request. */
export function submitErrorMessage(error: unknown, { t }: BulkSubmitCopy, describe: DescribeError): ErrorWords {
  if (error instanceof ApiError) {
    if (error.status === 429) return { title: t('rateLimited') };
    if (error.status === 403) return { title: t('roleForbidden') };
  }
  if (!(error instanceof Error)) return { title: t('failed') };
  return describe(error);
}

// ---------------------------------------------------------------------------
// Drafts that did not come from an import (WP8 PR 2c).
//
// The same endpoint, a different source list: the records already on screen
// under "Previous submissions" rather than the ones an import just wrote. That
// makes three things the import surface never had to decide — a record here may
// be someone else's, may already have moved on, and may carry evidence — so the
// client mirrors the gates the server applies and offers a checkbox only where
// all of them pass.
//
// The evidence rule itself is NOT here: it is `needsEvidenceBeforeSubmit` in
// the contract, so that this gate and the one in `ActivityRecordsService.submit`
// cannot drift. Re-exported above, because that is where this module's callers
// already look for it.
// ---------------------------------------------------------------------------

/**
 * The fields of a record this module reads.
 *
 * `Pick` of the contract, not a hand-written shape: restating them widened
 * `status`, `category` and `reportingPeriod` to `string`. `periodLocked` is the
 * page item's (LP4-05 PR C): the server's answer for the record's own period,
 * read with the page — never inferred from a page of locks, whose absence
 * proves nothing.
 */
export type SubmittableRow = Pick<
  ActivityRecordPageItemDTO,
  | 'id'
  | 'status'
  | 'category'
  | 'evidenceCount'
  | 'createdBy'
  | 'subsidiaryId'
  | 'reportingYear'
  | 'reportingPeriod'
  | 'periodValue'
  | 'periodLocked'
>;

/** Who is asking. `null` while `api.me()` is still in flight. */
export type SubmittingUser = Pick<AuthUser, 'id' | 'role'>;

/** Only the author may submit, including when the caller is a super_admin. */
export function authoredBy(row: SubmittableRow, user: SubmittingUser): boolean {
  return row.createdBy === user.id;
}

/**
 * Why this record has no checkbox, or `null` when it has one.
 *
 * The order is the server's order — role, then status, then authorship, then
 * the two gates `submit` itself applies — so the sentence a user reads is the
 * refusal they would have been handed had the checkbox been offered anyway.
 * Mirroring rather than inventing is the whole point: a client rule the server
 * does not share is how a checkbox starts promising something that comes back
 * refused.
 *
 * What is deliberately NOT mirrored is the anomaly gate. `anomalyFlag` on the
 * record is the verdict from when it was written, `submit` recomputes it, and
 * a bulk submit shifts its own baseline as it goes — `submitted` counts, so
 * record N entering review changes the baseline record N+1 is measured
 * against. A client gate built on the stored flag would hide records that are
 * perfectly submittable and still let `variance_reason_required` through. That
 * one belongs in the failure report, where the server's own sentence explains
 * it.
 */
export function submitBlockReason(
  row: SubmittableRow,
  user: SubmittingUser,
  { t }: BulkSubmitCopy,
  /** The status and period words of the user's language. */
  words: RecordWords,
): string | null {
  if (!mayAuthorRecords(user)) return t('block.role');
  if (!acceptsBulkSubmit(row.status)) {
    return row.status === 'rejected'
      ? t('block.rejected')
      : t('block.already', { status: words.status(row.status) });
  }
  if (!authoredBy(row, user)) return t('block.notAuthor');
  if (row.periodLocked) {
    return t('block.locked', { period: words.period(row.periodValue), year: row.reportingYear });
  }
  if (needsEvidenceBeforeSubmit(row)) return t('block.evidence');
  return null;
}

export interface DraftSelection {
  /** Ids that may be ticked, in the order they were given. */
  selectableIds: string[];
  /**
   * Why a row has no checkbox — but only for the rows that LOOK selectable.
   *
   * The list already shows a status badge, so spelling out "Already approved."
   * beside an Approved badge is noise on every row of a long list. The rows
   * that owe an explanation are the ones the list itself presents as editable
   * (`SUBMITTABLE_STATUSES`, which is `draft` and `rejected`) and yet cannot be
   * ticked. Everything else is already answered on screen.
   */
  reasonById: Record<string, string>;
}

/** Which of these records this user may send, and why not for the rest. */
export function selectableDrafts(
  rows: SubmittableRow[],
  user: SubmittingUser | null,
  copy: BulkSubmitCopy,
  words: RecordWords,
): DraftSelection {
  // No user, no checkboxes. `loadRecord` is deliberately permissive while
  // `api.me()` is in flight — it would rather open a record than block one —
  // but offering a checkbox and then retracting it is the opposite trade, so
  // this one waits.
  if (!user) return { selectableIds: [], reasonById: {} };

  const selectableIds: string[] = [];
  const reasonById: Record<string, string> = {};
  for (const row of rows) {
    const reason = submitBlockReason(row, user, copy, words);
    if (reason === null) {
      selectableIds.push(row.id);
    } else if (isSubmittable(row.status)) {
      reasonById[row.id] = reason;
    }
  }
  return { selectableIds, reasonById };
}

/**
 * Tick or untick one id.
 *
 * Refuses to grow past the cap rather than letting the request 400: the id list
 * is validated by `@ArrayMaxSize` server-side, and a silent rejection of the
 * whole batch is a worse answer than a checkbox that will not tick.
 */
export function toggleSelected(
  selected: string[],
  id: string,
): { selected: string[]; refusedByCap: boolean } {
  if (selected.includes(id)) {
    return { selected: selected.filter((s) => s !== id), refusedByCap: false };
  }
  if (selected.length >= BULK_SUBMIT_MAX_IDS) {
    return { selected, refusedByCap: true };
  }
  return { selected: [...selected, id], refusedByCap: false };
}

/**
 * "Select all" — the first `BULK_SUBMIT_MAX_IDS`, and how many were left.
 *
 * From the FRONT, and the leftover is reported rather than dropped, for the
 * same reason the import surface reports `overCap`: a screen that says
 * "Send 1,000 records" after ticking 1,010 has silently abandoned ten.
 */
export function selectAllEligible(selectableIds: string[]): {
  selected: string[];
  overCap: number;
} {
  return {
    selected: selectableIds.slice(0, BULK_SUBMIT_MAX_IDS),
    overCap: Math.max(0, selectableIds.length - BULK_SUBMIT_MAX_IDS),
  };
}

/**
 * Is the master checkbox checked?
 *
 * Against what `select all` can actually take, which is capped. Comparing
 * against the raw count instead left the control permanently unchecked above
 * the cap — and since an unchecked master sends `on = true`, clicking it just
 * re-selected the same thousand and it could never be used to clear.
 */
export function allEligibleSelected(
  selectedCount: number,
  selectableCount: number,
): boolean {
  const takeable = Math.min(selectableCount, BULK_SUBMIT_MAX_IDS);
  return takeable > 0 && selectedCount >= takeable;
}

/**
 * The selection, minus anything that has stopped being selectable.
 *
 * Selection is ids held against a list that refetches under it — a record
 * submitted by this very call, edited in another tab, or moved by a colleague
 * stops being eligible while its id is still ticked. Without this the next
 * submit sends ids the server refuses and the count on the button is a lie.
 * Here rather than inline in the component because it is the guard, not the
 * rendering.
 */
export function liveSelection(
  selected: string[],
  selectableIds: string[],
): string[] {
  return selected.filter((id) => selectableIds.includes(id));
}

/** Told when a tick is refused because the request cannot carry more ids. */
export function capRefusedNotice({ t, locale }: BulkSubmitCopy): string {
  return t('capRefused', { max: formatNumber(BULK_SUBMIT_MAX_IDS, locale) });
}

/** Explain the submission cap when select-all cannot take every eligible row. */
export function selectAllNotices(taken: number, overCap: number, { t, locale }: BulkSubmitCopy): string[] {
  const notices: string[] = [];
  if (overCap > 0) {
    notices.push(t('selectedFirst', { taken: formatNumber(taken, locale), more: formatNumber(overCap, locale) }));
  }
  return notices;
}

/** The label on the bulk bar's button. */
export function draftsSubmitLabel(selectedCount: number, { t, locale }: BulkSubmitCopy): string {
  const count = formatNumber(selectedCount, locale);
  return selectedCount === 1 ? t('sendOne', { count }) : t('sendMany', { count });
}
