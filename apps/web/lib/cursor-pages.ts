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
 * page rather than offering the same refused cursor (docs/api/bounded-access.md "Release and
 * rollback").
 */
export function isStaleCursor(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400;
}

/**
 * Every row of a bounded set, read page by page, for a DECISION rather than a
 * display: the refrigerant shortcut (UAT round 2, K5) must see a subsidiary's
 * whole year to know whether to offer itself and what to tick. Stops after
 * `maxPages`, returning what it read; never used to make a list look complete.
 */
export async function readPages<T extends { id: string }>(
  read: (cursor: string | undefined) => Promise<{ items: readonly T[]; nextCursor: string | null }>,
  maxPages: number,
): Promise<T[]> {
  let items: T[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < maxPages; pages++) {
    const page = await read(cursor);
    items = appendById(items, page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return items;
}
