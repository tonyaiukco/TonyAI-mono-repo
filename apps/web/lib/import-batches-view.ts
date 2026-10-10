import enErrors from '@/messages/en/errors.json';
import type { BulkSubmitReportDTO, ImportBatchDTO } from '@/lib/types';
import { deadlineSummary, type DeadlineTranslator, SUBMIT_ISSUE_LABEL } from '@/lib/bulk-submit-view';
import { ApiError, SESSION_EXPIRED_MESSAGE } from '@/lib/api';
import { formatNumber } from '@/lib/utils';

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

export const BATCH_STATE_LABEL: Record<BatchState, string> = {
  completed: 'Imported',
  failed: 'Stopped',
  processing: 'Importing…',
  interrupted: 'Interrupted',
};

/** `2 imported · 1 refused`, or what an interrupted batch can still say. */
export function batchOutcome(batch: Pick<ImportBatchDTO, 'acceptedCount' | 'rejectedCount' | 'totalRows'>,
  translate: (key: `bulkOutcomes.${keyof typeof enErrors.bulkOutcomes}`, values: { count: number }) => string
    = (key, { count }) => enErrors.bulkOutcomes[key.replace('bulkOutcomes.', '') as keyof typeof enErrors.bulkOutcomes].replace('{count}', formatNumber(count)),
): string {
  if (batch.acceptedCount === null || batch.rejectedCount === null) {
    return translate('bulkOutcomes.unknown', { count: batch.totalRows });
  }
  const parts = [translate('bulkOutcomes.imported', { count: batch.acceptedCount })];
  if (batch.rejectedCount) parts.push(translate('bulkOutcomes.refused', { count: batch.rejectedCount }));
  const unstarted = Math.max(0, batch.totalRows - batch.acceptedCount - batch.rejectedCount);
  if (unstarted) parts.push(translate('bulkOutcomes.notProcessed', { count: unstarted }));
  return parts.join(' · ');
}

/** The button that sends a batch's drafts: absent when there is nothing to send. */
export function batchSubmitLabel(count: number): string | null {
  if (count <= 0) return null;
  return `Send ${formatNumber(count)} ${count === 1 ? 'draft' : 'drafts'} for review`;
}

/** A failed read of the list or a download. */
export function importBatchesErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return SESSION_EXPIRED_MESSAGE;
    if (error.status === 404) return 'That import is no longer available to you.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'Recent imports could not be loaded.';
}

/**
 * Drafts the batch submit will not send because they wait for an evidence
 * file, or `null` when none do. The remedy is on Previous submissions: one
 * record's vault, or one file attached to several of them (WP8 PR7).
 */
export function awaitingEvidenceNote(
  batch: Pick<ImportBatchDTO, 'draftCount' | 'submittableDraftCount'>,
): string | null {
  const waiting = batch.draftCount - batch.submittableDraftCount;
  if (waiting <= 0) return null;
  return waiting === 1
    ? '1 draft needs an evidence file first — open it under Previous submissions to attach one.'
    : `${formatNumber(waiting)} drafts need an evidence file first — under Previous submissions, attach each invoice to the drafts it evidences; one file can cover several.`;
}

/** Why records a batch submit sent were not moved: `Needs an evidence file · 2`, one line per reason. */
export function submitFailureDetail(report: BulkSubmitReportDTO, deadlineLabel = enErrors.bulkIssues.not_processed_deadline, translate?: DeadlineTranslator): string | null {
  const deadline = deadlineSummary(report.submitted.length, report.failed, translate);
  if (deadline) return deadline.detail;
  if (report.failed.length === 0) return null;
  const counts = new Map<string, number>();
  for (const issue of report.failed) {
    const label = issue.code === 'not_processed_deadline' ? deadlineLabel : SUBMIT_ISSUE_LABEL[issue.code] ?? issue.code;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${label} · ${formatNumber(n)}`).join('\n');
}

/**
 * Said whenever the original file is opened: it is kept byte for byte, refused
 * rows included, and a spreadsheet cell can carry a formula (`=HYPERLINK(…)`)
 * a colleague typed — CSV injection reaches whoever opens it in Excel.
 */
export const SOURCE_FILE_CAUTION =
  'Original file, exactly as uploaded. Spreadsheet cells can contain formulas — open it only if you trust its contents.';
