// The decorators need the metadata shim that `main.ts` normally loads; this is
// the first spec in the suite to exercise a DTO rather than a service.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_RECORD_STATUSES } from '@tonyai/shared-types';
import { ActivityRecordFiltersQueryDto, ActivityRecordPageQueryDto } from './activity-record-page-query.dto';

/**
 * The status filter is the one query param that changed shape for the reviewer
 * queue: it now carries a SET over the wire. These assert the two failure modes
 * that matter — a filter that silently disappears (the caller believes they
 * narrowed the list and gets everything) and one that silently widens.
 */
function parse(query: Record<string, unknown>) {
  const dto = plainToInstance(ActivityRecordPageQueryDto, query);
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }) };
}
const constraintsOf = (errors: ReturnType<typeof parse>['errors']) =>
  errors.flatMap((e) => Object.keys(e.constraints ?? {}));

describe('ActivityRecordPageQueryDto — status', () => {
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

describe('ActivityRecordPageQueryDto — the page (LP4-05 contract)', () => {
  it('reads limit, cursor and sort', () => {
    const { dto, errors } = parse({ limit: '100', cursor: 'abc', sort: 'review_queue' });
    expect(errors).toHaveLength(0);
    expect(dto).toMatchObject({ limit: 100, cursor: 'abc', sort: 'review_queue' });
  });

  it.each([
    ['zero', '0'], ['over the maximum', '101'], ['a fraction', '1.5'], ['an exponent', '1e2'],
    ['hexadecimal', '0x10'], ['padded', ' 5'], ['empty', ''], ['repeated', ['5', '6']], ['negative', '-1'],
  ])('refuses a limit that is %s — never clamped or corrected', (_label, limit) => {
    expect(parse({ limit }).errors.length).toBeGreaterThan(0);
  });

  it.each([['empty', ''], ['over 2,048 characters', 'a'.repeat(2049)], ['repeated', ['a', 'b']]])(
    'refuses a cursor that is %s',
    (_label, cursor) => {
      expect(parse({ cursor }).errors.length).toBeGreaterThan(0);
    },
  );

  it('refuses an unknown sort', () => {
    expect(constraintsOf(parse({ sort: 'oldest' }).errors)).toContain('isIn');
  });
});

describe('ActivityRecordPageQueryDto — the added filters', () => {
  const id = '6F9619FF-8B86-D011-B42D-00C04FC964FF';

  it('lowercases a subsidiary id and refuses one that is not an id', () => {
    expect(parse({ subsidiaryId: id }).dto.subsidiaryId).toBe(id.toLowerCase());
    expect(parse({ subsidiaryId: 'sub-1' }).errors).toHaveLength(1);
    expect(parse({ subsidiaryId: '' }).errors).toHaveLength(1);
  });

  it('reads locationId=none as company-level (null), an id as that site, and refuses anything else', () => {
    expect(parse({ locationId: 'none' })).toMatchObject({ dto: { locationId: null }, errors: [] });
    expect(parse({ locationId: id }).dto.locationId).toBe(id.toLowerCase());
    expect(parse({ locationId: '' }).errors).toHaveLength(1);
    expect(parse({ locationId: 'NONE' }).errors).toHaveLength(1);
    expect(parse({}).dto.locationId).toBeUndefined();
  });

  it('accepts a period value only with its period, in any case', () => {
    expect(parse({ period: 'monthly', periodValue: 'january' }).errors).toHaveLength(0);
    expect(constraintsOf(parse({ periodValue: 'January' }).errors)).toContain('periodValueOfPeriod');
    expect(constraintsOf(parse({ period: 'quarterly', periodValue: 'January' }).errors)).toContain('periodValueOfPeriod');
  });

  it('accepts scope 1-3 only', () => {
    expect(parse({ scope: '2' }).dto.scope).toBe(2);
    expect(parse({ scope: '4' }).errors).toHaveLength(1);
    expect(parse({ scope: 'two' }).errors).toHaveLength(1);
  });

  it('refuses a control character in the search — a NUL would otherwise be Postgres\'s 500', () => {
    for (const code of [0x00, 0x09, 0x0a, 0x1f, 0x7f]) {
      expect(constraintsOf(parse({ search: `a${String.fromCharCode(code)}b` }).errors), `U+${code.toString(16)}`).toContain('noControlCharacters');
    }
    expect(parse({ search: 'Şirket % _ \\ ğüç' }).errors).toHaveLength(0);
  });

  it('bounds the search at 200 characters', () => {
    expect(parse({ search: 'x'.repeat(200) }).errors).toHaveLength(0);
    expect(constraintsOf(parse({ search: 'x'.repeat(201) }).errors)).toContain('maxLength');
  });

  it('refuses an unknown filter rather than ignoring it', () => {
    expect(parse({ subsidiary: id }).errors).toHaveLength(1);
  });
});

describe('ActivityRecordFiltersQueryDto (metadata)', () => {
  it.each([['limit', '5'], ['cursor', 'abc'], ['sort', 'newest']])('refuses the page key %s', (key, value) => {
    const dto = plainToInstance(ActivityRecordFiltersQueryDto, { [key]: value });
    expect(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(1);
  });
});
