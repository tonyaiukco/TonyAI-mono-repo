import { HttpException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  API_ERROR_PARAMS,
  API_ERROR_STATUS,
  genericErrorCode,
  isApiErrorCode,
  type ApiErrorBody,
  type ApiErrorCode,
  type ApiErrorParams,
} from '@tonyai/shared-types';

/**
 * LP3-01: the API's half of the error-code contract (`@tonyai/shared-types`,
 * "Error codes and the error body"). A refusal a screen words on its own is
 * thrown with `errorBody(code, …)`; anything else gets its status's generic
 * code from the exception filter, so no error body leaves without a code.
 */

/** Nest's `error` field for each status a code answers with. */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function statusText(status: number): string | undefined {
  return STATUS_TEXT[status];
}

/**
 * The body of a coded refusal, for `new XxxException(errorBody(…))`. The
 * status comes from the registry, so a code cannot answer with another one.
 * `message` stays the English sentence every existing reader shows.
 */
export function errorBody(
  code: ApiErrorCode,
  message: string | string[],
  params?: ApiErrorParams,
): ApiErrorBody {
  const statusCode = API_ERROR_STATUS[code];
  return {
    statusCode,
    ...(STATUS_TEXT[statusCode] ? { error: STATUS_TEXT[statusCode] } : {}),
    message,
    code,
    ...(params ? { params } : {}),
  };
}

/** The sentence of every coded 404 — the messages these routes always used. */
const NOT_FOUND_MESSAGES = {
  subsidiary_not_found: 'Subsidiary not found',
  location_not_found: 'Location not found',
  record_not_found: 'Activity record not found',
  evidence_not_found: 'Evidence not found',
  period_lock_not_found: 'Period lock not found',
  user_not_found: 'User not found',
  access_grant_not_found: 'Grant not found',
  invitation_not_found: 'Invitation not found',
} as const satisfies Partial<Record<ApiErrorCode, string>>;
export type NotFoundCode = keyof typeof NOT_FOUND_MESSAGES;

/**
 * A 404 that names the kind of thing asked for and nothing else. Its body is a
 * function of the code alone — no params, no id — so an id of another
 * organisation and one that does not exist answer byte for byte the same
 * (tenant-isolation.int.spec.ts).
 */
export class ResourceNotFoundError extends NotFoundException {
  readonly code: NotFoundCode;

  constructor(code: NotFoundCode) {
    super(errorBody(code, NOT_FOUND_MESSAGES[code]));
    this.code = code;
  }
}

const QUERY_TOO_BROAD_MESSAGE = 'Narrow the request and try again.';

/** Construct only after authorization, using work in the caller's scope.
 * PR A supplies the refusal contract; PR B/C enable the budget checks. */
export class QueryTooBroadError extends UnprocessableEntityException {
  constructor() {
    super(errorBody('query_too_broad', QUERY_TOO_BROAD_MESSAGE));
  }
}

/**
 * Exactly the params `code` declares (`API_ERROR_PARAMS`), each a plain string
 * or finite number — never another key, so an id or caller text cannot ride
 * along, and none at all for a code that declares none (a generic code, or one
 * downgraded because its status did not match — independent review P3-2).
 */
function cleanParams(raw: unknown, code: ApiErrorCode): ApiErrorParams | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const params: Record<string, string | number> = {};
  for (const key of API_ERROR_PARAMS[code] ?? []) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) params[key] = value;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

const SERVER_ERROR_MESSAGE = 'Internal server error';

/**
 * What the exception filter sends for an HttpException's response (`raw`) at
 * `status`:
 *   - a 5xx is always the generic body — its cause (Storage's own error text,
 *     a driver message) goes to the logs and Sentry, never to the caller;
 *   - a registered `code` whose status this is is kept; anything else gets
 *     the status's generic code (a validation refusal arrives already coded
 *     by the pipe);
 *   - query_too_broad is a fixed body without params or extra fields;
 *   - every other field of an object response is kept as it was (a
 *     calculation refusal's `coverage`, a batch's `failed`); `params` keep only
 *     what the final code declares.
 */
export function toErrorBody(status: number, raw: unknown): ApiErrorBody & Record<string, unknown> {
  if (status >= 500) {
    // `internal_error` is the one code that answers every 5xx, not only 500.
    return { statusCode: status, code: 'internal_error', message: SERVER_ERROR_MESSAGE, error: STATUS_TEXT[status] ?? STATUS_TEXT[500] };
  }
  const fallbackError = STATUS_TEXT[status];
  if (typeof raw === 'string') {
    return {
      statusCode: status,
      ...(fallbackError ? { error: fallbackError } : {}),
      message: raw,
      code: genericErrorCode(status),
    };
  }
  const object = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const { params: rawParams, code: rawCode, ...rest } = object;
  const message = rest.message;
  // A code answers with its own status or not at all — a screen that keys
  // on `record_changed` must never see it on, say, a 400.
  const code: ApiErrorCode =
    isApiErrorCode(rawCode) && API_ERROR_STATUS[rawCode] === status ? rawCode : genericErrorCode(status);
  if (code === 'query_too_broad') return { ...errorBody(code, QUERY_TOO_BROAD_MESSAGE) };
  const params = cleanParams(rawParams, code);
  return {
    ...rest,
    statusCode: status,
    // `error` names the status actually sent — a code downgraded below keeps no
    // trace of the class it was thrown as (`architect` P3-2). A status we have
    // no text for keeps the one it was thrown with, through `...rest`.
    ...(fallbackError ? { error: fallbackError } : {}),
    message:
      typeof message === 'string' || (Array.isArray(message) && message.every((m) => typeof m === 'string'))
        ? (message as string | string[])
        : (fallbackError ?? 'Error'),
    code,
    ...(params ? { params } : {}),
  };
}

/** Narrowing for specs and callers that need the code of a thrown exception. */
export function errorCodeOf(e: unknown): ApiErrorCode | undefined {
  if (!(e instanceof HttpException)) return undefined;
  const raw = e.getResponse();
  if (raw === null || typeof raw !== 'object') return undefined;
  const code = (raw as { code?: unknown }).code;
  return isApiErrorCode(code) ? code : undefined;
}
