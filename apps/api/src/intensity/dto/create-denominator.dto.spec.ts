import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { INTENSITY_METRIC_KEYS } from '@tonyai/shared-types';
import { CreateDenominatorDto } from './create-denominator.dto';

/**
 * Nothing tested that a denominator round-trips through the API, so a metric
 * added to the shared union while this DTO kept its own hand-written copy was
 * offered by the UI, written by the seed, and rejected on save — with typecheck
 * and the whole unit suite green.
 */
function parse(body: Record<string, unknown>) {
  const dto = plainToInstance(CreateDenominatorDto, {
    subsidiaryId: 'sub-1',
    year: 2026,
    value: 100,
    unit: 'MWh',
    ...body,
  });
  return validateSync(dto);
}

describe('CreateDenominatorDto — metric', () => {
  it.each(INTENSITY_METRIC_KEYS)('accepts every metric the contract declares: %s', (metric) => {
    expect(parse({ metric })).toHaveLength(0);
  });

  it('rejects a metric that is not in the contract', () => {
    const errors = parse({ metric: 'moon_phase' });
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0].constraints ?? {})).toContain('isIn');
  });
});
