import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FILE_FUELS,
  FUEL_ACCOUNT_STATES,
  FUEL_BATCH_STATUSES,
  FUEL_HOLD_REASONS,
  FUEL_ROW_STATES,
  FUEL_SOURCES,
  FUEL_USAGES,
  IMPORT_SOURCES,
} from '@tonyai/shared-types';

/**
 * inc28-fuel-bulk: the migration's CHECKs spell each vocabulary out; the
 * contract in `@tonyai/shared-types` is what the API and the web read. A word
 * added to one and not the other would be refused by the database, or never
 * written — so the two are compared here, list by list.
 */

const MIGRATION = readFileSync(
  join(__dirname, '../../../../../packages/db/prisma/migrations/20261127120000_inc28_fuel_bulk/migration.sql'),
  'utf8',
);

/** The quoted words of `"<column>" IN (…)` inside the named constraint's CHECK. */
function inList(constraint: string, column: string): string[] {
  const at = MIGRATION.indexOf(`ADD CONSTRAINT "${constraint}"`);
  if (at < 0) throw new Error(`no constraint ${constraint}`);
  const body = MIGRATION.slice(at, MIGRATION.indexOf(';', at));
  const match = new RegExp(`"${column}" IN \\(([^)]*)\\)`).exec(body);
  if (!match) throw new Error(`no IN list for ${column} in ${constraint}`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

const sorted = (words: readonly string[]) => [...words].sort();

describe('the migration’s vocabularies are the contract’s', () => {
  it.each([
    ['import_batches_source_check', 'source', IMPORT_SOURCES],
    ['fuel_accounts_source_check', 'source', FUEL_SOURCES],
    ['fuel_accounts_state_check', 'state', FUEL_ACCOUNT_STATES],
    ['fuel_batches_source_check', 'source', FUEL_SOURCES],
    ['fuel_batches_usage_check', 'usage', FUEL_USAGES],
    ['fuel_batches_status_check', 'status', FUEL_BATCH_STATUSES],
    ['fuel_rows_source_check', 'source', FUEL_SOURCES],
    ['fuel_rows_usage_check', 'usage', FUEL_USAGES],
    ['fuel_rows_fuel_check', 'fuel', FILE_FUELS],
    ['fuel_rows_state_check', 'state', FUEL_ROW_STATES],
    ['fuel_rows_state_columns_check', 'hold_reason', FUEL_HOLD_REASONS],
  ] as const)('%s: "%s"', (constraint, column, words) => {
    const listed = constraint === 'fuel_accounts_state_check'
      ? [...MIGRATION.slice(MIGRATION.indexOf('ADD CONSTRAINT "fuel_accounts_state_check"')).split(';')[0]!.matchAll(/"state" = '([^']+)'/g)].map((m) => m[1]!)
      : inList(constraint, column);
    expect(sorted(listed)).toEqual(sorted(words));
  });

  it('lets a row be withdrawn from every state but withdrawn', () => {
    expect(sorted(inList('fuel_rows_state_check', 'withdrawn_state'))).toEqual(
      sorted(FUEL_ROW_STATES.filter((s) => s !== 'withdrawn')),
    );
  });
});
