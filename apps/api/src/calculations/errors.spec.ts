import { describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { CALCULATION_REFUSAL_CODES, CALCULATION_REFUSAL_STATUS } from '@tonyai/shared-types';
import { toErrorBody } from '../common/api-error';
import {
  CalculationInputError,
  COVERAGE_REFUSAL_CODES,
  FactorLibraryConflictError,
  INPUT_REFUSAL_CODES,
  LIBRARY_REFUSAL_CODES,
  NoEmissionFactorError,
} from './errors';

const COVERAGE = { category: 'Fuel', activityType: 'diesel', geographyCode: 'UK', reportingYear: 2026, unit: 'litres' };

describe('calculation refusal classes', () => {
  it('split the contract codes exactly, each into the class its status names', () => {
    expect([...INPUT_REFUSAL_CODES, ...COVERAGE_REFUSAL_CODES, ...LIBRARY_REFUSAL_CODES].sort()).toEqual(
      [...CALCULATION_REFUSAL_CODES].sort(),
    );
    for (const code of INPUT_REFUSAL_CODES) {
      const e = new CalculationInputError(code, 'm');
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.getStatus()).toBe(CALCULATION_REFUSAL_STATUS[code]);
    }
    for (const code of COVERAGE_REFUSAL_CODES) {
      const e = new NoEmissionFactorError('m', { code });
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      // Never a NotFoundException: a catch that maps 404s to "not yours"
      // (the bulk paths) must not swallow a library gap.
      expect(e).not.toBeInstanceOf(NotFoundException);
      expect(e.getStatus()).toBe(422);
      expect(e.getStatus()).toBe(CALCULATION_REFUSAL_STATUS[code]);
    }
    for (const code of LIBRARY_REFUSAL_CODES) {
      const e = new FactorLibraryConflictError(code, 'm');
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getStatus()).toBe(CALCULATION_REFUSAL_STATUS[code]);
    }
  });

  it('carry the machine code in the body, beside the sentence every reader shows', () => {
    expect(new CalculationInputError('activity_type_required', 'Name it.').getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Name it.',
      code: 'activity_type_required',
    });
    expect(new FactorLibraryConflictError('ambiguous_factor', 'Two.').getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'Two.',
      code: 'ambiguous_factor',
    });
  });

  it('give a coverage refusal its lookup only when the engine supplies one', () => {
    expect(new NoEmissionFactorError('No factor.', { code: 'placeholder_refused', coverage: COVERAGE }).getResponse()).toEqual({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'No factor.',
      code: 'placeholder_refused',
      coverage: COVERAGE,
    });
    expect(new NoEmissionFactorError('No factor.').getResponse()).toEqual({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'No factor.',
      code: 'no_factor',
    });
  });

  // Decisions 2026-11-20, D4: the map and the class change together. The
  // error filter keeps a code only at its registered status, so reverting
  // either half alone strips the coverage code to the generic one.
  it('keep every coverage code and its lookup through the error filter', () => {
    for (const code of COVERAGE_REFUSAL_CODES) {
      const thrown = new NoEmissionFactorError('No factor.', { code, coverage: COVERAGE });
      const body = toErrorBody(thrown.getStatus(), thrown.getResponse());
      expect(body).toMatchObject({ statusCode: 422, error: 'Unprocessable Entity', code, coverage: COVERAGE });
    }
  });

  it('keep the one-string constructor the bulk importer and its specs use', () => {
    const e = new NoEmissionFactorError('No emission factor found for category "Waste"');
    expect(e.message).toBe('No emission factor found for category "Waste"');
    expect(e.code).toBe('no_factor');
    expect(e.coverage).toBeUndefined();
  });
});
