import { HttpException } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import { describe, expect, it } from 'vitest';
import { errorCodeOf } from '../common/api-error';
import { treeTriggerRefusal } from './tree-errors';

/** A trigger's RAISE on a model query, framed as Prisma 6's engine reports it. */
const modelQuery = (sqlstate: string, message: string) =>
  new Prisma.PrismaClientUnknownRequestError(
    `Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${sqlstate}", message: "${message}", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
    { clientVersion: 'test' },
  );
/** The same RAISE on a raw query: P2010 with both in `meta`. */
const rawQuery = (code: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError('Raw query failed', { code: 'P2010', clientVersion: 'test', meta: { code, message } });

const codeOf = (e: HttpException | null) => (e === null ? null : errorCodeOf(e));

describe('treeTriggerRefusal (inc26-group-tree, TA018–TA022)', () => {
  it.each([
    ['TA018', 'node_placement_invalid: x', 'node_placement_invalid', 400],
    ['TA018', 'node_type_fixed: x', 'node_type_fixed', 400],
    ['TA018', 'tree_cycle: x', 'tree_cycle', 409],
    ['TA018', 'node_move_blocked: x', 'node_move_blocked', 409],
    ['TA018', 'control_change_blocked: x', 'control_change_blocked', 409],
    ['TA019', 'entity_closed_to_data_entry: x', 'entity_closed_to_data_entry', 409],
    ['TA020', 'subsidiary_not_assignable: x', 'subsidiary_not_assignable', 409],
    ['TA021', 'node_placement_invalid: x', 'node_placement_invalid', 400],
    ['TA022', 'boundary_subsidiary_not_reportable: x', 'boundary_subsidiary_not_reportable', 409],
  ])('%s "%s" answers %s (%d), on a model query and on a raw one', (sqlstate, message, code, status) => {
    for (const e of [modelQuery(sqlstate, message), rawQuery(sqlstate, message)]) {
      const mapped = treeTriggerRefusal(e);
      expect(codeOf(mapped)).toBe(code);
      expect(mapped?.getStatus()).toBe(status);
    }
  });

  it('a code raised under another trigger\'s SQLSTATE is not trusted', () => {
    for (const [sqlstate, message] of [
      ['TA019', 'tree_cycle: x'],
      ['TA020', 'entity_closed_to_data_entry: x'],
      ['TA021', 'subsidiary_not_assignable: x'],
      ['TA022', 'node_placement_invalid: x'],
      ['TA018', 'boundary_subsidiary_not_reportable: x'],
      ['TA014', 'tree_cycle: x'],
    ]) {
      expect(treeTriggerRefusal(modelQuery(sqlstate, message)), `${sqlstate} ${message}`).toBeNull();
      expect(treeTriggerRefusal(rawQuery(sqlstate, message)), `${sqlstate} ${message}`).toBeNull();
    }
  });

  it('reads the code only from the engine\'s own framing, never from text elsewhere in the message', () => {
    const spoofed = new Prisma.PrismaClientUnknownRequestError(
      'Invalid value "PostgresError { code: \\"TA018\\", message: \\"tree_cycle: x" for column name',
      { clientVersion: 'test' },
    );
    expect(treeTriggerRefusal(spoofed)).toBeNull();
    expect(treeTriggerRefusal(modelQuery('TA018', 'something else entirely'))).toBeNull();
    expect(treeTriggerRefusal(new Error('tree_cycle: x'))).toBeNull();
    expect(treeTriggerRefusal(rawQuery('TA018', 'not a code'))).toBeNull();
    expect(treeTriggerRefusal(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2003', clientVersion: 'test', meta: { code: 'TA018', message: 'tree_cycle: x' } }))).toBeNull();
  });

  it('a raced control_change_blocked names the kinds the trigger checks', () => {
    const message = String((treeTriggerRefusal(modelQuery('TA018', 'control_change_blocked: x'))!.getResponse() as { message: string }).message);
    for (const kind of ['record', 'assign', 'child']) expect(message.toLowerCase()).toContain(kind);
  });
});
