// The decorators need the metadata shim that `main.ts` normally loads.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ReleaseParametersQueryDto } from './release-parameters-query.dto';

/**
 * `GET /api/v1/factors/parameters`'s query (ng-kwh-form): the optional unit
 * reaches the factor lookup, so only a vocabulary unit gets through.
 */
const VALID = { category: 'Natural Gas', geographyCode: 'TR', year: '2025' };

/** The global pipe's validator options (`main.ts`). */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

function errorsOn(query: Record<string, unknown>, property: string) {
  const dto = plainToInstance(ReleaseParametersQueryDto, { ...VALID, ...query });
  return validateSync(dto as object, PIPE_OPTIONS).filter((e) => e.property === property);
}

describe('ReleaseParametersQueryDto: unit', () => {
  it.each([['no unit', {}], ['kWh', { unit: 'kWh' }], ['MWh', { unit: 'MWh' }], ['Sm³', { unit: 'standard_cubic_metres' }]])(
    'accepts %s',
    (_case, query) => {
      expect(errorsOn(query, 'unit')).toEqual([]);
    },
  );

  it.each(['kwh_gas', 'kW h', '', 'KWH'])('refuses %j, which is not a vocabulary unit', (unit) => {
    expect(Object.keys(errorsOn({ unit }, 'unit')[0]?.constraints ?? {})).toContain('isIn');
  });
});
