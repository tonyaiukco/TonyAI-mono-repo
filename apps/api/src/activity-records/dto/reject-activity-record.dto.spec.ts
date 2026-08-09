import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { RejectActivityRecordDto } from './reject-activity-record.dto';

/**
 * FR §6.5 requires a rejection to say why, because the reason is shown to the
 * submitter. The browser's disabled button is not the enforcement point — curl
 * and any second client bypass it — so these assert the rule at the DTO.
 */
function parse(body: Record<string, unknown>) {
  const dto = plainToInstance(RejectActivityRecordDto, body);
  return { dto, errors: validateSync(dto) };
}

describe('RejectActivityRecordDto', () => {
  it('accepts a real reason and trims it', () => {
    const { dto, errors } = parse({ varianceReason: '  meter reading missing  ' });
    expect(errors).toHaveLength(0);
    expect(dto.varianceReason).toBe('meter reading missing');
  });

  it('rejects a whitespace-only reason', () => {
    // Previously 200: MinLength(1) counted the spaces, storing a blank note that
    // rendered as an empty "Reviewer's Note" panel to the submitter.
    const { errors } = parse({ varianceReason: '   ' });
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0].constraints ?? {})).toContain('minLength');
  });

  it('rejects a missing reason', () => {
    const { errors } = parse({});
    expect(errors).toHaveLength(1);
  });

  it('bounds the reason', () => {
    // The column is unbounded `text` and the value is now rendered verbatim on
    // the submitter's screen; 90k characters stored fine before this.
    const { errors } = parse({ varianceReason: 'x'.repeat(2001) });
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0].constraints ?? {})).toContain('maxLength');
  });

  it('accepts a reason at the limit', () => {
    const { errors } = parse({ varianceReason: 'x'.repeat(2000) });
    expect(errors).toHaveLength(0);
  });
});
