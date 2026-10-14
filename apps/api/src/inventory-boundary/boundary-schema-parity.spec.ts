import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { CATEGORIES, CATEGORY_SCOPE_MAP, recordActivityTypesFor, REPORTING_PERIODS } from '@tonyai/shared-types';

/**
 * The inventory boundary's CHECKs spell shared-types' lists out in SQL
 * (LP3-04 PR B's migration, section 1): the Scope 1/2 categories, which of
 * them are typed, the scope each maps to, and the cadences. A category or a
 * cadence added on one side only would let the database hold what the
 * contract cannot say — or refuse what it can.
 */

const sql = readFileSync(
  resolve(__dirname, '../../../../packages/db/prisma/migrations/20261016120000_lp3_04_inventory_boundary/migration.sql'),
  'utf8',
);

/** The quoted list of the first `"<column>" IN (…)` inside the named constraint. */
function listIn(constraint: string, column: string): string[] {
  const start = sql.indexOf(`"${constraint}" CHECK`);
  expect(start, constraint).toBeGreaterThan(-1);
  const match = sql.slice(start).match(new RegExp(`"${column}" IN \\(([^)]*)\\)`));
  expect(match, `${constraint}: ${column}`).not.toBeNull();
  return [...match![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

const SCOPE_1_2 = CATEGORIES.filter((c) => CATEGORY_SCOPE_MAP[c] !== 3);

describe('the inventory boundary schema and shared-types agree', () => {
  it('on the Scope 1/2 categories, in every table that holds one', () => {
    for (const constraint of [
      'inventory_attribution_policies_category_check',
      'inventory_applicability_cells_category_check',
      'inventory_sources_mapping_check',
    ]) {
      expect(listIn(constraint, 'category').sort(), constraint).toEqual([...SCOPE_1_2].sort());
    }
  });

  it('on which categories are typed — a typed category\'s source names its type (21)', () => {
    const typed = SCOPE_1_2.filter((c) => recordActivityTypesFor(c).length > 0);
    const block = sql.slice(sql.indexOf('"inventory_sources_mapping_check" CHECK'));
    const match = block.match(/\("activity_type" IS NOT NULL\) = \("category" IN \(([^)]*)\)\)/);
    expect(match).not.toBeNull();
    expect([...match![1].matchAll(/'([^']*)'/g)].map((m) => m[1]).sort()).toEqual([...typed].sort());
  });

  it('on the scope each category maps to', () => {
    const block = sql.slice(sql.indexOf('"inventory_sources_mapping_check" CHECK'));
    const match = block.match(/"scope" = CASE "category" WHEN '([^']+)' THEN 2 ELSE 1 END/);
    expect(match).not.toBeNull();
    expect(SCOPE_1_2.filter((c) => CATEGORY_SCOPE_MAP[c] === 2)).toEqual([match![1]]);
  });

  it('on the cadences', () => {
    expect(listIn('inventory_attribution_policies_period_check', 'reporting_period')).toEqual([...REPORTING_PERIODS]);
    expect(listIn('inventory_sources_cadence_check', 'reporting_period')).toEqual([...REPORTING_PERIODS]);
    expect(listIn('inventory_sources_cadence_check', 'evidence_reporting_period')).toEqual([...REPORTING_PERIODS]);
  });
});
