import { ApiError } from '@/lib/api';
import { mayAuthorRecords } from '@/lib/types';
import type { SubmittingUser } from '@/lib/bulk-submit-view';

export const canSubmitEntry = (
  user: SubmittingUser | null,
  editingId: string | null,
  createdBy: string | null,
): boolean => !!user && mayAuthorRecords(user) && (!editingId || createdBy === user.id);

export const canApproveRecord = (
  user: SubmittingUser | null,
  record: { createdBy: string } | null,
): boolean => !!user && !!record && user.role === 'super_admin' && record.createdBy !== user.id;

/** Only a duplicate conflict is fixed by opening the existing record. */
export function saveErrorMessage(error: unknown, moving = false): string {
  if (error instanceof ApiError && error.status === 409 && /already exists/i.test(error.message)) {
    return moving
      ? `${error.message} The record has not been moved, and stays where it is.`
      : `${error.message} Open it from Previous submissions to continue it.`;
  }
  if (error instanceof ApiError && error.status >= 500) {
    return 'Could not save — the server failed to process this record. Try again, and report it if it persists.';
  }
  return (error as Error).message;
}
