import type {
  ActivityRecordDTO,
  ListActivityRecordsParams,
  ReportingPeriod,
} from './index';

/** LP4-05 PR A publishes these contracts; PR C activates their routes. */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
export const MAX_CURSOR_LENGTH = 2048;
export const ACTIVITY_RECORD_SEARCH_MAX_LENGTH = 200;

export interface CursorPageParams {
  /** Integer in [1, MAX_PAGE_LIMIT]; omitted means DEFAULT_PAGE_LIMIT. */
  limit?: number;
  /** Omit on the first page. Empty, malformed or mismatched cursors are 400
   * validation_failed, as are invalid limits; neither is silently corrected. */
  cursor?: string;
}

/**
 * Live keyset pagination, not a database snapshot. Every response, including
 * an empty page and a parameterless request, has this shape. No exact total
 * is implied. Fetch at most limit + 1 rows to determine nextCursor.
 *
 * Cursors are opaque, versioned and bound to the endpoint, sort and normalized
 * filters. Each request rechecks the caller's current accessible subsidiaries;
 * a cursor never grants access. Server implementations must not load a cursor
 * anchor outside that scope or require the anchor to still exist.
 * Encode the sort-key tuple, not an anchor id requiring a lookup. Acceptance
 * depends only on the cursor and request, never stored data. Carry no tenant
 * or scope identity; filters always come from the request. Bind decoded values
 * as query parameters. review_queue needs an explicit NULL submittedAt branch.
 *
 * Rows whose sort keys and filter membership do not change can be traversed
 * without offset shifts. Inserts, deletions, permission and lifecycle changes
 * are visible on subsequent requests; no cross-request snapshot is promised.
 * Reset the cursor chain on a filter change, refresh, local mutation or a
 * validation_failed response to a stale cursor after deployment.
 */
export interface CursorPage<T> {
  items: T[];
  /** The effective requested page size, even on the last/empty page. */
  limit: number;
  /** null ends the traversal; never an empty string. */
  nextCursor: string | null;
}

/** Validate the envelope only, not the domain DTOs inside items. Clients use
 * this to refuse an old array response rather than silently treating it as a
 * complete page. It also refuses a server response over the published bounds. */
export function isCursorPage(value: unknown): value is CursorPage<unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const page = value as Record<string, unknown>;
  if (!Number.isInteger(page.limit) || (page.limit as number) < 1 ||
      (page.limit as number) > MAX_PAGE_LIMIT) return false;
  if (!Array.isArray(page.items) || page.items.length > (page.limit as number)) return false;
  return page.nextCursor === null || (
    typeof page.nextCursor === 'string' && page.nextCursor.length > 0 &&
    page.nextCursor.length <= MAX_CURSOR_LENGTH && page.items.length > 0
  );
}

export const ACTIVITY_RECORD_SORTS = ['newest', 'review_queue'] as const;
export type ActivityRecordSort = (typeof ACTIVITY_RECORD_SORTS)[number];
export const DEFAULT_ACTIVITY_RECORD_SORT: ActivityRecordSort = 'newest';

/** Separate from the legacy list type: its DTO is exhaustive over its keys.
 * Filters are AND-combined; the status set is OR-combined within that filter. */
export interface ActivityRecordPageFilters extends ListActivityRecordsParams {
  /** Omitted = all sites; null = company-level records (wire: locationId=none).
   * A UUID selects one site, always intersected with tenant access. */
  locationId?: string | null;
  /** Requires period. Canonical value belonging to period. Matching uses the API's existing
   * period canonicalization; an incompatible period/value is validation_failed. */
  periodValue?: string;
  scope?: 1 | 2 | 3;
  /** At most ACTIVITY_RECORD_SEARCH_MAX_LENGTH characters. Case-insensitive
   * literal substring over the displayed subsidiary name (nonempty tradingName
   * or legalName), category, periodValue and varianceReason. Escape %, _ and
   * backslash in SQL LIKE patterns. Empty means no search filter. */
  search?: string;
}

export interface ActivityRecordPageParams extends ActivityRecordPageFilters, CursorPageParams {
  /** newest: createdAt DESC, id DESC (default).
   * review_queue: submittedAt ASC NULLS LAST, id ASC. The caller supplies the
   * pending-status filter; changing sort never silently adds/removes filters. */
  sort?: ActivityRecordSort;
}

/** The lock flag avoids inferring eligibility from an incomplete lock page.
 * It is advisory UI state at read time; every mutation rechecks its locks. */
export interface ActivityRecordPageItemDTO extends ActivityRecordDTO {
  periodLocked: boolean;
}

/** GET /activity-records/metadata with ActivityRecordPageFilters, no cursor.
 * Counts are computed over the full scoped filter, never from one page. A
 * concurrent mutation can make metadata and a page differ; refresh both.
 * Work budgets may refuse query_too_broad, calculated only after authorization
 * within the caller's accessible set; inaccessible filters equal empty sets. */
export interface ActivityRecordListMetadataDTO {
  total: number;
  latestReportingYear: number | null;
}

/** GET /period-locks, createdAt DESC, id DESC. An exact subsidiary/year/period/
 * periodValue query addresses at most one unique lock. Only that exact query
 * (or ActivityRecordPageItemDTO.periodLocked) may establish unlocked state;
 * absence from a general page never does. */
export interface PeriodLockPageParams extends CursorPageParams {
  subsidiaryId?: string;
  year?: number;
  period?: ReportingPeriod;
  periodValue?: string;
}

/** GET /targets, targetYear ASC, createdAt DESC, id DESC. */
export interface TargetPageParams extends CursorPageParams {
  subsidiaryId?: string;
}

/** GET /denominators, year DESC, metric ASC, id ASC. */
export interface DenominatorPageParams extends CursorPageParams {
  subsidiaryId?: string;
  year?: number;
}

/** GET /targets/progress?targetIds=<comma-separated UUIDs>. At most one page
 * of ids, at least one; duplicate ids after UUID case normalization are invalid. Results are tenant-scoped,
 * in request order, omitting missing/inaccessible ids identically. It never
 * loads progress for targets outside this explicit set. */
export interface TargetProgressParams {
  targetIds: readonly string[];
}

export const TARGET_PROGRESS_MAX_IDS = MAX_PAGE_LIMIT;

/** Both import and bulk-submit preserve their existing per-row outcomes.
 * A deadline stops NEW row work; the in-flight mutation settles before the
 * response, counters and audit summary are finalized. No background writes.
 * Every unstarted row/id carries not_processed_deadline, including on a dry
 * run. Missing and inaccessible ids have identical outcomes at every deadline
 * position, including after preflight. Clients never retry the entire batch
 * automatically: successful mutations remain committed. */
export const BULK_OPERATION_COMPLETIONS = ['completed', 'deadline_exceeded'] as const;
export type BulkOperationCompletion = (typeof BULK_OPERATION_COMPLETIONS)[number];
