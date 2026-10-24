import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { DEFAULT_PAGE_LIMIT, MAX_CURSOR_LENGTH, type CursorPage } from '@tonyai/shared-types';
import { errorBody } from './api-error';
import { UUID_SHAPE } from './parse-uuid-param.pipe';

/**
 * One keyset cursor for every `CursorPage` route (LP4-05 PR C; lifted from the
 * users list's, LP4-01 PR B S7).
 *
 * A cursor is base64url JSON: `{ v, k, b, s }` — the version, the endpoint, a
 * digest binding it to the sort and the normalised filters, and the last row's
 * sort-key tuple. It is not signed. It carries no tenant, scope or anchor id to
 * look up: every page re-applies the caller's current access, so a forged or
 * another tenant's cursor can only name a position inside the caller's own
 * rows — it never authorises a read. Anything that is not exactly what this
 * module would have written is 400 `validation_failed`, never a silent restart.
 */

/**
 * How a sort column's value crosses the cursor.
 *
 * `timestamp3` is a `TIMESTAMP(3)` column: a JS `Date` holds the same
 * millisecond, so its ISO string round-trips exactly (years 1000–9999 only).
 * `int` is an `int4` column; `text` a short lowercase vocabulary code. A column with microsecond
 * precision (`Timestamptz(6)`) must NOT use it — Prisma hands it back truncated
 * to the millisecond, and a keyset on the truncated value skips or repeats the
 * rows that share it. `keyset-columns.int.spec.ts` pins every column used here
 * at precision 3.
 */
export type KeyKind = 'timestamp3' | 'uuid' | 'int' | 'text';

export interface KeyColumn {
  field: string;
  kind: KeyKind;
  direction: 'asc' | 'desc';
  /** Only for an ascending column ordered NULLS LAST (review_queue's submittedAt). */
  nullsLast?: true;
}

export interface KeysetSort {
  /** The endpoint; a cursor of another endpoint is refused. */
  endpoint: string;
  /** The table whose columns `keys` name — `keyset-columns.int.spec.ts` pins their types there. */
  table: string;
  /** The sort's name, part of the binding. */
  name: string;
  keys: readonly KeyColumn[];
}

export type KeyValue = Date | string | number | null;

const CURSOR_VERSION = 2;
/**
 * What each kind may hold, checked before a value reaches Prisma: a value the
 * database cannot take — an extended-year date, an integer past int4, a NUL in
 * a code — must be this module's 400, never Postgres's 500.
 */
const TIMESTAMP3 = /^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;
/** A `text` key is a short vocabulary code (a metric key). */
const TEXT_CODE = /^[a-z][a-z0-9_]{0,63}$/;

const refuse = () => new BadRequestException(errorBody('validation_failed', ['cursor is invalid']));

/**
 * The digest that binds a cursor to its endpoint, its sort — the name and the
 * key columns themselves, so a sort whose columns or directions change
 * refuses the cursors written for the old meaning — and its filters. `filters`
 * must already be normalised (ids lowercased, sets sorted, absent = undefined)
 * so two spellings of one request bind alike; undefined members drop out.
 */
export function cursorBinding(sort: KeysetSort, filters: object): string {
  const canonical = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify([
      sort.endpoint,
      sort.name,
      sort.keys.map((k) => [k.field, k.kind, k.direction, k.nullsLast === true]),
      canonical,
    ]))
    .digest('base64url')
    .slice(0, 22);
}

function encodeValue(column: KeyColumn, value: KeyValue): string | number | null {
  if (value === null) {
    if (!column.nullsLast) throw new Error(`keyset column ${column.field} is not nullable`);
    return null;
  }
  switch (column.kind) {
    case 'timestamp3':
      if (!(value instanceof Date)) throw new Error(`keyset column ${column.field} needs a Date`);
      return value.toISOString();
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < INT4_MIN || value > INT4_MAX) {
        throw new Error(`keyset column ${column.field} needs an int4`);
      }
      return value;
    case 'uuid':
      if (typeof value !== 'string') throw new Error(`keyset column ${column.field} needs a string`);
      return value.toLowerCase();
    case 'text':
      // A stored value outside the vocabulary is an integrity failure, not a
      // cursor this module would later refuse to read back.
      if (typeof value !== 'string' || !TEXT_CODE.test(value)) throw new Error(`keyset column ${column.field} needs a code`);
      return value;
  }
}

function decodeValue(column: KeyColumn, raw: unknown): KeyValue {
  if (raw === null) {
    if (!column.nullsLast) throw refuse();
    return null;
  }
  switch (column.kind) {
    case 'timestamp3': {
      if (typeof raw !== 'string' || !TIMESTAMP3.test(raw)) throw refuse();
      const date = new Date(raw);
      if (Number.isNaN(date.getTime()) || date.toISOString() !== raw) throw refuse();
      return date;
    }
    case 'int':
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < INT4_MIN || raw > INT4_MAX) throw refuse();
      return raw;
    case 'uuid':
      if (typeof raw !== 'string' || !UUID_SHAPE.test(raw)) throw refuse();
      return raw.toLowerCase();
    case 'text':
      if (typeof raw !== 'string' || !TEXT_CODE.test(raw)) throw refuse();
      return raw;
  }
}

export function encodeCursor(sort: KeysetSort, binding: string, values: readonly KeyValue[]): string {
  if (values.length !== sort.keys.length) throw new Error('keyset tuple does not match its sort');
  const s = sort.keys.map((column, i) => encodeValue(column, values[i] ?? null));
  const cursor = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, k: sort.endpoint, b: binding, s })).toString('base64url');
  // A sort key this module wrote never comes near the bound; failing loudly
  // beats handing the client a cursor the contract says it must refuse.
  if (cursor.length > MAX_CURSOR_LENGTH) throw new Error('cursor exceeds MAX_CURSOR_LENGTH');
  return cursor;
}

/** The sort-key tuple a cursor continues after, or 400 for anything this module did not write for this request. */
export function decodeCursor(sort: KeysetSort, binding: string, raw: string): KeyValue[] {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) throw refuse();
  // base64url decoding ignores characters outside its alphabet; a cursor that
  // is not exactly the canonical spelling of its own bytes is not ours.
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw) throw refuse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw refuse();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw refuse();
  const c = parsed as Record<string, unknown>;
  if (Object.keys(c).sort().join() !== 'b,k,s,v') throw refuse();
  if (c.v !== CURSOR_VERSION || c.k !== sort.endpoint || c.b !== binding) throw refuse();
  if (!Array.isArray(c.s) || c.s.length !== sort.keys.length) throw refuse();
  return sort.keys.map((column, i) => decodeValue(column, (c.s as unknown[])[i]));
}

/**
 * The rows after `values` in `sort`'s order, as a Prisma `where` fragment: the
 * lexicographic expansion `k1 > v1 OR (k1 = v1 AND k2 > v2) OR …`, with
 * explicit NULL branches for a NULLS LAST column — after a non-null value every
 * NULL follows; after a NULL only a later id among the NULLs does. Values reach
 * Prisma as bound parameters, never SQL text.
 */
export function keysetWhere(sort: KeysetSort, values: readonly KeyValue[]): { OR: Record<string, unknown>[] } {
  const branches: Record<string, unknown>[] = [];
  for (let i = 0; i < sort.keys.length; i++) {
    const column = sort.keys[i]!;
    const value = values[i] ?? null;
    const equalBefore: Record<string, unknown> = {};
    for (let j = 0; j < i; j++) equalBefore[sort.keys[j]!.field] = values[j] ?? null;
    if (value === null) continue; // nothing sorts after NULL in a NULLS LAST column
    const op = column.direction === 'asc' ? 'gt' : 'lt';
    branches.push({ ...equalBefore, [column.field]: { [op]: value } });
    if (column.nullsLast) branches.push({ ...equalBefore, [column.field]: null });
  }
  return { OR: branches };
}

/** `sort`'s order as a Prisma `orderBy`. */
export function keysetOrderBy(sort: KeysetSort): Record<string, unknown>[] {
  return sort.keys.map((column) => ({
    [column.field]: column.nullsLast ? { sort: column.direction, nulls: 'last' } : column.direction,
  }));
}

/**
 * The page from `limit + 1` fetched rows: the first `limit` of them, and a
 * cursor after the last one only when the extra row proved there is more.
 */
export function toCursorPage<Row, Item>(
  rows: readonly Row[],
  limit: number,
  sort: KeysetSort,
  binding: string,
  keyOf: (row: Row) => readonly KeyValue[],
  toItem: (row: Row) => Item,
): CursorPage<Item> {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toItem),
    limit,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(sort, binding, keyOf(last)) : null,
  };
}

/** The effective page size: the validated request's, else the contract's default. */
export function pageLimit(limit: number | undefined): number {
  return limit ?? DEFAULT_PAGE_LIMIT;
}
