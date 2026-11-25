import { ApiError } from '@/lib/api';
import type { ErrorDescription } from '@/lib/i18n/errors';
import { can, mayAuthorRecords, mayDecideRecord, type RecordApprover } from '@/lib/types';
import type { SubmittingUser } from '@/lib/bulk-submit-view';

export const canSubmitEntry = (
  user: SubmittingUser | null,
  editingId: string | null,
  createdBy: string | null,
): boolean => !!user && mayAuthorRecords(user) && (!editingId || createdBy === user.id);

/** A pending record as the review screen holds it: its author, and who decides
 *  it (`ActivityRecordDTO.approver`, set by the API on a pending record). */
export interface DecidableRecord {
  createdBy: string;
  approver?: RecordApprover | null;
}

/**
 * The review queue is a masterkey's and a super_admin's (`record.decide`); an
 * auditor, a standard user, or a user still loading is shown the gate card.
 */
export const mayUseReviewQueue = (user: SubmittingUser | null): boolean => !!user && can(user.role, 'record.decide');

/**
 * Start review, Return and Approve are offered to the record's approver only
 * (inc26-roles-approval-chain, design Decision 7): `mayDecideRecord` over the
 * `approver` the API stated — a super_admin for a standard user's record in a
 * company with an active super_admin, a masterkey for a super_admin's record
 * and for the fallback, and the author for a masterkey's own record. The API
 * decides it again inside the record's lock; this only decides what is shown.
 */
export const canApproveRecord = (user: SubmittingUser | null, record: DecidableRecord | null): boolean =>
  !!user && !!record && mayDecideRecord(user, record, record.approver ?? null);

/**
 * A decider looking at a record they created and may not decide — a
 * super_admin's own record, which a masterkey decides: Approve is withheld and
 * the screen says why. Never a masterkey's own record (theirs to decide, as a
 * self-approval), and never a role that does not decide at all.
 */
export const isOwnRecordForApprover = (user: SubmittingUser | null, record: DecidableRecord | null): boolean =>
  !!user &&
  !!record &&
  can(user.role, 'record.decide') &&
  record.createdBy === user.id &&
  !canApproveRecord(user, record);

/**
 * A masterkey deciding their own record: the approval is written as
 * `self_approve` and shown to the auditor, which the screen says beside
 * Approve before it is pressed.
 */
export const isSelfApproval = (user: SubmittingUser | null, record: DecidableRecord | null): boolean =>
  !!record && record.approver === 'author' && canApproveRecord(user, record);

/**
 * Who a pending record waits for, when it is not this user: the label "awaits
 * Super Admin / Masterkey / its author" in the queue's "every pending record"
 * view. Null when the user decides it, or when the record states no approver
 * (not pending).
 */
export const awaitedApprover = (user: SubmittingUser | null, record: DecidableRecord | null): RecordApprover | null =>
  !record || !record.approver || canApproveRecord(user, record) ? null : record.approver;

/**
 * Does opening this record in the review queue take it into review (WP5,
 * INC-2.6 §1.2)? Only a `submitted` record, and only for the user who decides
 * it: anyone else — its super_admin author, a masterkey whose decision it is
 * not, a colleague super_admin — opens it without changing it, so its
 * author's recall stays open. Built on `canApproveRecord`, so it follows the
 * record's `approver`.
 */
export const shouldStartReviewOnOpen = (
  user: SubmittingUser | null,
  record: (DecidableRecord & { status: string }) | null,
): boolean => !!record && record.status === 'submitted' && canApproveRecord(user, record);

/**
 * A record sent for review more than once — recalled or returned, then
 * submitted again (WP5). The queue marks it "Revised"; what changed is shown
 * only in the record's history.
 */
export const isRevised = (record: { submissionCount: number } | null): boolean =>
  !!record && record.submissionCount >= 2;

/**
 * Does `shown` hold a later version of the record than `answer`? By its
 * version (`updatedAt`, which every write to the row bumps), then by its
 * submission count, so a late answer never replaces a newer read.
 */
export const isNewerRecord = (
  shown: { updatedAt: string; submissionCount: number },
  answer: { updatedAt: string; submissionCount: number },
): boolean =>
  Date.parse(shown.updatedAt) > Date.parse(answer.updatedAt) || shown.submissionCount > answer.submissionCount;

/**
 * A queue page as read, keeping any row the screen already holds in a later
 * version: the page decides which records are listed and in what order, never
 * that a record goes back to an earlier state.
 */
export function keepNewerRows<T extends { id: string; updatedAt: string; submissionCount: number }>(
  shown: readonly T[],
  page: readonly T[],
): T[] {
  const byId = new Map(shown.map((r) => [r.id, r]));
  return page.map((item) => {
    const held = byId.get(item.id);
    return held && isNewerRecord(held, item) ? held : item;
  });
}

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
