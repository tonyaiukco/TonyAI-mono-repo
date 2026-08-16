import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, HttpStatus } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

/**
 * CI runs typecheck + build + `pnpm test` only — E2E is deliberately out of the
 * turbo pipeline until Phase 2. So anything covered by E2E alone has no CI
 * gate, and deleting the 413 branch passed every unit test.
 */
function run(exception: unknown) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', url: '/api/v1/subsidiaries' }),
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
