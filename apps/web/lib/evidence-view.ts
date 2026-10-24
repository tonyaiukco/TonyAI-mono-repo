import { EVIDENCE_MAX_LINKED_RECORDS, mayAuthorRecords } from '@/lib/types';
import type {
  ActivityRecordDTO,
  CursorPage,
  EvidenceDetachDTO,
  EvidenceDTO,
  EvidenceLinkedRecordDTO,
} from '@/lib/types';
import { api, ApiError } from '@/lib/api';
import {
  authoredBy,
  type DescribeError,
  type ErrorWords,
  type SubmittableRow,
  type SubmittingUser,
} from '@/lib/bulk-submit-view';
import { formatNumber } from '@/lib/i18n/number';
import type { ViewCopy } from '@/lib/i18n/view-translator';
import type { RecordWords } from '@/lib/vocabulary';

/** The `evidence` catalogue keys this module words its sentences with. */
export type EvidenceKey =
  | 'block.role'
  | 'block.notAuthor'
  | 'block.already'
  | 'block.locked'
  | 'attachNone'
  | 'attachOne'
  | 'attachMany'
  | 'confirmOne'
  | 'confirmMany'
  | 'successOne'
  | 'successMany'
  | 'attachFailed'
  | 'sharedOne'
  | 'sharedMany'
  | 'sharedMore'
  | 'remove'
  | 'removeFromThis'
  | 'detached'
  | 'detachedStillOne'
  | 'detachedStillMany';

/** The module's copy, and the words a record's values are shown by. */
export interface EvidenceCopy extends ViewCopy<EvidenceKey> {
  words: RecordWords;
}

/**
 * The client half of evidence that backs several records (WP8 PR7): which
 * records one upload may cover, what the screen says before and after, and
 * how a file shared with other records is described wherever it appears.
 *
 * Here rather than in the components for the reason `bulk-submit-view.ts`
 * gives: `vitest.config.ts` collects only `lib/**`.
 */

/**
 * The page size that always fits the API's per-page evidence-link budget:
 * each file backs at most EVIDENCE_MAX_LINKED_RECORDS records, and a page may
 * carry 10,000 links (`REPORT_EVIDENCE_LINK_LIMIT`'s default).
 */
export const EVIDENCE_FALLBACK_PAGE = Math.max(1, Math.floor(10_000 / EVIDENCE_MAX_LINKED_RECORDS));

/**
 * One page of a record's files. A page of widely shared files can exceed the
 * per-page link budget (422 `query_too_broad`); it is asked for again at the
 * size that always fits, so the files stay readable (`security-rls` P3-2).
 */
export async function readEvidencePage(recordId: string, cursor?: string): Promise<CursorPage<EvidenceDTO>> {
  const after = cursor ? { cursor } : {};
  try {
    return await api.listEvidencePage(recordId, after);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'query_too_broad') {
      return api.listEvidencePage(recordId, { ...after, limit: EVIDENCE_FALLBACK_PAGE });
    }
    throw e;
  }
}

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
  { t, words }: EvidenceCopy,
): string | null {
  if (!mayAuthorRecords(user)) return t('block.role');
  if (user.role !== 'super_admin' && !authoredBy(row, user)) return t('block.notAuthor');
  if (!EVIDENCE_EDITABLE.has(row.status)) return t('block.already', { status: words.status(row.status) });
  if (row.periodLocked) return t('block.locked', { period: words.period(row.periodValue), year: row.reportingYear });
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
  copy: EvidenceCopy,
): AttachSelection {
  if (!user) return { attachableIds: [], reasonById: {} };
  const attachableIds: string[] = [];
  const reasonById: Record<string, string> = {};
  for (const row of rows) {
    const reason = attachBlockReason(row, user, copy);
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
  words: RecordWords,
): string {
  return [
    words.category(r.category),
    `${words.period(r.periodValue)} ${r.reportingYear}`,
    ...(r.locationName ? [r.locationName] : []),
  ].join(' · ');
}

/** The button in the selection bar — disabled, and unnumbered, until a record is ticked. */
export function attachButtonLabel(n: number, { t, locale }: EvidenceCopy): string {
  if (n === 0) return t('attachNone');
  const count = formatNumber(n, locale);
  return n === 1 ? t('attachOne', { count }) : t('attachMany', { count });
}

/**
 * The confirm step. It names every record, because the reviewer will judge
 * whether one document can honestly evidence all of them — and so should the
 * person making the claim, before making it.
 */
export function attachConfirmation(
  fileName: string,
  rows: Pick<ActivityRecordDTO, 'category' | 'periodValue' | 'reportingYear' | 'locationName'>[],
  { t, locale, words }: EvidenceCopy,
): { lead: string; records: string[] } {
  return {
    lead:
      rows.length === 1
        ? t('confirmOne', { fileName })
        : t('confirmMany', { fileName, count: formatNumber(rows.length, locale) }),
    records: rows.map((r) => recordLabel({ ...r, locationName: r.locationName ?? null }, words)),
  };
}

/** Said after a successful upload. */
export function attachSuccessMessage(file: Pick<EvidenceDTO, 'fileName' | 'linkedRecords'>, { t, locale }: EvidenceCopy): string {
  const n = file.linkedRecords.length;
  const values = { fileName: file.fileName, count: formatNumber(n, locale) };
  return n === 1 ? t('successOne', values) : t('successMany', values);
}

/** Said when the upload is refused: the server's sentence names each refused record. */
export function attachErrorMessage(error: unknown, { t }: EvidenceCopy, describe: DescribeError): ErrorWords {
  if (error instanceof Error) return describe(error);
  return { title: t('attachFailed') };
}

/**
 * The records OTHER than `recordId` that this file also backs, as one line —
 * or `null` when it backs this record alone. Shown on the file in the vault
 * and in the review panel.
 */
export function sharedWithNote(file: Pick<EvidenceDTO, 'linkedRecords'>, recordId: string, { t, locale, words }: EvidenceCopy): string | null {
  const others = file.linkedRecords.filter((r) => r.id !== recordId);
  if (others.length === 0) return null;
  const SHOWN = 3;
  const rest = others.length - SHOWN;
  const named =
    others.slice(0, SHOWN).map((r) => recordLabel(r, words)).join('; ') +
    (rest > 0 ? t('sharedMore', { count: formatNumber(rest, locale) }) : '');
  const count = formatNumber(others.length, locale);
  return others.length === 1 ? t('sharedOne', { count, named }) : t('sharedMany', { count, named });
}

/** The remove button's name: taking a shared file off one record is not deleting it. */
export function removeFileLabel(file: Pick<EvidenceDTO, 'linkedRecords'>, { t }: EvidenceCopy): string {
  return file.linkedRecords.length > 1 ? t('removeFromThis') : t('remove');
}

/** Said after a remove: whether the file itself is gone or still backs others. */
export function detachSuccessMessage(
  result: Pick<EvidenceDetachDTO, 'fileDeleted'>,
  file: Pick<EvidenceDTO, 'fileName' | 'linkedRecords'>,
  { t, locale }: EvidenceCopy,
): string {
  if (result.fileDeleted) return t('detached');
  const others = file.linkedRecords.length - 1;
  const values = { fileName: file.fileName, count: formatNumber(others, locale) };
  return others === 1 ? t('detachedStillOne', values) : t('detachedStillMany', values);
}
