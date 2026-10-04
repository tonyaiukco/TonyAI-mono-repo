/**
 * The LP3-03 migration's `activity_records` triggers, read as text and pinned
 * to the API they back: K5's editable statuses are the service's
 * EDITABLE_STATUSES, the SQLSTATEs are the ones `recordTriggerCode` maps, and
 * the slot-kind check compares exactly the unique index's first six columns.
 * A drift in either place fails here, in `pnpm test`, before `test:int`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDITABLE_STATUSES } from './activity-records.service';

const migrations = resolve(__dirname, '../../../../packages/db/prisma/migrations');
const dir = readdirSync(migrations).find((d) => d.endsWith('_lp3_03_factor_model'));
const sql = readFileSync(join(migrations, dir ?? 'missing', 'migration.sql'), 'utf8');

function functionBody(name: string): string {
  const start = sql.indexOf(`CREATE FUNCTION "public"."${name}"()`);
  if (start < 0) throw new Error(`no function ${name}`);
  return sql.slice(start, sql.indexOf('$fn$;', start));
}

describe('the activity_records integrity triggers', () => {
  it('K5 lets exactly EDITABLE_STATUSES change a snapshot', () => {
    const body = functionBody('activity_records_snapshot_immutable');
    const list = /OLD\."status" NOT IN \(([^)]*)\)/.exec(body)?.[1] ?? '';
    const statuses = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(statuses.sort()).toEqual([...EDITABLE_STATUSES].sort());
  });

  it('K5 tests OLD, guards the snapshot and every input it was computed from, and lets location only become NULL', () => {
    const body = functionBody('activity_records_snapshot_immutable');
    for (const column of [
      'calculation', 'activity_type', 'category', 'activity_value', 'activity_unit', 'scope',
      'reporting_year', 'reporting_period', 'period_value', 'subsidiary_id',
    ]) {
      expect(body).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`);
    }
    // A direct edit may not detach a site either: only the foreign key's
    // ON DELETE SET NULL, which fires K5 as a nested trigger.
    expect(body).toContain('NEW."location_id" IS NOT NULL OR pg_catalog.pg_trigger_depth() < 2');
    expect(body).not.toMatch(/SECURITY DEFINER|SELECT /);
  });

  it('K5 lets a record re-enter an editable status only the way the API sends it — rejected from review, never draft', () => {
    const body = functionBody('activity_records_snapshot_immutable');
    const rewind = /NEW\."status" IN \(([^)]*)\)\s*AND NOT \(NEW\."status" = 'rejected' AND OLD\."status" IN \(([^)]*)\)\)/.exec(body);
    const list = (m: string | undefined) => [...(m ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(list(rewind?.[1])).toEqual([...EDITABLE_STATUSES].sort());
    // The API's reject gate: only a submitted or under_review record.
    expect(list(rewind?.[2])).toEqual(['submitted', 'under_review']);
  });

  it('raise the SQLSTATEs the service maps to 409', () => {
    expect(functionBody('activity_records_snapshot_immutable')).toContain("ERRCODE = 'TA001'");
    expect(functionBody('activity_records_slot_kind')).toContain("ERRCODE = 'TA002'");
    for (const name of ['activity_records_snapshot_immutable', 'activity_records_slot_kind']) {
      expect(sql).toContain(`ENABLE ALWAYS TRIGGER "${name}"`);
    }
  });

  it("compare a slot on exactly the unique index's first six columns", () => {
    const index = /ON "activity_records" \(([^)]*)\)\s*NULLS NOT DISTINCT/.exec(sql)?.[1] ?? '';
    const columns = [...index.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(columns.at(-1)).toBe('activity_type');
    const body = functionBody('activity_records_slot_kind');
    const compared = [...body.matchAll(/r\."([a-z_]+)" (?:=|IS NOT DISTINCT FROM) NEW\."\1"/g)].map((m) => m[1]);
    expect(compared).toEqual(columns.slice(0, 6));
    // The early return — "same slot, same kind, nothing to check" — must test
    // the same six columns, or an update moving a row to another slot would
    // skip the check.
    const early = [...body.matchAll(/NEW\."([a-z_]+)" (?:=|IS NOT DISTINCT FROM) OLD\."\1"/g)].map((m) => m[1]);
    expect(early).toEqual(columns.slice(0, 6));
  });
});
