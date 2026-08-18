// The decorators need the metadata shim that `main.ts` normally loads.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { VoidActivityRecordDto } from './void-activity-record.dto';

/**
 * The reason on this DTO is the entire compliance justification for removing a
 * reviewed figure from a reported inventory. It is also unusually unforgiving:
 * `voided` is terminal and `audit_log` is append-only, so whatever passes
 * validation here is written to both and can never be corrected through the
 * product.
 */
function parse(body: unknown) {
  const dto = plainToInstance(VoidActivityRecordDto, body);
  return { dto, errors: validateSync(dto as object) };
}

describe('VoidActivityRecordDto', () => {
  it('accepts a real explanation, trimmed', () => {
    const { dto, errors } = parse({
      voidReason: '  Duplicate of the site invoice for January  ',
    });
    expect(errors).toHaveLength(0);
    expect(dto.voidReason).toBe('Duplicate of the site invoice for January');
  });

  it('refuses whitespace that only LOOKS long enough', () => {
    // Ten spaces satisfied `MinLength(10)` before the trim was added. The
    // result would have been a permanently blank justification on the row AND
    // in the append-only audit diff — the one field that explains why a figure
    // left the inventory, empty and uncorrectable.
    const { errors } = parse({ voidReason: '          ' });
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0].constraints ?? {})).toContain('minLength');
  });

  it('refuses a token gesture', () => {
    // "fix" is not an account of a restatement.
    expect(parse({ voidReason: 'fix' }).errors).toHaveLength(1);
    expect(parse({ voidReason: '' }).errors).toHaveLength(1);
  });

  it('refuses a missing or non-string reason rather than voiding silently', () => {
    expect(parse({}).errors).toHaveLength(1);
    expect(parse({ voidReason: 12345678901 }).errors).toHaveLength(1);
    expect(parse({ voidReason: null }).errors).toHaveLength(1);
  });

  it('bounds the field, which is unbounded text in Postgres', () => {
    expect(parse({ voidReason: 'x'.repeat(2000) }).errors).toHaveLength(0);
    expect(parse({ voidReason: 'x'.repeat(2001) }).errors).toHaveLength(1);
  });
});
