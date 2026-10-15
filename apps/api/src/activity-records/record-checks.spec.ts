import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_VALUE_MAX,
  CATEGORIES,
  CATEGORY_SCOPE_MAP,
  PERIOD_VALUES,
  REPORTING_PERIODS,
} from '@tonyai/shared-types';

/**
 * The `activity_records` CHECKs of LP4-02 (33) spell shared-types' lists out in
 * SQL: the scope each category maps to, each granularity's canonical period
 * tokens, and the activity value's upper bound. The API derives the scope,
 * canonicalises the period and bounds the value before it writes; the CHECKs
 * hold every other writer — the owner included — to the same answer. A
 * category, a token or a bound changed on one side only would let the
 * database hold what the API refuses, or refuse what it writes.
 *
 * Each CHECK is compared whole, as text built from shared-types — an extra
 * branch, a loosened one or a duplicate earlier one fails, not only a
 * missing pair — and read from the definition in force: the LAST migration
 * that mentions the constraint's name must be the one that adds it in this
 * form, so a later DROP, RENAME or re-ADD in any other spelling fails here
 * rather than leaving a dead definition read as live.
 */

const migrations = resolve(__dirname, '../../../../packages/db/prisma/migrations');
const texts = readdirSync(migrations)
  .filter((d) => /^\d/.test(d))
  .sort()
  .map((d) => ({ dir: d, text: readFileSync(join(migrations, d, 'migration.sql'), 'utf8') }));

/** The end of the CHECK's own parentheses, skipping quoted literals and comments. */
function closingParen(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text.startsWith('--', i)) {
      i = text.indexOf('\n', i);
      if (i === -1) break;
    } else if (text[i] === "'") {
      i = text.indexOf("'", i + 1); // '' inside a literal: two literals back to back, the same depth
      if (i === -1) break;
    } else if (text[i] === '(') {
      depth++;
    } else if (text[i] === ')' && --depth === 0) {
      return i;
    }
  }
  throw new Error('a CHECK whose parentheses or quotes never close');
}

/** The expression of the named CHECK in force, whitespace collapsed. */
function checkInForce(name: string): string {
  const head = `ADD CONSTRAINT "${name}" CHECK (`;
  const mention = new RegExp(`\\b${name}\\b`, 'gi');
  let last: { dir: string; index: number } | undefined;
  for (const { dir, text } of texts) for (const m of text.matchAll(mention)) last = { dir, index: m.index };
  if (last === undefined) throw new Error(`no migration adds ${name}`);
  const { text } = texts.find((t) => t.dir === last!.dir)!;
  const start = last.index - 'ADD CONSTRAINT "'.length;
  expect(text.slice(start, start + head.length), `${last.dir}: the last mention of ${name} must add it`).toBe(head);
  return text.slice(start + head.length, closingParen(text, start + head.length)).replace(/\s+/g, ' ').trim();
}

const literal = (value: string) => `'${value}'`;

describe('the activity_records CHECKs and shared-types agree (LP4-02 (33))', () => {
  it("holds each category to CATEGORY_SCOPE_MAP's scope, and refuses a category it does not name (ELSE false — a NULL CHECK passes)", () => {
    const branches = CATEGORIES.map((c) => `WHEN ${literal(c)} THEN "scope" = ${CATEGORY_SCOPE_MAP[c]}`);
    expect(checkInForce('activity_records_scope_check')).toBe(`CASE "category" ${branches.join(' ')} ELSE false END`);
  });

  it("holds each granularity to PERIOD_VALUES' canonical tokens, in order, and refuses one it does not name", () => {
    const branches = REPORTING_PERIODS.map((p) => `WHEN ${literal(p)} THEN "period_value" IN (${PERIOD_VALUES[p].map(literal).join(', ')})`);
    expect(checkInForce('activity_records_period_value_check')).toBe(`CASE "reporting_period" ${branches.join(' ')} ELSE false END`);
  });

  it('bounds the activity value at zero and at ACTIVITY_VALUE_MAX — which NaN and ±Infinity both fail', () => {
    const check = checkInForce('activity_records_activity_value_check');
    const bound = /^"activity_value" >= 0 AND "activity_value" <= ([0-9e.+]+)::double precision$/.exec(check);
    expect(bound, check).not.toBeNull();
    expect(Number(bound![1])).toBe(ACTIVITY_VALUE_MAX);
  });
});
