// The decorators need the metadata shim that `main.ts` normally loads; this is
// the first spec in the suite to exercise a DTO rather than a service.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
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
    const { errors } = parse({ status: '' });
    expect(errors).toHaveLength(1);
  });

  it('rejects an unknown status, even alongside valid ones', () => {
    const { errors } = parse({ status: 'submitted,pending' });
    expect(errors).toHaveLength(1);
  });

  it('rejects a set longer than the number of statuses that exist', () => {
    const { errors } = parse({
      status: 'draft,draft,draft,draft,draft,draft,draft',
    });
    expect(errors).toHaveLength(1);
  });
});
