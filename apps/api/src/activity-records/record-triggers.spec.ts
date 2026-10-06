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

/** The guarded table's owner, as the triggers look it up. */
const OWNER = '(SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID)';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    // ON DELETE SET NULL, which PostgreSQL runs as the table's owner.
    expect(body).toContain(`NEW."location_id" IS NOT NULL OR current_user <> ${OWNER}`);
    // The owner lookup is its one query; no SECURITY DEFINER.
    expect(body.match(/SELECT /g)).toHaveLength(1);
    expect(body).not.toContain('SECURITY DEFINER');
  });

  it('K5 freezes the id in every status, before it looks at the status at all', () => {
    const body = functionBody('activity_records_snapshot_immutable');
    const id = body.indexOf('IF NEW."id" IS DISTINCT FROM OLD."id" THEN');
    expect(id).toBeGreaterThan(-1);
    expect(id).toBeLessThan(body.indexOf('OLD."status" NOT IN'));
  });

  it('never trusts pg_trigger_depth(), which any role can raise with a temp-table trigger — only the owner, as a cascade runs', () => {
    for (const name of ['activity_records_snapshot_immutable', 'activity_records_committed_delete', 'activity_records_slot_kind']) {
      expect(functionBody(name), name).not.toContain('pg_trigger_depth');
    }
    const del = functionBody('activity_records_committed_delete');
    expect(del).toMatch(new RegExp(`OLD\\."status" NOT IN \\('draft', 'rejected'\\)\\s+AND current_user <> ${escape(OWNER)} THEN`));
  });

  it('the slot rule steps aside only for a restore\'s inserts (replica mode, the owner\'s alone)', () => {
    const body = functionBody('activity_records_slot_kind');
    expect(body).toContain(`IF TG_OP = 'INSERT' AND pg_catalog.current_setting('session_replication_role') = 'replica' THEN\n    RETURN NEW;`);
    expect(body.match(/session_replication_role/g)).toHaveLength(1);
  });

  it("K5 allows exactly the review lifecycle's status changes — the API's gates, and nothing a rewind needs", () => {
    const body = functionBody('activity_records_snapshot_immutable');
    const list = /= ANY \(ARRAY\[([^\]]*)\]\)/.exec(body)?.[1] ?? '';
    const allowed = [...list.matchAll(/'([a-z_]+>[a-z_]+)'/g)].map((m) => m[1]).sort();
    // Each from the service's own gate: submit (draft | rejected), startReview
    // (submitted), approve and reject (submitted | under_review), void
    // (approved), and the period lock's bulk lock and unlock.
    expect(allowed).toEqual(
      [
        'draft>submitted', 'rejected>submitted',
        'submitted>under_review',
        'submitted>approved', 'under_review>approved',
        'submitted>rejected', 'under_review>rejected',
        'approved>voided', 'approved>locked', 'locked>approved',
      ].sort(),
    );
    // Nothing enters draft after creation; every way back to an editable
    // status passes through review's rejection.
    expect(allowed.filter((t) => t.endsWith('>draft'))).toEqual([]);
    expect(allowed.filter((t) => [...EDITABLE_STATUSES].some((e) => t.endsWith(`>${e}`)))).toEqual([
      'submitted>rejected',
      'under_review>rejected',
    ]);
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
