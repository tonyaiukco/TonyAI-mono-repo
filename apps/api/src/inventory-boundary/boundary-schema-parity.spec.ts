import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  CATEGORIES, CATEGORY_SCOPE_MAP, INVENTORY_CATEGORIES, INVENTORY_REASON_MAX_LENGTH,
  INVENTORY_SOURCE_NAME_MAX_LENGTH, recordActivityTypesFor, REPORTING_PERIODS,
} from '@tonyai/shared-types';

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

  it("on which categories are typed and on each one's activity types — a typed source names one of its own (21)", () => {
    const typed = SCOPE_1_2.filter((c) => recordActivityTypesFor(c).length > 0);
    const block = sql.slice(sql.indexOf('"inventory_sources_mapping_check" CHECK'));
    const cases = [...block.matchAll(/WHEN '([^']+)' THEN "activity_type" IS NOT NULL AND "activity_type" IN \(([^)]*)\)/g)];
    expect(cases.map((m) => m[1]).sort()).toEqual([...typed].sort());
    for (const [, category, list] of cases) {
      expect([...list.matchAll(/'([^']*)'/g)].map((m) => m[1]), category).toEqual(recordActivityTypesFor(category).map((t) => t.value));
    }
    expect(block).toMatch(/ELSE "activity_type" IS NULL\s+END/);
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

  // The write path's contract (W1) names the same list and caps its DTOs hold
  // a body to, so a body the DTO admits is one the CHECKs admit.
  it("on the write path's inventory categories", () => {
    expect([...INVENTORY_CATEGORIES]).toEqual(listIn('inventory_attribution_policies_category_check', 'category'));
  });

  it("on the write path's free-text caps", () => {
    const capsOf = (constraint: string, column: string): number[] => {
      const start = sql.indexOf(`"${constraint}" CHECK`);
      expect(start, constraint).toBeGreaterThan(-1);
      // To the next constraint: this one's own bounds, never a neighbour's.
      const end = sql.indexOf('\n  ADD CONSTRAINT', start + 1);
      const block = sql.slice(start, end === -1 ? undefined : end);
      return [...block.matchAll(new RegExp(`char_length\\("${column}"\\) BETWEEN 1 AND (\\d+)`, 'g'))].map((m) => Number(m[1]));
    };
    expect(capsOf('inventory_sources_name_check', 'name')).toEqual([INVENTORY_SOURCE_NAME_MAX_LENGTH]);
    expect(capsOf('inventory_sources_mapping_check', 'unsupported_reason')).toEqual([INVENTORY_REASON_MAX_LENGTH]);
    expect(capsOf('inventory_sources_decision_check', 'reason')).toEqual([INVENTORY_REASON_MAX_LENGTH]);
    expect(capsOf('inventory_applicability_cells_decision_check', 'reason')).toEqual([INVENTORY_REASON_MAX_LENGTH]);
  });
});
