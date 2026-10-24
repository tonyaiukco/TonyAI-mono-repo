import type { Prisma } from '@tonyai/db';
import {
  canonicalPeriodValue,
  type ActivityRecordPageFilters,
  type ActivityRecordSort,
  type ActivityRecordStatus,
  type Category,
  type ReportingPeriod,
} from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import type { KeysetSort } from '../common/keyset-cursor';
import { scopedSubsidiaryIds } from '../common/page-filters';

/** The two orders of GET /activity-records — each ends on the id, so ties never reorder between pages. */
export const RECORD_SORTS: Record<ActivityRecordSort, KeysetSort> = {
  newest: {
    endpoint: 'activity-records',
    table: 'activity_records',
    name: 'newest',
    keys: [
      { field: 'createdAt', kind: 'timestamp3', direction: 'desc' },
      { field: 'id', kind: 'uuid', direction: 'desc' },
    ],
  },
  // Longest wait first; a record never submitted (a draft the caller asked
  // for) has no wait and comes last, ordered among its kind by id.
  review_queue: {
    endpoint: 'activity-records',
    table: 'activity_records',
    name: 'review_queue',
    keys: [
      { field: 'submittedAt', kind: 'timestamp3', direction: 'asc', nullsLast: true },
      { field: 'id', kind: 'uuid', direction: 'asc' },
    ],
  },
};

/** The filters in one spelling, so two spellings of one request page — and bind a cursor — alike. */
export interface RecordFilters {
  subsidiaryId?: string;
  year?: number;
  period?: ReportingPeriod;
  periodValue?: string;
  category?: Category;
  status?: ActivityRecordStatus[];
  /** undefined = every site; null = company-level; an id = that site. */
  locationId?: string | null;
  scope?: 1 | 2 | 3;
  search?: string;
}

export function normaliseRecordFilters(query: ActivityRecordPageFilters): RecordFilters {
  const periodValue =
    query.periodValue !== undefined && query.period !== undefined
      ? (canonicalPeriodValue(query.period, query.periodValue) ?? undefined)
      : undefined;
  return {
    subsidiaryId: query.subsidiaryId,
    year: query.year,
    period: query.period,
    periodValue,
    category: query.category,
    status: query.status ? [...new Set(query.status)].sort() : undefined,
    locationId: query.locationId,
    scope: query.scope,
    search: query.search ? query.search : undefined,
  };
}

/**
 * `value` as a literal inside an ILIKE pattern. Prisma's `contains` passes `%`,
 * `_` and `\` through as pattern syntax (measured on 6.19: `contains: '%'`
 * matched every row), so they are escaped with PostgreSQL's default escape
 * character, the backslash — itself first.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Search: a case-insensitive literal substring of the subsidiary's DISPLAYED
 * name (its trading name when that is not empty, otherwise its legal name),
 * the category, the period value or the variance reason.
 */
function searchWhere(search: string): Prisma.ActivityRecordWhereInput[] {
  const contains = { contains: escapeLike(search), mode: 'insensitive' as const };
  return [
    { category: contains },
    { periodValue: contains },
    { varianceReason: contains },
    // A trading name that contains a nonempty term is itself nonempty, so it is the displayed name.
    { subsidiary: { tradingName: contains } },
    { subsidiary: { OR: [{ tradingName: null }, { tradingName: '' }], legalName: contains } },
  ];
}

/**
 * The `where` of the filtered set inside the caller's CURRENT access, or null
 * when that intersection is empty — a subsidiary the caller cannot see is an
 * empty set, answered exactly like one that holds no records.
 */
export function recordFilterWhere(user: RequestUser, f: RecordFilters): Prisma.ActivityRecordWhereInput | null {
  const subsidiaryIds = scopedSubsidiaryIds(user, f.subsidiaryId);
  if (subsidiaryIds.length === 0) return null;
  return {
    subsidiaryId: { in: subsidiaryIds },
    ...(f.year !== undefined ? { reportingYear: f.year } : {}),
    ...(f.period !== undefined ? { reportingPeriod: f.period } : {}),
    ...(f.periodValue !== undefined ? { periodValue: f.periodValue } : {}),
    ...(f.category !== undefined ? { category: f.category } : {}),
    ...(f.status !== undefined ? { status: { in: f.status } } : {}),
    ...(f.locationId !== undefined ? { locationId: f.locationId } : {}),
    ...(f.scope !== undefined ? { scope: f.scope } : {}),
    ...(f.search !== undefined ? { OR: searchWhere(f.search) } : {}),
  };
}
