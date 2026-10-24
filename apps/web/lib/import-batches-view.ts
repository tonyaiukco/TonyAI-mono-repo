import type enErrors from '@/messages/en/errors.json';
import type { BulkSubmitReportDTO, ImportBatchDTO, Locale } from '@/lib/types';
import { deadlineSummary, type DeadlineTranslator, submitIssueLabel, type SubmitIssueTranslator } from '@/lib/bulk-submit-view';
import { ApiError } from '@/lib/api';
import { formatNumber } from '@/lib/i18n/number';
import type { ViewCopy } from '@/lib/i18n/view-translator';
import type { DescribeError, ErrorWords } from '@/lib/bulk-submit-view';

/**
 * A batch still `processing` this long after it started is not processing: the
 * request that owned it is gone (the process died mid-import). Its records
 * are still linked to it; the counts were never written.
 */
export const INTERRUPTED_AFTER_MS = 10 * 60 * 1000;

export type BatchState = 'completed' | 'failed' | 'processing' | 'interrupted';

/** What the screen calls a batch's state. */
export function batchState(batch: Pick<ImportBatchDTO, 'status' | 'createdAt'>, now: number): BatchState {
  if (batch.status !== 'processing') return batch.status;
  return now - new Date(batch.createdAt).getTime() > INTERRUPTED_AFTER_MS
    ? 'interrupted'
    : 'processing';
}

/** The `imports` catalogue keys this module words its sentences with. */
export type ImportsKey =
  | `state.${BatchState}`
  | 'sendOne'
  | 'sendMany'
  | 'notAvailable'
  | 'waitingOne'
  | 'waitingMany';

export type ImportsCopy = ViewCopy<ImportsKey>;

/** What the screen calls a batch's state. */
export function batchStateLabel(state: BatchState, { t }: ImportsCopy): string {
  return t(`state.${state}`);
}

/** `2 imported · 1 refused`, or what an interrupted batch can still say. */
export function batchOutcome(batch: Pick<ImportBatchDTO, 'acceptedCount' | 'rejectedCount' | 'totalRows'>,
  // The screen's `errors` translator — no English default (LP4-04 slice 2 follow-up 2).
  translate: (key: `bulkOutcomes.${keyof typeof enErrors.bulkOutcomes}`, values: { count: string }) => string,
  locale: Locale,
): string {
  const count = (n: number) => ({ count: formatNumber(n, locale) });
  if (batch.acceptedCount === null || batch.rejectedCount === null) {
    return translate('bulkOutcomes.unknown', count(batch.totalRows));
  }
  const parts = [translate('bulkOutcomes.imported', count(batch.acceptedCount))];
  if (batch.rejectedCount) parts.push(translate('bulkOutcomes.refused', count(batch.rejectedCount)));
  const unstarted = Math.max(0, batch.totalRows - batch.acceptedCount - batch.rejectedCount);
  if (unstarted) parts.push(translate('bulkOutcomes.notProcessed', count(unstarted)));
  return parts.join(' · ');
}

/** The button that sends a batch's drafts: absent when there is nothing to send. */
export function batchSubmitLabel(count: number, { t, locale }: ImportsCopy): string | null {
  if (count <= 0) return null;
  const n = formatNumber(count, locale);
  return count === 1 ? t('sendOne', { count: n }) : t('sendMany', { count: n });
}

/** A failed read of the list or a download. */
export function importBatchesErrorMessage(error: unknown, { t }: ImportsCopy, describe: DescribeError): ErrorWords {
  if (error instanceof ApiError && error.status === 404) return { title: t('notAvailable') };
  return describe(error);
}

/**
 * Drafts the batch submit will not send because they wait for an evidence
 * file, or `null` when none do. The remedy is on Previous submissions: one
 * record's vault, or one file attached to several of them (WP8 PR7).
 */
export function awaitingEvidenceNote(
  batch: Pick<ImportBatchDTO, 'draftCount' | 'submittableDraftCount'>,
  { t, locale }: ImportsCopy,
): string | null {
  const waiting = batch.draftCount - batch.submittableDraftCount;
  if (waiting <= 0) return null;
  return waiting === 1 ? t('waitingOne') : t('waitingMany', { count: formatNumber(waiting, locale) });
}

/** Why records a batch submit sent were not moved: `Needs an evidence file · 2`, one line per reason. */
export function submitFailureDetail(report: BulkSubmitReportDTO, translate: DeadlineTranslator, translateIssue: SubmitIssueTranslator, locale: Locale): string | null {
  const deadline = deadlineSummary(report.submitted.length, report.failed, translate, locale);
  if (deadline) return deadline.detail;
  if (report.failed.length === 0) return null;
  const counts = new Map<string, number>();
  for (const issue of report.failed) {
    const label = submitIssueLabel(issue.code, translateIssue);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${label} · ${formatNumber(n, locale)}`).join('\n');
}
