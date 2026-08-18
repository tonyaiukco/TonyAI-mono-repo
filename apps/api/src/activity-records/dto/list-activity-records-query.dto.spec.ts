// The decorators need the metadata shim that `main.ts` normally loads; this is
// the first spec in the suite to exercise a DTO rather than a service.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_RECORD_STATUSES } from '@tonyai/shared-types';
import { ListActivityRecordsQueryDto } from './list-activity-records-query.dto';

/**
 * The status filter is the one query param that changed shape for the reviewer
 * queue: it now carries a SET over the wire. These assert the two failure modes
 * that matter — a filter that silently disappears (the caller believes they
 * narrowed the list and gets everything) and one that silently widens.
 */
function parse(query: Record<string, unknown>) {
  const dto = plainToInstance(ListActivityRecordsQueryDto, query);
  return { dto, errors: validateSync(dto, { whitelist: true }) };
}

describe('ListActivityRecordsQueryDto — status', () => {
  it('accepts a comma-separated set and normalises it to an array', () => {
    const { dto, errors } = parse({ status: 'submitted,under_review' });
    expect(errors).toHaveLength(0);
    expect(dto.status).toEqual(['submitted', 'under_review']);
  });

  it('tolerates whitespace around the separators', () => {
    const { dto, errors } = parse({ status: 'submitted , under_review' });
    expect(errors).toHaveLength(0);
    expect(dto.status).toEqual(['submitted', 'under_review']);
  });

  it('still accepts a single value (every pre-existing caller)', () => {
    const { dto, errors } = parse({ status: 'draft' });
    expect(errors).toHaveLength(0);
    expect(dto.status).toEqual(['draft']);
  });

  it('leaves status undefined when absent, rather than an empty set', () => {
    const { dto, errors } = parse({});
    expect(errors).toHaveLength(0);
    expect(dto.status).toBeUndefined();
  });

  it('rejects an empty string instead of treating it as "no filter"', () => {
    // `toHaveLength(1)` counts ValidationError OBJECTS — at most one per
    // property however many constraints fire — so it cannot tell you which rule
    // caught this. Naming the constraint is the difference between a test that
    // defends a behaviour and one that merely observes a 400.
    const { errors } = parse({ status: '' });
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0].constraints ?? {})).toContain('isIn');
  });

  it('rejects an unknown status, even alongside valid ones', () => {
    const { errors } = parse({ status: 'submitted,pending' });
    expect(errors).toHaveLength(1);
  });

  it('accepts a filter naming every status that exists', () => {
    // The upper bound alone left the limit free to be NARROWED without a test
    // failing — and a limit one short silently 400s a legitimate "show me
    // everything" filter. Both edges are pinned now, and both derive from the
    // enum so neither goes stale when a status is added.
    const { errors } = parse({ status: ACTIVITY_RECORD_STATUSES.join(',') });
    expect(errors).toHaveLength(0);
  });

  it('rejects a set longer than the number of statuses that exist', () => {
    // DERIVED from the enum, not a hardcoded run of sevens. The literal version
    // silently stopped testing anything the moment `voided` was added: seven
    // entries went from over the limit to exactly at it, and the assertion
    // failed rather than passing vacuously only because it expected an error.
    const { errors } = parse({
      status: new Array(ACTIVITY_RECORD_STATUSES.length + 1).fill('draft').join(','),
    });
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0].constraints ?? {})).toContain('arrayMaxSize');
  });

  it('rejects an unknown CATEGORY rather than returning an empty list', () => {
    // A typo'd category used to be `@IsString()` — a silently empty result to a
    // caller who believed they had narrowed the list.
    const { errors } = parse({ category: 'Electrcity' });
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0].constraints ?? {})).toContain('isIn');
  });
});
