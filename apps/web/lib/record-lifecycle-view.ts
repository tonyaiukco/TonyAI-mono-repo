import { ApiError } from '@/lib/api';
import type { ErrorDescription } from '@/lib/i18n/errors';
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
