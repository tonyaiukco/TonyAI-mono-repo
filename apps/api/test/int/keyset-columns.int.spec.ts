import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { RECORD_SORTS } from '../../src/activity-records/record-page';
import type { KeyKind, KeysetSort } from '../../src/common/keyset-cursor';
import { EVIDENCE_SORT } from '../../src/evidence/evidence.service';
import { DENOMINATOR_SORT } from '../../src/intensity/intensity.service';
import { PERIOD_LOCK_SORT } from '../../src/period-locks/period-locks.service';
import { TARGET_SORT } from '../../src/targets/targets.service';
import { USERS_SORT } from '../../src/users/users-query.service';
import { connectOwner } from './db';

/**
 * LP4-05 PR C: a keyset cursor carries each sort column's value, and the
 * helper's `timestamp3` kind is exact only for a millisecond column — Prisma
 * returns a microsecond one truncated, and a keyset on the truncated value
 * skips or repeats the rows that share it. This pins every column every sort
 * names, in the real schema, at the type its kind assumes. A new sort is
 * added to SORTS, or this list misses it.
 */
const SORTS: KeysetSort[] = [
  ...Object.values(RECORD_SORTS),
  PERIOD_LOCK_SORT,
  TARGET_SORT,
  DENOMINATOR_SORT,
  EVIDENCE_SORT,
  USERS_SORT,
];

const EXPECTED: Record<KeyKind, { dataType: string; precision?: number }> = {
  timestamp3: { dataType: 'timestamp without time zone', precision: 3 },
  uuid: { dataType: 'uuid' },
  int: { dataType: 'integer' },
  text: { dataType: 'text' },
};

const column = (field: string) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

let owner: PrismaService;
beforeAll(() => {
  owner = connectOwner();
});
afterAll(async () => {
  await owner.$disconnect();
});

describe('every keyset sort column has the type its cursor kind assumes', () => {
  it.each(SORTS.flatMap((sort) => sort.keys.map((key) => [`${sort.endpoint} ${sort.name}: ${sort.table}.${column(key.field)}`, sort, key] as const)))(
    '%s',
    async (_label, sort, key) => {
      const [row] = await owner.$queryRaw<{ data_type: string; datetime_precision: number | null; is_nullable: string }[]>`
        SELECT data_type, datetime_precision, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${sort.table} AND column_name = ${column(key.field)}`;
      expect(row, 'the column exists').toBeDefined();
      const expected = EXPECTED[key.kind];
      expect(row!.data_type).toBe(expected.dataType);
      if (expected.precision !== undefined) expect(row!.datetime_precision).toBe(expected.precision);
      // Only a NULLS LAST column may hold NULL: the cursor refuses NULL anywhere else.
      if (!key.nullsLast) expect(row!.is_nullable).toBe('NO');
    },
  );

  it('every sort ends on its table\'s unique id, so ties never reorder between pages', () => {
    for (const sort of SORTS) expect(sort.keys[sort.keys.length - 1]).toMatchObject({ field: 'id', kind: 'uuid' });
  });
});
