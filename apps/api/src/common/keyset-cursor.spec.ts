import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_CURSOR_LENGTH } from '@tonyai/shared-types';
import {
  cursorBinding,
  decodeCursor,
  encodeCursor,
  keysetOrderBy,
  keysetWhere,
  toCursorPage,
  type KeysetSort,
  type KeyValue,
} from './keyset-cursor';

const NEWEST: KeysetSort = {
  endpoint: 'things',
  table: 'things',
  name: 'newest',
  keys: [
    { field: 'createdAt', kind: 'timestamp3', direction: 'desc' },
    { field: 'id', kind: 'uuid', direction: 'desc' },
  ],
};
const QUEUE: KeysetSort = {
  endpoint: 'things',
  table: 'things',
  name: 'review_queue',
  keys: [
    { field: 'submittedAt', kind: 'timestamp3', direction: 'asc', nullsLast: true },
    { field: 'id', kind: 'uuid', direction: 'asc' },
  ],
};
const MIXED: KeysetSort = {
  endpoint: 'mixed',
  table: 'mixed',
  name: 'default',
  keys: [
    { field: 'year', kind: 'int', direction: 'asc' },
    { field: 'metric', kind: 'text', direction: 'asc' },
    { field: 'createdAt', kind: 'timestamp3', direction: 'desc' },
    { field: 'id', kind: 'uuid', direction: 'desc' },
  ],
};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const refused = expect.objectContaining({ response: expect.objectContaining({ code: 'validation_failed' }) });

describe('cursorBinding', () => {
  it('ignores filter order and absent filters, and separates endpoints, sorts and values', () => {
    const base = cursorBinding(NEWEST, { year: 2026, status: ['submitted'] });
    expect(cursorBinding(NEWEST, { status: ['submitted'], year: 2026, search: undefined })).toBe(base);
    expect(cursorBinding(NEWEST, { year: 2025, status: ['submitted'] })).not.toBe(base);
    expect(cursorBinding(NEWEST, { year: 2026 })).not.toBe(base);
    expect(cursorBinding(QUEUE, { year: 2026, status: ['submitted'] })).not.toBe(base);
    expect(cursorBinding({ ...NEWEST, endpoint: 'other' }, { year: 2026, status: ['submitted'] })).not.toBe(base);
    // null is a filter (company-level), not an absent one.
    expect(cursorBinding(NEWEST, { locationId: null })).not.toBe(cursorBinding(NEWEST, {}));
    // A sort that keeps its name but changes a column's direction binds anew.
    const flipped: KeysetSort = { ...NEWEST, keys: [{ ...NEWEST.keys[0]!, direction: 'asc' }, NEWEST.keys[1]!] };
    expect(cursorBinding(flipped, { year: 2026, status: ['submitted'] })).not.toBe(base);
  });
});

describe('encodeCursor / decodeCursor', () => {
  const binding = cursorBinding(MIXED, {});

  it('round-trips every key kind, and a NULL in a NULLS LAST column', () => {
    const tuple: KeyValue[] = [2027, 'revenue', new Date('2026-10-10T10:00:00.123Z'), randomUUID()];
    expect(decodeCursor(MIXED, binding, encodeCursor(MIXED, binding, tuple))).toEqual(tuple);
    const queueBinding = cursorBinding(QUEUE, {});
    const nullTuple: KeyValue[] = [null, randomUUID()];
    expect(decodeCursor(QUEUE, queueBinding, encodeCursor(QUEUE, queueBinding, nullTuple))).toEqual(nullTuple);
  });

  it('carries the tuple and nothing else — no tenant, scope or anchor to look up', () => {
    const id = randomUUID();
    const raw = encodeCursor(NEWEST, 'B', [new Date('2026-01-01T00:00:00.000Z'), id]);
    expect(JSON.parse(Buffer.from(raw, 'base64url').toString())).toEqual({
      v: 2, k: 'things', b: 'B', s: ['2026-01-01T00:00:00.000Z', id],
    });
  });

  it('lowercases an id, as the database spells it', () => {
    const id = randomUUID();
    const raw = encodeCursor(NEWEST, 'B', [new Date(0), id.toUpperCase()]);
    expect(decodeCursor(NEWEST, 'B', raw)[1]).toBe(id);
  });

  it('refuses to write a cursor over the published bound, or a tuple of the wrong shape', () => {
    // No sort this API declares comes near the bound; a sort of sixty ids does.
    const wide: KeysetSort = {
      endpoint: 'wide', table: 'wide', name: 'wide',
      keys: Array.from({ length: 60 }, (_, i) => ({ field: `k${i}`, kind: 'uuid' as const, direction: 'asc' as const })),
    };
    expect(() => encodeCursor(wide, 'B', wide.keys.map(() => randomUUID()))).toThrow(/MAX_CURSOR_LENGTH/);
    expect(() => encodeCursor(NEWEST, 'B', [new Date(0)])).toThrow();
    expect(() => encodeCursor(NEWEST, 'B', [null, randomUUID()])).toThrow(/not nullable/);
    expect(() => encodeCursor(NEWEST, 'B', ['2026-01-01', randomUUID()])).toThrow(/Date/);
    expect(() => encodeCursor(MIXED, 'B', [2_147_483_648, 'revenue', new Date(0), randomUUID()])).toThrow(/int4/);
    expect(() => encodeCursor(MIXED, 'B', [2027, 'Not A Code', new Date(0), randomUUID()])).toThrow(/code/);
  });

  const id = randomUUID();
  const t = '2026-10-10T10:00:00.000Z';
  const good = { v: 2, k: 'things', b: 'B', s: [t, id] };
  it.each([
    ['an empty value', ''],
    ['an over-long value', 'a'.repeat(MAX_CURSOR_LENGTH + 1)],
    ['garbage', 'not-a-cursor'],
    ['base64url with characters outside its alphabet', `${b64(good)}!`],
    ['base64 padding', `${b64(good)}==`],
    ['JSON that is an array', b64([2, 'things', 'B', [t, id]])],
    ['JSON null', b64(null)],
    ['a number', b64(7)],
    ['a missing member', b64({ v: 2, k: 'things', s: [t, id] })],
    ['an extra member', b64({ ...good, o: 'acme' })],
    ['another version', b64({ ...good, v: 1 })],
    ['another endpoint', b64({ ...good, k: 'users' })],
    ['another binding (other filters or sort)', b64({ ...good, b: 'C' })],
    ['a short tuple', b64({ ...good, s: [t] })],
    ['a long tuple', b64({ ...good, s: [t, id, id] })],
    ['a tuple that is not an array', b64({ ...good, s: { 0: t, 1: id } })],
    ['an id that is not one', b64({ ...good, s: [t, "1' OR 1=1"] })],
    ['a time that is not canonical', b64({ ...good, s: ['2026-10-10', id] })],
    ['a time with microseconds', b64({ ...good, s: ['2026-10-10T10:00:00.000001Z', id] })],
    ['a time as a number', b64({ ...good, s: [Date.parse(t), id] })],
    ['NULL in a column that is not NULLS LAST', b64({ ...good, s: [null, id] })],
    // Values JS accepts and the database does not: each must be a 400, not Postgres's 500.
    ['an extended-year time past Date\'s range', b64({ ...good, s: ['+275760-09-13T00:00:00.000Z', id] })],
    ['a negative extended-year time', b64({ ...good, s: ['-000001-01-01T00:00:00.000Z', id] })],
    ['a five-digit year', b64({ ...good, s: ['+010000-01-01T00:00:00.000Z', id] })],
    ['year 0', b64({ ...good, s: ['0000-01-01T00:00:00.000Z', id] })],
  ])('refuses %s as validation_failed', (_label, raw) => {
    expect(() => decodeCursor(NEWEST, 'B', raw)).toThrow(refused);
  });

  it.each([
    ['a fractional int', [1.5, 'revenue', t, id]],
    ['an int as a string', ['2027', 'revenue', t, id]],
    ['an empty text key', [2027, '', t, id]],
    ['a text key longer than any code', [2027, 'x'.repeat(65), t, id]],
    ['an int past int4', [2_147_483_648, 'revenue', t, id]],
    ['an int below int4', [-2_147_483_649, 'revenue', t, id]],
    ['the largest safe integer', [Number.MAX_SAFE_INTEGER, 'revenue', t, id]],
    ['a NUL in a text key', [2027, `rev${String.fromCharCode(0)}enue`, t, id]],
    ['a lone surrogate in a text key', [2027, String.fromCharCode(0xd800), t, id]],
    ['an uppercase text key', [2027, 'Revenue', t, id]],
  ])('refuses %s', (_label, s) => {
    expect(() => decodeCursor(MIXED, binding, b64({ v: 2, k: 'mixed', b: binding, s }))).toThrow(refused);
  });
});

describe('keysetWhere / keysetOrderBy', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const t = new Date('2026-10-10T10:00:00.000Z');

  it('newest: older, or the same instant with a smaller id', () => {
    expect(keysetWhere(NEWEST, [t, id])).toEqual({
      OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: id } }],
    });
    expect(keysetOrderBy(NEWEST)).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('review_queue after a submitted row: later, every NULL, or the same instant with a larger id', () => {
    expect(keysetWhere(QUEUE, [t, id])).toEqual({
      OR: [{ submittedAt: { gt: t } }, { submittedAt: null }, { submittedAt: t, id: { gt: id } }],
    });
    expect(keysetOrderBy(QUEUE)).toEqual([{ submittedAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }]);
  });

  it('review_queue after a NULL row: only a larger id among the NULLs', () => {
    expect(keysetWhere(QUEUE, [null, id])).toEqual({ OR: [{ submittedAt: null, id: { gt: id } }] });
  });

  it('mixed directions expand column by column', () => {
    expect(keysetWhere(MIXED, [2027, 'revenue', t, id])).toEqual({
      OR: [
        { year: { gt: 2027 } },
        { year: 2027, metric: { gt: 'revenue' } },
        { year: 2027, metric: 'revenue', createdAt: { lt: t } },
        { year: 2027, metric: 'revenue', createdAt: t, id: { lt: id } },
      ],
    });
  });
});

/**
 * The property the contract promises: walking pages visits every row exactly
 * once, in order, with ties on every column and NULLs — evaluated in memory
 * against the same `where` and `orderBy` the helper hands Prisma.
 */
describe('a traversal, in memory', () => {
  type Row = Record<string, unknown>;
  const cmp = (a: unknown, b: unknown): number => {
    if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
    return a === b ? 0 : (a as string | number) < (b as string | number) ? -1 : 1;
  };
  const eq = (a: unknown, b: unknown) => (a === null || b === null ? a === b : cmp(a, b) === 0);
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([field, cond]) => {
      if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
        const { gt, lt } = cond as { gt?: unknown; lt?: unknown };
        if (row[field] === null) return false; // SQL: NULL > x is not true
        return gt !== undefined ? cmp(row[field], gt) > 0 : cmp(row[field], lt) < 0;
      }
      return eq(row[field], cond);
    });
  const order = (sort: KeysetSort) => (a: Row, b: Row) => {
    for (const k of sort.keys) {
      const [x, y] = [a[k.field], b[k.field]];
      if (x === null || y === null) {
        if (x === y) continue;
        return x === null ? 1 : -1; // NULLS LAST
      }
      const c = cmp(x, y);
      if (c !== 0) return k.direction === 'asc' ? c : -c;
    }
    return 0;
  };
  const walk = (sort: KeysetSort, rows: Row[], limit: number) => {
    const binding = cursorBinding(sort, {});
    const seen: Row[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < rows.length + 2; guard++) {
      const after = cursor === null ? null : decodeCursor(sort, binding, cursor);
      const fetched = rows
        .filter((r) => after === null || keysetWhere(sort, after).OR.some((w) => matches(r, w)))
        .sort(order(sort))
        .slice(0, limit + 1);
      const page = toCursorPage<Row, Row>(fetched, limit, sort, binding, (r) => sort.keys.map((k) => r[k.field] as KeyValue), (r) => r);
      seen.push(...page.items);
      cursor = page.nextCursor;
      if (cursor === null) return seen;
    }
    throw new Error('the traversal did not end');
  };
  const pick = <T>(xs: readonly T[], i: number) => xs[i % xs.length]!;
  const instants = [0, 1, 2].map((n) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, n)));

  it.each([1, 2, 3, 7, 50])('newest, review_queue and a mixed sort, page size %i', (limit) => {
    const rows: Row[] = Array.from({ length: 40 }, (_, i) => ({
      id: randomUUID(),
      createdAt: pick(instants, i * 7),
      submittedAt: i % 4 === 0 ? null : pick(instants, i * 5),
      year: 2025 + (i % 3),
      metric: pick(['area', 'headcount', 'revenue'], i * 11),
    }));
    for (const sort of [NEWEST, QUEUE, MIXED]) {
      const expected = [...rows].sort(order(sort)).map((r) => r.id);
      expect(walk(sort, rows, limit).map((r) => r.id)).toEqual(expected);
    }
  });

  it('an empty set is one empty, final page', () => {
    expect(walk(NEWEST, [], 3)).toEqual([]);
  });
});
