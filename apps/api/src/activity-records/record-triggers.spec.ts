/**
 * The `activity_records` triggers as the migrations leave them (LP3-03, and
 * LP4-01's K5 without the location exemption), read as text and pinned to the
 * API they back: K5's editable statuses are the service's EDITABLE_STATUSES,
 * the SQLSTATEs are the ones `recordTriggerCode` maps, and the slot-kind check
 * compares exactly the unique index's first six columns. A drift in either
 * place fails here, in `pnpm test`, before `test:int`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDITABLE_STATUSES } from './activity-records.service';

const migrations = resolve(__dirname, '../../../../packages/db/prisma/migrations');
const dirs = readdirSync(migrations).filter((d) => /^\d/.test(d)).sort();
const read = (d: string) => readFileSync(join(migrations, d, 'migration.sql'), 'utf8');
const sql = read(dirs.find((d) => d.endsWith('_lp3_03_factor_model')) ?? 'missing');
const lp401 = read(dirs.find((d) => d.endsWith('_lp4_01_cascade_guard')) ?? 'missing');

/** The guarded table's owner, as the triggers look it up. */
const OWNER = '(SELECT pg_catalog.pg_get_userbyid(c."relowner") FROM "pg_catalog"."pg_class" c WHERE c."oid" = TG_RELID)';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The body the LAST definition of `name` gives it — the last migration that
 * defines it, and the last definition inside that one: what the database runs,
 * read the way `runtime-role.mjs`'s `expectedTriggerFunctionBodies` reads it.
 */
function functionBody(name: string): string {
  let body: string | undefined;
  const definition = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION "public"\\."${name}"\\(\\)`, 'g');
  for (const d of dirs) {
    const text = read(d);
    for (const m of text.matchAll(definition)) body = text.slice(m.index, text.indexOf('$fn$;', m.index));
  }
  if (body === undefined) throw new Error(`no function ${name}`);
  return body;
}

describe('the activity_records integrity triggers', () => {
  it('K5 lets exactly EDITABLE_STATUSES change a snapshot', () => {
    const body = functionBody('activity_records_snapshot_immutable');
    const list = /OLD\."status" NOT IN \(([^)]*)\)/.exec(body)?.[1] ?? '';
    const statuses = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(statuses.sort()).toEqual([...EDITABLE_STATUSES].sort());
  });

  it('K5 tests OLD, and guards the snapshot and every input it was computed from — its site included, for every writer', () => {
    const body = functionBody('activity_records_snapshot_immutable');
    expect(body).toContain('CREATE OR REPLACE FUNCTION'); // LP4-01's, not LP3-03's
    for (const column of [
      'calculation', 'activity_type', 'category', 'activity_value', 'activity_unit', 'scope',
      'reporting_year', 'reporting_period', 'period_value', 'subsidiary_id', 'location_id',
    ]) {
      expect(body).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`);
    }
    // LP4-01: the site's key is RESTRICT, so no ON DELETE SET NULL detaches
    // it, and no writer — the owner included — is exempt any more.
    expect(body).not.toContain('current_user');
    expect(body).not.toContain('SELECT ');
    expect(body).not.toContain('SECURITY DEFINER');
  });

  it("LP4-01 changes only K5's location test: otherwise LP3-03's body, word for word", () => {
    const original = sql.slice(
      sql.indexOf('CREATE FUNCTION "public"."activity_records_snapshot_immutable"()'),
      sql.indexOf('$fn$;', sql.indexOf('CREATE FUNCTION "public"."activity_records_snapshot_immutable"()')),
    );
    const current = functionBody('activity_records_snapshot_immutable');
    const lines = (text: string) => text.split('\n').slice(1); // past the CREATE line
    const removed = lines(original).filter((l) => !lines(current).includes(l));
    const added = lines(current).filter((l) => !lines(original).includes(l));
    expect(removed).toEqual([
      '    OR (NEW."location_id" IS DISTINCT FROM OLD."location_id"',
      `        AND (NEW."location_id" IS NOT NULL OR current_user <> ${OWNER}))`,
    ]);
    expect(added).toEqual(['    OR NEW."location_id" IS DISTINCT FROM OLD."location_id"']);
  });

  it("LP4-01: every parent key refuses a delete and a key change, so no referential action — which runs as the owner — writes a record", () => {
    expect(lp401).toMatch(
      /ADD CONSTRAINT "activity_records_location_id_subsidiary_id_fkey"\s+FOREIGN KEY \("location_id", "subsidiary_id"\) REFERENCES "locations"\("id", "subsidiary_id"\) ON DELETE RESTRICT ON UPDATE RESTRICT;/,
    );
    expect(lp401).toMatch(
      /ADD CONSTRAINT "activity_records_subsidiary_id_fkey"\s+FOREIGN KEY \("subsidiary_id"\) REFERENCES "subsidiaries"\("id"\) ON DELETE RESTRICT ON UPDATE RESTRICT;/,
    );
    expect(lp401).toMatch(
      /ADD CONSTRAINT "activity_records_import_batch_id_fkey"\s+FOREIGN KEY \("import_batch_id"\) REFERENCES "import_batches"\("id"\) ON DELETE NO ACTION ON UPDATE NO ACTION;/,
    );
    expect(lp401).toContain('DROP CONSTRAINT "activity_records_location_id_fkey";');
  });

  it("LP4-01: a record is born with the status the service creates, and only the API's login or the owner moves it", () => {
    // `create` writes ActivityRecordStatus.draft and nothing else; the
    // lifecycle's moves (submit, review, approve, reject, void, lock, unlock)
    // run on the API's DATABASE_URL — the runtime login, `tonyai_runtime`.
    const body = functionBody('activity_records_lifecycle_writer');
    const born = [...(/IF NEW\."status" <> '([a-z_]+)'/.exec(body) ?? [])][1];
    expect(born).toBe('draft');
    expect([...EDITABLE_STATUSES]).toContain(born);
    expect(body).toMatch(/AND session_user <> 'tonyai_runtime'/);
    expect(body).toContain("ERRCODE = 'TA005'");
    expect(body).not.toContain('current_user');
    expect(lp401).toContain('ENABLE ALWAYS TRIGGER "activity_records_lifecycle_writer"');
  });

  it('K5 freezes the id in every status, before it looks at the status at all', () => {
    const body = functionBody('activity_records_snapshot_immutable');
    const id = body.indexOf('IF NEW."id" IS DISTINCT FROM OLD."id" THEN');
    expect(id).toBeGreaterThan(-1);
    expect(id).toBeLessThan(body.indexOf('OLD."status" NOT IN'));
  });

  it('never trusts pg_trigger_depth(), which any role can raise with a temp-table trigger — only the owner itself deletes a committed record', () => {
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
