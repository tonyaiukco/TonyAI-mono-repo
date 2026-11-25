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

/**
 * Does opening this record in the review queue take it into review (WP5,
 * INC-2.6 §1.2)? Only a `submitted` record, and only for a user who may
 * approve it: the record's author (D01) opens it without changing it, so
 * their recall stays open. Built on `canApproveRecord`, so it follows who may
 * approve when the approval chain changes that.
 */
export const shouldStartReviewOnOpen = (
  user: SubmittingUser | null,
  record: { createdBy: string; status: string } | null,
): boolean => !!record && record.status === 'submitted' && canApproveRecord(user, record);

/**
 * A record sent for review more than once — recalled or returned, then
 * submitted again (WP5). The queue marks it "Revised"; what changed is shown
 * only in the record's history.
 */
export const isRevised = (record: { submissionCount: number } | null): boolean =>
  !!record && record.submissionCount >= 2;

type SaveErrorKey = 'duplicateAdvice' | 'duplicateAdviceMoving' | 'saveFailedServer' | 'recordChanged';

/**
 * A failed save or submit on Data Entry, in the user's language.
 *
 * Only a duplicate is fixed by opening the existing record, so only it gets
 * advice — decided by its code, `record_duplicate` (LP3-01). The regex on the
 * sentence it replaced matched any 409 whose text said "already exists", and a
 * reworded sentence would have silently dropped the advice.
 *
 * A save refused as `record_changed` gets Data Entry's own sentence
 * (self-gen-form, design 10): the edit named an older version, so the record
 * changed after the form opened it, not while the request ran, and the form
 * then reads it again, dropping what was typed. The catalogue's generic
 * sentence describes the race the other screens meet.
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
  if (error instanceof ApiError && error.code === 'record_changed') return { title: t('recordChanged') };
  if (error instanceof ApiError && error.status >= 500) return { title: t('saveFailedServer') };
  return describe(error);
}
