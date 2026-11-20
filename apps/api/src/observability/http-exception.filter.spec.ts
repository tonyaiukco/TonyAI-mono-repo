import { afterEach, describe, it, expect, vi } from 'vitest';
import { BadRequestException, HttpStatus } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';
import { NoEmissionFactorError } from '../calculations/errors';
import { captureException } from './sentry';
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
afterEach(() => vi.clearAllMocks());

/**
 * CI runs typecheck + build + `pnpm test` only — E2E is deliberately out of the
 * turbo pipeline until Phase 2. So anything covered by E2E alone has no CI
 * gate, and deleting the 413 branch passed every unit test.
 */
function run(exception: unknown, url = '/api/v1/subsidiaries') {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', url }),
      getResponse: () => ({ status, headersSent: false }),
    }),
  };
  const logger = { event: vi.fn() };
  new HttpExceptionFilter(logger as never).catch(exception, host as never);
  return { status, json, logger };
}

describe('HttpExceptionFilter — oversized bodies', () => {
  it('maps body-parser\'s entity.too.large to 413, not 500', () => {
    // body-parser throws before any Nest middleware, so this arrives as a plain
    // Error with no request context. Collapsed to 500 it was logged at ERROR
    // and shipped to Sentry as a defect — for a client sending too much.
    const err = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
    });

    const { status, json, logger } = run(err);

    expect(status).toHaveBeenCalledWith(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(json.mock.calls[0][0].message).toMatch(/smaller batches/);
    // 4xx is an expected outcome: warn, and no Sentry report. The filter keys
    // both off the status, so getting the status right is what demotes it.
    expect(logger.event.mock.calls[0][0]).toBe('warn');
  });

  it('still collapses an unrecognised throw to 500', () => {
    const { status, logger } = run(new Error('something else'));
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(logger.event.mock.calls[0][0]).toBe('error');
  });

  it('leaves a real HttpException alone', () => {
    const { status } = run(new BadRequestException('nope'));
    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
  });
});

 it('removes query data from error logs and Sentry path tags', () => {
  const error = new Error('Synthetic failure');
  const { logger } = run(error, '/api/v1/evidence?subsidiaryId=private-marker');
  expect(JSON.stringify(logger.event.mock.calls)).not.toContain('private-marker');
  expect(captureException).toHaveBeenCalledWith(error, expect.objectContaining({ path: '/api/v1/evidence' }));
});

describe('HttpExceptionFilter — calculation coverage refusals (calc-refusal-422)', () => {
  // The wire answer, end to end through the filter: the status map and the
  // thrown class must agree, or the filter strips the code to a generic one.
  it.each(['no_factor', 'placeholder_refused', 'no_conversion', 'calorific_basis_mismatch'] as const)(
    'answers %s with 422, its code and its coverage, logged as a warning',
    (code) => {
      const coverage = { category: 'Electricity', activityType: 'grid_electricity', geographyCode: 'UK', reportingYear: 2031, unit: 'kWh' };
      const { status, json, logger } = run(new NoEmissionFactorError('No emission factor found', { code, coverage }), '/api/v1/activity-records');
      expect(status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(json.mock.calls[0][0]).toMatchObject({ statusCode: 422, code, coverage });
      expect(logger.event.mock.calls[0][0]).toBe('warn');
      expect(captureException).not.toHaveBeenCalled();
    },
  );
});
