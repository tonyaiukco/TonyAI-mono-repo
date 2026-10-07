import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { ArgumentsHost, CallHandler, ExecutionContext } from '@nestjs/common';
import { of, throwError, lastValueFrom } from 'rxjs';
import { JsonLogger } from './json-logger';
import { LoggingInterceptor } from './logging.interceptor';
import { HttpExceptionFilter } from './http-exception.filter';
import { RequestContextMiddleware } from './request-context.middleware';
import { currentRequestContext } from './request-context';

// --- Test doubles ----------------------------------------------------------

function createLogger() {
  const events: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const logger = new JsonLogger('json');
  vi.spyOn(logger, 'event').mockImplementation((level, message, fields) => {
    events.push({ level, message, fields });
  });
  return { logger, events };
}

function createHost(
  request: Record<string, unknown>,
  response: Record<string, unknown>,
): ArgumentsHost {
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
}

function createResponse() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: vi.fn(),
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  return { res, sent };
}

function createContext(request: Record<string, unknown>, response: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

const handler = (value: unknown = { ok: true }): CallHandler => ({
  handle: () => of(value),
});

// --- Request context middleware --------------------------------------------

describe('RequestContextMiddleware', () => {
  it('mints a request id, echoes it in the header and exposes it to the async context', () => {
    const mw = new RequestContextMiddleware();
    const req: Record<string, unknown> = { headers: {} };
    const res = { setHeader: vi.fn() };
    let seen: string | undefined;

    mw.use(req as never, res as never, () => {
      seen = currentRequestContext()?.requestId;
    });

    expect(seen).toBeTruthy();
    expect(req.requestId).toBe(seen);
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', seen);
  });

  it('honours an inbound x-request-id so upstream traces stay stitched', () => {
    const mw = new RequestContextMiddleware();
    const req: Record<string, unknown> = { headers: { 'x-request-id': 'trace-abc' } };
    let seen: string | undefined;
    mw.use(req as never, { setHeader: vi.fn() } as never, () => {
      seen = currentRequestContext()?.requestId;
    });
    expect(seen).toBe('trace-abc');
  });

  it('ignores an absurdly long inbound id (header-stuffing guard)', () => {
    const mw = new RequestContextMiddleware();
    const req: Record<string, unknown> = { headers: { 'x-request-id': 'x'.repeat(500) } };
    let seen: string | undefined;
    mw.use(req as never, { setHeader: vi.fn() } as never, () => {
      seen = currentRequestContext()?.requestId;
    });
    expect(seen).not.toBe('x'.repeat(500));
    expect(seen).toHaveLength(36); // uuid
  });
});

// --- Logging interceptor ----------------------------------------------------

describe('LoggingInterceptor', () => {
  it('logs one line per request with method, path, status, duration and user', async () => {
    const { logger, events } = createLogger();
    const ctx = createContext(
      { method: 'GET', originalUrl: '/api/v1/subsidiaries', user: { id: 'user-1' } },
      { statusCode: 200 },
    );
    await lastValueFrom(new LoggingInterceptor(logger).intercept(ctx, handler()));

    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('request');
    expect(events[0].fields).toMatchObject({
      method: 'GET',
      path: '/api/v1/subsidiaries',
      status: 200,
      userId: 'user-1',
    });
    expect(typeof events[0].fields.durationMs).toBe('number');
  });

  it('does not log health checks (they fire every 30s per container)', async () => {
    const { logger, events } = createLogger();
    const ctx = createContext({ method: 'GET', originalUrl: '/api/v1/health' }, { statusCode: 200 });
    await lastValueFrom(new LoggingInterceptor(logger).intercept(ctx, handler()));
    expect(events).toHaveLength(0);
  });

  it.each(['/api/v1/health/ready', '/api/v1/health/ready?probe=synthetic'])('silences expected readiness 503 at %s', async (path) => {
    const { logger, events } = createLogger();
    const ctx = createContext({ method: 'GET', originalUrl: path }, { statusCode: 503 });
    await lastValueFrom(new LoggingInterceptor(logger).intercept(ctx, handler({ status: 'Not ready' })));
    expect(events).toEqual([]);
  });

  it('omits userId on public routes and leaves failures to the filter', async () => {
    const { logger, events } = createLogger();
    const ctx = createContext({ method: 'POST', originalUrl: '/api/v1/x' }, { statusCode: 201 });
    const failing: CallHandler = { handle: () => throwError(() => new Error('boom')) };

    await expect(
      lastValueFrom(new LoggingInterceptor(logger).intercept(ctx, failing)),
    ).rejects.toThrow('boom');
    expect(events).toHaveLength(0); // HttpExceptionFilter owns error logging

    await lastValueFrom(new LoggingInterceptor(logger).intercept(ctx, handler()));
    expect(events[0].fields.userId).toBeUndefined();
  });
});

// --- Exception filter: the response-shape regression lock -------------------
// LP3-01 added `code` (and an `error` on the 500). Everything Nest sent before
// is still sent, unchanged — the web's `body.message` readers and the e2e
// suite's message assertions depend on that. common/api-error.spec.ts covers
// the codes themselves.

describe('HttpExceptionFilter — Nest\'s body, plus a code', () => {
  let logger: JsonLogger;
  beforeEach(() => {
    logger = createLogger().logger;
  });

  it.each([
    ['BadRequest', new BadRequestException('Category requires evidence'), 400, 'bad_request'],
    ['Forbidden', new ForbiddenException('Only super_admin may manage targets'), 403, 'forbidden'],
    ['Conflict', new ConflictException('Reporting period Q1 2024 is locked'), 409, 'conflict'],
  ])('passes a %s through with its generic code (frontend reads body.message)', (_label, exception, status, code) => {
    const { res, sent } = createResponse();
    new HttpExceptionFilter(logger).catch(
      exception,
      createHost({ method: 'POST', originalUrl: '/api/v1/x' }, res),
    );
    expect(sent.status).toBe(status);
    expect(sent.body).toEqual({ ...((exception as HttpException).getResponse() as object), code });
    expect((sent.body as { message: string }).message).toBe((exception as Error).message);
  });

  it("preserves ValidationPipe's message ARRAY (api.ts joins it for the toast)", () => {
    const { res, sent } = createResponse();
    const validation = new BadRequestException({
      statusCode: 400,
      message: ['year must be an integer', 'template must be one of ...'],
      error: 'Bad Request',
    });
    new HttpExceptionFilter(logger).catch(
      validation,
      createHost({ method: 'GET', originalUrl: '/api/v1/reports/pdf' }, res),
    );
    expect(sent.status).toBe(400);
    expect((sent.body as { message: string[] }).message).toEqual([
      'year must be an integer',
      'template must be one of ...',
    ]);
  });

  it('maps an unknown throw to Nest-shaped 500 without leaking internals', () => {
    const { res, sent } = createResponse();
    new HttpExceptionFilter(logger).catch(
      new Error('connect ECONNREFUSED 127.0.0.1:54322'),
      createHost({ method: 'GET', originalUrl: '/api/v1/kpi' }, res),
    );
    expect(sent.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(sent.body).toEqual({
      statusCode: 500,
      code: 'internal_error',
      message: 'Internal server error',
      error: 'Internal Server Error',
    });
    expect(JSON.stringify(sent.body)).not.toContain('ECONNREFUSED');
  });

  it('never double-sends when a streamed download already wrote headers', () => {
    const { res, sent } = createResponse();
    res.headersSent = true;
    new HttpExceptionFilter(logger).catch(
      new Error('pdf stream died'),
      createHost({ method: 'GET', originalUrl: '/api/v1/reports/pdf' }, res),
    );
    expect(sent.status).toBeUndefined();
    expect(sent.body).toBeUndefined();
  });
});

describe('HttpExceptionFilter — logging levels', () => {
  it('logs 4xx at warn (expected business outcome) and 5xx at error', () => {
    const { logger, events } = createLogger();
    const filter = new HttpExceptionFilter(logger);
    const host = createHost({ method: 'POST', originalUrl: '/api/v1/x' }, createResponse().res);

    filter.catch(new ForbiddenException('nope'), host);
    filter.catch(new Error('kaboom'), createHost({ method: 'GET', originalUrl: '/y' }, createResponse().res));

    expect(events.map((e) => e.level)).toEqual(['warn', 'error']);
    expect(events[0].fields.status).toBe(403);
    expect(events[1].fields.status).toBe(500);
    expect(events[1].fields.stack).toBeTruthy(); // stack only for defects
    expect(events[0].fields.stack).toBeUndefined();
  });
});

// --- JsonLogger -------------------------------------------------------------

describe('JsonLogger', () => {
  let written: string[];
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('emits one parseable JSON object per line', () => {
    new JsonLogger('json').event('info', 'request', { method: 'GET', status: 200 });
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]);
    expect(parsed).toMatchObject({ level: 'info', msg: 'request', method: 'GET', status: 200 });
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('routes warn/error to stderr so runtimes classify them', () => {
    const logger = new JsonLogger('json');
    logger.event('error', 'request_failed', {});
    expect((process.stderr.write as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
    expect((process.stdout.write as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it('survives circular structures instead of throwing inside a log call', () => {
    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;
    expect(() => new JsonLogger('json').event('info', 'weird', { circular })).not.toThrow();
    expect(written[0]).toContain('[Circular]');
  });

  it('pretty mode stays human-readable for local dev', () => {
    new JsonLogger('pretty').event('info', 'request', { status: 200 });
    expect(written[0]).toContain('INFO');
    expect(written[0]).toContain('request');
    expect(() => JSON.parse(written[0])).toThrow();
  });
});
