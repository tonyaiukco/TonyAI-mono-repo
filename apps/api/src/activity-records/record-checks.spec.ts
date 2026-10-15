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
 * database hold what the API refuses, or refuse what it writes. Each is read
 * from the LAST migration that adds it — the definition in force.
 */

const migrations = resolve(__dirname, '../../../../packages/db/prisma/migrations');
const dirs = readdirSync(migrations).filter((d) => /^\d/.test(d)).sort();

/** The expression of the named CHECK, as the last migration that adds it writes it. */
function checkInForce(name: string): string {
  let found: string | undefined;
  for (const d of dirs) {
    const text = readFileSync(join(migrations, d, 'migration.sql'), 'utf8');
    const head = `ADD CONSTRAINT "${name}" CHECK (`;
    const start = text.lastIndexOf(head);
    if (start === -1) continue;
    // To the parenthesis that closes CHECK's, skipping quoted literals.
    let depth = 1;
    let i = start + head.length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "'") i = text.indexOf("'", i + 1);
      else if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    found = text.slice(start + head.length, i - 1);
  }
  if (found === undefined) throw new Error(`no migration adds ${name}`);
  return found;
}

const quoted = (list: string) => [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]);

describe('the activity_records CHECKs and shared-types agree (LP4-02 (33))', () => {
  it("holds each category to CATEGORY_SCOPE_MAP's scope, and refuses a category it does not name", () => {
    const check = checkInForce('activity_records_scope_check');
    expect(check).toMatch(/^\s*CASE "category"\s/);
    const cases = [...check.matchAll(/WHEN '([^']+)' THEN "scope" = (\d)/g)].map((m) => [m[1], Number(m[2])]);
    expect(cases.map(([c]) => c)).toEqual([...CATEGORIES]);
    expect(Object.fromEntries(cases)).toEqual(CATEGORY_SCOPE_MAP);
    // Fail-closed: a CASE with no ELSE is NULL, and a NULL CHECK passes.
    expect(check).toMatch(/ELSE false\s+END\s*$/);
  });

  it("holds each granularity to PERIOD_VALUES' canonical tokens, in order, and refuses one it does not name", () => {
    const check = checkInForce('activity_records_period_value_check');
    expect(check).toMatch(/^\s*CASE "reporting_period"\s/);
    const cases = [...check.matchAll(/WHEN '([^']+)' THEN "period_value" IN \(([^)]*)\)/g)].map((m) => [m[1], quoted(m[2])] as const);
    expect(cases.map(([p]) => p)).toEqual([...REPORTING_PERIODS]);
    for (const [period, tokens] of cases) {
      expect(tokens, period).toEqual([...PERIOD_VALUES[period as keyof typeof PERIOD_VALUES]]);
    }
    expect(check).toMatch(/ELSE false\s+END\s*$/);
  });

  it('bounds the activity value at zero and at ACTIVITY_VALUE_MAX — which NaN and ±Infinity both fail', () => {
    const check = checkInForce('activity_records_activity_value_check');
    const bound = /^"activity_value" >= 0 AND "activity_value" <= ([0-9e.+]+)::double precision$/.exec(check.trim());
    expect(bound, check).not.toBeNull();
    expect(Number(bound![1])).toBe(ACTIVITY_VALUE_MAX);
  });
});
