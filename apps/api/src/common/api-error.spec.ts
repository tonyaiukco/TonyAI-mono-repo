import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import {
  API_ERROR_PARAMS,
  API_ERROR_STATUS,
  DOMAIN_ERROR_STATUS,
  type ApiErrorCode,
  type DomainErrorCode,
} from '@tonyai/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActivityTypeSlotConflictError,
  CreateRoleRefusedError,
  DuplicateActivityRecordError,
  EvidenceRequiredError,
  PeriodLockedError,
  RecordChangedError,
  SelfApprovalRefusedError,
  SnapshotImmutableError,
  SubmitAuthorRefusedError,
  SubmitRoleRefusedError,
  VarianceReasonRequiredError,
} from '../activity-records/errors';
import { UpdatePreferencesDto } from '../auth/dto/update-preferences.dto';
import { HttpExceptionFilter } from '../observability/http-exception.filter';
import { UploadExpiredError } from '../storage/storage-intents.service';
import { errorBody, errorCodeOf, ResourceNotFoundError, toErrorBody } from './api-error';
import { CodedValidationPipe, GLOBAL_VALIDATION_OPTIONS } from './coded-validation.pipe';
import { ParseUuidParamPipe } from './parse-uuid-param.pipe';

vi.mock('../observability/sentry', () => ({ captureException: vi.fn() }));
afterEach(() => vi.clearAllMocks());

/** What the filter sends for `exception`, and what it logged. */
function send(exception: unknown) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', url: '/api/v1/activity-records' }),
      getResponse: () => ({ status, headersSent: false }),
    }),
  };
  const logger = { event: vi.fn() };
  new HttpExceptionFilter(logger as never).catch(exception, host as never);
  return {
    status: status.mock.calls[0][0] as number,
    body: json.mock.calls[0][0] as Record<string, unknown>,
    logged: JSON.stringify(logger.event.mock.calls),
  };
}

const PERIOD = { periodValue: 'March', reportingYear: 2025 };

/**
 * One thrower per domain code — the registry must not hold a code nothing
 * answers with (a catalogue entry nobody can see), and every thrower must
 * answer with its code's status.
 */
const THROWERS: Record<DomainErrorCode, () => HttpException> = {
  invalid_id: () => {
    try {
      new ParseUuidParamPipe().transform('nope');
    } catch (e) {
      return e as HttpException;
    }
    throw new Error('the pipe accepted a non-UUID');
  },
  evidence_required: () => new EvidenceRequiredError('Electricity'),
  variance_reason_required: () => new VarianceReasonRequiredError(),
  record_create_forbidden: () => new CreateRoleRefusedError(),
  record_submit_forbidden: () => new SubmitRoleRefusedError(),
  record_author_forbidden: () => new SubmitAuthorRefusedError(false),
  self_approval_forbidden: () => new SelfApprovalRefusedError(),
  subsidiary_not_found: () => new ResourceNotFoundError('subsidiary_not_found'),
  location_not_found: () => new ResourceNotFoundError('location_not_found'),
  record_not_found: () => new ResourceNotFoundError('record_not_found'),
  evidence_not_found: () => new ResourceNotFoundError('evidence_not_found'),
  evidence_content_missing: () => new NotFoundException(errorBody('evidence_content_missing', 'gone')),
  period_lock_not_found: () => new ResourceNotFoundError('period_lock_not_found'),
  user_not_found: () => new ResourceNotFoundError('user_not_found'),
  access_grant_not_found: () => new ResourceNotFoundError('access_grant_not_found'),
  record_duplicate: () => new DuplicateActivityRecordError(),
  period_locked: () => new PeriodLockedError('Reporting period March 2025 is locked.', PERIOD),
  record_changed: () => new RecordChangedError(),
  slot_holds_untyped: () => new ActivityTypeSlotConflictError(true),
  slot_holds_typed: () => new ActivityTypeSlotConflictError(false),
  snapshot_immutable: () => new SnapshotImmutableError(),
  upload_expired: () => new UploadExpiredError(),
};

describe('every domain code, as the client receives it', () => {
  it('has a thrower — no registry code goes unused', () => {
    expect(Object.keys(THROWERS).sort()).toEqual(Object.keys(DOMAIN_ERROR_STATUS).sort());
  });

  it.each(Object.entries(THROWERS))('%s: its status, its code, exactly its declared params', (code, make) => {
    const exception = make();
    const { status, body } = send(exception);
    expect(status).toBe(API_ERROR_STATUS[code as ApiErrorCode]);
    expect(body.code).toBe(code);
    expect(body.statusCode).toBe(status);
    expect(typeof body.message).toBe('string');
    expect(Object.keys((body.params as object | undefined) ?? {}).sort()).toEqual(
      [...(API_ERROR_PARAMS[code as ApiErrorCode] ?? [])].sort(),
    );
    expect(errorCodeOf(exception)).toBe(code);
  });

  it('keeps each class the Nest exception it extends (instanceof readers, toThrow(message) specs)', () => {
    expect(new RecordChangedError()).toBeInstanceOf(ConflictException);
    expect(new SelfApprovalRefusedError()).toBeInstanceOf(ForbiddenException);
    expect(new EvidenceRequiredError('Electricity')).toBeInstanceOf(BadRequestException);
    expect(new ResourceNotFoundError('record_not_found')).toBeInstanceOf(NotFoundException);
    expect(new ResourceNotFoundError('record_not_found').message).toBe('Activity record not found');
    expect(new SubmitAuthorRefusedError(true).message).toMatch(/resubmit/);
  });

  it('carries canonical params — period and year as stored, category as stored', () => {
    expect(send(new PeriodLockedError('x', PERIOD)).body.params).toEqual({ period: 'March', year: 2025 });
    expect(send(new EvidenceRequiredError('Natural Gas')).body.params).toEqual({ category: 'Natural Gas' });
  });
});

describe('a not-found answer says what kind of thing, never why', () => {
  it('is the same body every time — nothing of the request or the row in it', () => {
    const first = send(new ResourceNotFoundError('record_not_found')).body;
    const second = send(new ResourceNotFoundError('record_not_found')).body;
    expect(first).toEqual(second);
    expect(first).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Activity record not found',
      code: 'record_not_found',
    });
  });

  it('keeps the sentences the routes always answered with', () => {
    expect(send(new ResourceNotFoundError('subsidiary_not_found')).body.message).toBe('Subsidiary not found');
    expect(send(new ResourceNotFoundError('location_not_found')).body.message).toBe('Location not found');
    expect(send(new ResourceNotFoundError('access_grant_not_found')).body.message).toBe('Grant not found');
  });
});

describe('the filter codes what arrives uncoded', () => {
  it.each([
    [new BadRequestException('nope'), 400, 'bad_request'],
    [new UnauthorizedException('Invalid or expired token'), 401, 'unauthorized'],
    [new ForbiddenException('Only a super_admin may read the audit trail'), 403, 'forbidden'],
    [new NotFoundException('Target not found'), 404, 'not_found'],
    [new ConflictException('This reporting period is already locked.'), 409, 'conflict'],
    [new ThrottlerException(), 429, 'rate_limited'],
    [new HttpException('Gone', 410), 410, 'bad_request'],
  ] as const)('%s → %i %s, its message kept', (exception, status, code) => {
    const { status: sent, body } = send(exception);
    expect(sent).toBe(status);
    expect(body.code).toBe(code);
    expect(body.message).toBe((exception as Error).message);
  });

  it("an oversized body from body-parser is a 413 'payload_too_large'", () => {
    const err = Object.assign(new Error('request entity too large'), { type: 'entity.too.large' });
    const { status, body } = send(err);
    expect(status).toBe(413);
    expect(body.code).toBe('payload_too_large');
    expect(body.message).toMatch(/smaller batches/);
  });

  it('keeps a calculation refusal whole — its code and its coverage', () => {
    const coverage = { category: 'Fuel', activityType: 'diesel', geographyCode: 'GB', reportingYear: 2019, unit: 'litres' };
    const body = toErrorBody(404, { statusCode: 404, message: 'No factor', code: 'no_factor', coverage });
    expect(body).toMatchObject({ code: 'no_factor', coverage });
  });
});

describe('what an error body can never carry', () => {
  it('a 5xx cause — InternalServerErrorException text is replaced, and logged instead', () => {
    const { status, body, logged } = send(
      new InternalServerErrorException('Failed to store file: name resolution failed for storage.internal'),
    );
    expect(status).toBe(500);
    expect(body).toEqual({
      statusCode: 500,
      code: 'internal_error',
      message: 'Internal server error',
      error: 'Internal Server Error',
    });
    expect(logged).toContain('name resolution failed');
  });

  it('a 5xx that names a 4xx code still answers internal_error, with its own status text', () => {
    expect(send(new HttpException({ code: 'record_changed', message: 'secret detail' }, 503)).body).toEqual({
      statusCode: 503,
      code: 'internal_error',
      message: 'Internal server error',
      error: 'Service Unavailable',
    });
  });

  it('a status with no text of ours keeps the one it was thrown with', () => {
    expect(toErrorBody(410, { message: 'x', error: 'Gone' })).toMatchObject({ code: 'bad_request', error: 'Gone' });
  });

  it('a code it does not answer with — status, code and error text always agree', () => {
    expect(toErrorBody(400, { message: 'x', code: 'record_changed', error: 'Conflict' })).toMatchObject({
      statusCode: 400,
      code: 'bad_request',
      error: 'Bad Request',
    });
    expect(toErrorBody(404, { message: 'x', code: 'record_not_found' }).code).toBe('record_not_found');
  });

  it('a code outside the registry, or a prototype key', () => {
    expect(toErrorBody(409, { message: 'x', code: 'made_up' }).code).toBe('conflict');
    expect(toErrorBody(409, { message: 'x', code: 'constructor' }).code).toBe('conflict');
    expect(toErrorBody(409, { message: 'x', code: '__proto__' }).code).toBe('conflict');
  });

  it('params that are not plain strings or finite numbers, or keyed oddly', () => {
    const body = toErrorBody(409, {
      message: 'x',
      code: 'period_locked',
      params: {
        period: 'March',
        year: 2025,
        nested: { leak: 'B' },
        list: ['a'],
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        flag: true,
        'bad key': 'x',
      },
    });
    expect(body.params).toEqual({ period: 'March', year: 2025 });
    // An own `__proto__` key, as JSON.parse makes one (an object literal would not).
    const proto = toErrorBody(409, JSON.parse('{"message":"x","params":{"__proto__":"x","constructor":"y","period":"May"}}'));
    // A conflict without its own code declares no params, so none survive.
    expect(proto.params).toBeUndefined();
    const locked = toErrorBody(
      409,
      JSON.parse('{"message":"x","code":"period_locked","params":{"__proto__":"x","constructor":"y","period":"May","year":2025}}'),
    );
    expect(locked.params).toEqual({ period: 'May', year: 2025 });
    expect(Object.getPrototypeOf(locked.params)).toBe(Object.prototype);
    expect(toErrorBody(409, { message: 'x', params: ['a'] }).params).toBeUndefined();
  });

  it('a param the code does not declare — an id or caller text cannot ride along (independent review P3-2)', () => {
    const body = toErrorBody(409, {
      message: 'x',
      code: 'period_locked',
      params: { period: 'March', year: 2025, recordId: '3e84c2a0-0000-4000-8000-000000000000', category: '<img src=x>' },
    });
    expect(body.params).toEqual({ period: 'March', year: 2025 });
  });

  it("no params at all once a code is downgraded to its status's generic one", () => {
    const body = toErrorBody(400, { message: 'x', code: 'period_locked', params: { period: 'March', year: 2025 } });
    expect(body.code).toBe('bad_request');
    expect(body.params).toBeUndefined();
    expect(toErrorBody(409, { message: 'x', params: 'a' }).params).toBeUndefined();
  });

  it('a message that is not a sentence or a list of them', () => {
    expect(toErrorBody(400, { message: { nested: true } }).message).toBe('Bad Request');
    expect(toErrorBody(400, { message: ['ok', 3] }).message).toBe('Bad Request');
  });

  it('a statusCode other than the one sent', () => {
    expect(toErrorBody(404, { statusCode: 200, message: 'x' }).statusCode).toBe(404);
  });
});

describe('CodedValidationPipe', () => {
  const pipe = new CodedValidationPipe(GLOBAL_VALIDATION_OPTIONS);
  const meta = { type: 'body' as const, metatype: UpdatePreferencesDto };

  async function refusal(value: unknown) {
    try {
      await pipe.transform(value, meta);
    } catch (e) {
      return send(e).body;
    }
    throw new Error('the pipe accepted it');
  }

  it('answers a refused DTO with validation_failed and Nest\'s list of sentences', async () => {
    const body = await refusal({ language: 'de' });
    expect(body.code).toBe('validation_failed');
    expect(body.statusCode).toBe(400);
    expect(Array.isArray(body.message)).toBe(true);
    expect((body.message as string[]).join(' ')).toMatch(/language/);
  });

  it('refuses a field the DTO does not declare', async () => {
    const body = await refusal({ language: 'tr', theme: 'dark' });
    expect(body.code).toBe('validation_failed');
    expect((body.message as string[]).join(' ')).toMatch(/theme should not exist/);
  });

  it('accepts a supported locale', async () => {
    await expect(pipe.transform({ language: 'tr' }, meta)).resolves.toMatchObject({ language: 'tr' });
  });
});
