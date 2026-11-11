/**
 * The records table under the Data Entry form (UAT round 2, BUG-R2-05): which
 * records it asks the API for, and what a row's evidence cell says.
 *
 * Filters are applied by the API, never to the loaded page, so every page —
 * the first and each Load more — honours them (LP4-05's contract: no client
 * filtering of a partial list).
 */
import { isEvidenceRequired } from "@/lib/types";
import type { ActivityRecordPageFilters, ActivityRecordStatus, Category } from "@/lib/types";

export type YearFilter = number | "all";

/**
 * What the user picked in the table's filters, for one subsidiary. Until the
 * user picks a year, the year shown follows the form's reporting year
 * (`yearPinned` false); after it, the pick stays. Another subsidiary starts
 * from scratch.
 */
export interface RecordsFilterState {
  subsidiaryId: string;
  yearPinned: boolean;
  year: YearFilter;
  status: ActivityRecordStatus | "all";
  category: Category | "all";
}

/** The filters as the table shows and sends them. */
export interface RecordsFilter {
  year: YearFilter;
  status: ActivityRecordStatus | "all";
  category: Category | "all";
}

export function blankRecordsFilter(subsidiaryId: string): RecordsFilterState {
  return { subsidiaryId, yearPinned: false, year: "all", status: "all", category: "all" };
}

/**
 * The filters in force: a state saved for another subsidiary counts as none,
 * and an unpinned year is the form's.
 */
export function resolveRecordsFilter(
  state: RecordsFilterState,
  subsidiaryId: string,
  formYear: number,
): RecordsFilter {
  const own = state.subsidiaryId === subsidiaryId ? state : blankRecordsFilter(subsidiaryId);
  return {
    year: own.yearPinned ? own.year : formYear,
    status: own.status,
    category: own.category,
  };
}

/** One filter changed by the user. Any year pick, All years included, pins it. */
export function pickRecordsFilter(
  state: RecordsFilterState,
  subsidiaryId: string,
  change: Partial<RecordsFilter>,
): RecordsFilterState {
  const own = state.subsidiaryId === subsidiaryId ? state : blankRecordsFilter(subsidiaryId);
  return {
    ...own,
    ...(change.year !== undefined ? { year: change.year, yearPinned: true } : {}),
    ...(change.status !== undefined ? { status: change.status } : {}),
    ...(change.category !== undefined ? { category: change.category } : {}),
  };
}

/** The API filters for the table, without the subsidiary or a cursor. */
export function recordsQuery(filter: RecordsFilter): Omit<ActivityRecordPageFilters, "subsidiaryId"> {
  return {
    ...(filter.year !== "all" ? { year: filter.year } : {}),
    ...(filter.status !== "all" ? { status: [filter.status] } : {}),
    ...(filter.category !== "all" ? { category: filter.category } : {}),
  };
}

/** True when a filter narrows the list, so an empty table means "nothing matches". */
export function isNarrowed(filter: RecordsFilter): boolean {
  return filter.year !== "all" || filter.status !== "all" || filter.category !== "all";
}

export type EvidenceCell = { kind: "count"; count: number } | { kind: "missing" };

/**
 * A row's evidence: its file count, or "missing" where the category requires a
 * file and the record has none. The rule is the shared evidence-required list
 * (K3, BUG-R2-02), not a copy. A voided record's figure counts towards nothing,
 * so it is never shown as missing a file.
 */
export function evidenceCell(row: {
  category: string;
  evidenceCount: number;
  status: ActivityRecordStatus;
}): EvidenceCell {
  if (row.status !== "voided" && isEvidenceRequired(row.category) && row.evidenceCount === 0) {
    return { kind: "missing" };
  }
  return { kind: "count", count: row.evidenceCount };
}
