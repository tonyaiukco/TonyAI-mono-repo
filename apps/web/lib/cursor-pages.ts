import { ApiError } from "@/lib/api";

/**
 * Client helpers for LP4-05's `CursorPage` lists. A screen shows the pages it
 * has loaded and says so; it never fetches every page to look complete.
 */

/** Appends a page, dropping any row already shown (a row that moved between pages). */
export function appendById<T extends { id: string }>(list: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(list.map((row) => row.id));
  return [...list, ...page.filter((row) => !seen.has(row.id))];
}

/**
 * A "load more" refused with 400: its cursor is one this deployment no longer
 * accepts (an old tab across a release) — the list starts again from its first
 * page rather than offering the same refused cursor (README "Release and
 * rollback").
 */
export function isStaleCursor(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400;
}
