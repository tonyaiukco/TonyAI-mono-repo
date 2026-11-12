import { ApiError } from '@/lib/api';
import type { ErrorDescription } from '@/lib/i18n/errors';
import { mayApproveRecords, mayAuthorRecords } from '@/lib/types';
import type { SubmittingUser } from '@/lib/bulk-submit-view';

export const canSubmitEntry = (
  user: SubmittingUser | null,
  editingId: string | null,
  createdBy: string | null,
): boolean => !!user && mayAuthorRecords(user) && (!editingId || createdBy === user.id);

/**
 * Approve is offered to an approver role (`consultant` or `super_admin`, K2 —
 * Decisions 2026-11-12) on a record someone else created (D01). The API
 * enforces both; this only decides what the review screen shows.
 */
export const canApproveRecord = (
  user: SubmittingUser | null,
  record: { createdBy: string } | null,
): boolean => !!user && !!record && mayApproveRecords(user) && record.createdBy !== user.id;

/**
 * An approver looking at a record they created: Approve is withheld (D01) and
 * the screen says why — for a role-changed consultant as for a super_admin.
 */
export const isOwnRecordForApprover = (
  user: SubmittingUser | null,
  record: { createdBy: string } | null,
): boolean => !!user && !!record && mayApproveRecords(user) && record.createdBy === user.id;

type SaveErrorKey = 'duplicateAdvice' | 'duplicateAdviceMoving' | 'saveFailedServer';

/**
 * A failed save or submit on Data Entry, in the user's language.
 *
 * Only a duplicate is fixed by opening the existing record, so only it gets
 * advice — decided by its code, `record_duplicate` (LP3-01). The regex on the
 * sentence it replaced matched any 409 whose text said "already exists", and a
 * reworded sentence would have silently dropped the advice.
 */
export function saveErrorDescription(
  error: unknown,
  moving: boolean,
  describe: (error: unknown) => ErrorDescription,
  t: (key: SaveErrorKey) => string,
): ErrorDescription {
  if (error instanceof ApiError && error.code === 'record_duplicate') {
    const { title } = describe(error);
    return { title: `${title} ${t(moving ? 'duplicateAdviceMoving' : 'duplicateAdvice')}` };
  }
  if (error instanceof ApiError && error.status >= 500) return { title: t('saveFailedServer') };
  return describe(error);
}
