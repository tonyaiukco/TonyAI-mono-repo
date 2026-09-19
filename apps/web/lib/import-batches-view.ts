import type { BulkSubmitReportDTO, ImportBatchDTO } from '@/lib/types';
import { SUBMIT_ISSUE_LABEL } from '@/lib/bulk-submit-view';
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
export function batchOutcome(batch: Pick<ImportBatchDTO, 'acceptedCount' | 'rejectedCount' | 'totalRows'>): string {
  if (batch.acceptedCount === null) {
    return `${formatNumber(batch.totalRows)} ${batch.totalRows === 1 ? 'row' : 'rows'} — outcome not recorded`;
  }
  const parts = [`${formatNumber(batch.acceptedCount)} imported`];
  if (batch.rejectedCount) parts.push(`${formatNumber(batch.rejectedCount)} refused`);
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
 * file, or `null` when none do. The remedy is the vault on each record.
 */
export function awaitingEvidenceNote(
  batch: Pick<ImportBatchDTO, 'draftCount' | 'submittableDraftCount'>,
): string | null {
  const waiting = batch.draftCount - batch.submittableDraftCount;
  if (waiting <= 0) return null;
  return `${formatNumber(waiting)} ${waiting === 1 ? 'draft needs' : 'drafts need'} an evidence file first — open ${waiting === 1 ? 'it' : 'each'} under Previous submissions to attach one.`;
}

/** Why records a batch submit sent were not moved: `Needs an evidence file · 2`, one line per reason. */
export function submitFailureDetail(report: BulkSubmitReportDTO): string | null {
  if (report.failed.length === 0) return null;
  const counts = new Map<string, number>();
  for (const issue of report.failed) {
    const label = SUBMIT_ISSUE_LABEL[issue.code] ?? issue.code;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${label} · ${formatNumber(n)}`).join('\n');
}
