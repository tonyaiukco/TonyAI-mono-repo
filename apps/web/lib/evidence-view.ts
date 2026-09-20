import { EVIDENCE_MAX_LINKED_RECORDS, mayAuthorRecords } from '@/lib/types';
import type {
  ActivityRecordDTO,
  EvidenceDetachDTO,
  EvidenceDTO,
  EvidenceLinkedRecordDTO,
} from '@/lib/types';
import { ApiError, SESSION_EXPIRED_MESSAGE } from '@/lib/api';
import {
  authoredBy,
  isPeriodLockedFor,
  type LockedPeriod,
  type SubmittableRow,
  type SubmittingUser,
} from '@/lib/bulk-submit-view';
import { formatNumber } from '@/lib/utils';

/**
 * The client half of evidence that backs several records (WP8 PR7): which
 * records one upload may cover, what the screen says before and after, and
 * how a file shared with other records is described wherever it appears.
 *
 * Here rather than in the components for the reason `bulk-submit-view.ts`
 * gives: `vitest.config.ts` collects only `lib/**`.
 */

/** Statuses a file can still be attached to — the API's rule, mirrored. */
const EVIDENCE_EDITABLE = new Set<string>(['draft', 'rejected']);

/**
 * Why this record cannot take a file in the "attach one file" selection, or
 * `null` when it can.
 *
 * The evidence API's order — role, authorship, status, period lock — so the
 * sentence matches the refusal the upload would return. (The submit selection
 * checks status before authorship because the submit route does.) Unlike the
 * submit selection, a missing file is not a reason: it is the point.
 */
export function attachBlockReason(
  row: SubmittableRow,
  user: SubmittingUser,
  locks: LockedPeriod[],
): string | null {
  if (!mayAuthorRecords(user)) return 'Your role cannot attach evidence.';
  if (!authoredBy(row, user)) return 'Entered by someone else.';
  if (!EVIDENCE_EDITABLE.has(row.status)) return `Already ${row.status.replace(/_/g, ' ')}.`;
  if (isPeriodLockedFor(row, locks)) return `${row.periodValue} ${row.reportingYear} is locked.`;
  return null;
}

export interface AttachSelection {
  /** Ids that may be ticked, in list order. */
  attachableIds: string[];
  /** Why an editable-looking row (draft or rejected) has no checkbox. */
  reasonById: Record<string, string>;
}

/** The rows of one subsidiary's list that one file could be attached to. */
export function attachableRecords(
  rows: SubmittableRow[],
  user: SubmittingUser | null,
  locks: LockedPeriod[],
): AttachSelection {
  if (!user) return { attachableIds: [], reasonById: {} };
  const attachableIds: string[] = [];
  const reasonById: Record<string, string> = {};
  for (const row of rows) {
    const reason = attachBlockReason(row, user, locks);
    if (reason === null) attachableIds.push(row.id);
    else if (EVIDENCE_EDITABLE.has(row.status)) reasonById[row.id] = reason;
  }
  return { attachableIds, reasonById };
}

/** Tick or untick one id, refusing to grow past what one upload may carry. */
export function toggleAttach(
  selected: string[],
  id: string,
): { selected: string[]; refusedByCap: boolean } {
  if (selected.includes(id)) {
    return { selected: selected.filter((s) => s !== id), refusedByCap: false };
  }
  if (selected.length >= EVIDENCE_MAX_LINKED_RECORDS) {
    return { selected, refusedByCap: true };
  }
  return { selected: [...selected, id], refusedByCap: false };
}

/** How a record is named next to a file — the same words the list shows. */
export function recordLabel(
  r: Pick<EvidenceLinkedRecordDTO, 'category' | 'periodValue' | 'reportingYear' | 'locationName'>,
): string {
  return [r.category, `${r.periodValue} ${r.reportingYear}`, ...(r.locationName ? [r.locationName] : [])].join(' · ');
}

/** The button in the selection bar — disabled, and unnumbered, until a record is ticked. */
export function attachButtonLabel(n: number): string {
  if (n === 0) return 'Attach one file';
  return `Attach one file to ${formatNumber(n)} ${n === 1 ? 'record' : 'records'}`;
}

/**
 * The confirm step. It names every record, because the reviewer will judge
 * whether one document can honestly evidence all of them — and so should the
 * person making the claim, before making it.
 */
export function attachConfirmation(
  fileName: string,
  rows: Pick<ActivityRecordDTO, 'category' | 'periodValue' | 'reportingYear' | 'locationName'>[],
): { lead: string; records: string[] } {
  return {
    lead:
      rows.length === 1
        ? `“${fileName}” will be attached to this record:`
        : `“${fileName}” will be attached, as one file, to these ${formatNumber(rows.length)} records. Reviewers see every record it backs.`,
    records: rows.map((r) => recordLabel({ ...r, locationName: r.locationName ?? null })),
  };
}

/** Said after a successful upload. */
export function attachSuccessMessage(file: Pick<EvidenceDTO, 'fileName' | 'linkedRecords'>): string {
  const n = file.linkedRecords.length;
  return `${file.fileName} now backs ${formatNumber(n)} ${n === 1 ? 'record' : 'records'}.`;
}

/** Said when the upload is refused: the server's sentence names each refused record. */
export function attachErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return SESSION_EXPIRED_MESSAGE;
  if (error instanceof Error) return error.message;
  return 'The file could not be attached.';
}

/**
 * The records OTHER than `recordId` that this file also backs, as one line —
 * or `null` when it backs this record alone. Shown on the file in the vault
 * and in the review panel.
 */
export function sharedWithNote(file: Pick<EvidenceDTO, 'linkedRecords'>, recordId: string): string | null {
  const others = file.linkedRecords.filter((r) => r.id !== recordId);
  if (others.length === 0) return null;
  const SHOWN = 3;
  const named = others.slice(0, SHOWN).map(recordLabel).join('; ');
  const rest = others.length - SHOWN;
  return `Also backs ${formatNumber(others.length)} other ${others.length === 1 ? 'record' : 'records'}: ${named}${rest > 0 ? `; +${formatNumber(rest)} more` : ''}`;
}

/** The remove button's name: taking a shared file off one record is not deleting it. */
export function removeFileLabel(file: Pick<EvidenceDTO, 'linkedRecords'>): string {
  return file.linkedRecords.length > 1 ? 'Remove from this record' : 'Remove';
}

/** Said after a remove: whether the file itself is gone or still backs others. */
export function detachSuccessMessage(
  result: Pick<EvidenceDetachDTO, 'fileDeleted'>,
  file: Pick<EvidenceDTO, 'fileName' | 'linkedRecords'>,
): string {
  if (result.fileDeleted) return 'Evidence removed';
  const others = file.linkedRecords.length - 1;
  return `Removed from this record — ${file.fileName} still backs ${formatNumber(others)} other ${others === 1 ? 'record' : 'records'}.`;
}
