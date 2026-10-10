import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { toErrorBody } from '../common/api-error';
import { JsonLogger } from './json-logger';
import { currentRequestContext } from './request-context';
import { captureException } from './sentry';
import { CapacityError } from '../common/runtime-limits';

/**
 * The exception filter: it LOGS and REPORTS every failure, and gives every
 * error body a `code` (LP3-01, `toErrorBody` in common/api-error.ts).
 *
 * The body stays a superset of Nest's default — `statusCode`, `message` and
 * `error` keep their meaning, so readers of `body.message` keep working:
 *   - HttpException  → its own status, its response with a `code` added (its
 *     own when it carries a registered one, else the status's generic code);
 *     ValidationPipe's `message: string[]` is kept.
 *   - a 5xx of any kind → `{ statusCode, code: 'internal_error', message:
 *     'Internal server error' }`, with the real error kept server-side — an
 *     InternalServerErrorException's own text (Storage's error, say) included.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();
    request?.runtimeLease?.release();

    // A read can fail to acquire a connection after authentication succeeds.
    // Do not disguise an uncertain mutation outcome as a retryable refusal.
    if (['GET', 'HEAD'].includes(request?.method)
      && (exception as { code?: string })?.code === 'P2024') exception = new CapacityError();
    const httpError = exception instanceof HttpException ? exception : undefined;
    const parserType = typeof exception === 'object' && exception !== null
      ? (exception as { type?: string }).type : undefined;
    const abortedUpload = request?.runtimeMultipart && exception instanceof Error
      && ['Request aborted', 'Request closed'].includes(exception.message);
    const parserStatus = abortedUpload ? 400 : parserType ? ({
      'entity.parse.failed': 400, 'request.aborted': 400, 'request.size.invalid': 400,
      'encoding.unsupported': 415, 'charset.unsupported': 415, 'parameters.too.many': 413,
    } as Record<string, number>)[parserType] : undefined;
    // body-parser throws before any Nest pipe or middleware runs, so this
    // arrives as a plain Error with a `status` and no request context — and
    // without this branch it collapsed to a 500, logged at ERROR and shipped to
    // Sentry as a defect. It is a client sending too much, not a server fault,
    // and WP16 PR 3 made an oversized body a plausible LEGITIMATE request for
    // the first time (a subsidiary create carries its locations).
    const isTooLarge =
      !httpError &&
      typeof exception === 'object' &&
      exception !== null &&
      (exception as { type?: string }).type === 'entity.too.large';

    const status = httpError
      ? httpError.getStatus()
      : isTooLarge
        ? HttpStatus.PAYLOAD_TOO_LARGE
        : parserStatus ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const body = toErrorBody(
      status,
      httpError
        ? httpError.getResponse()
        : isTooLarge
          ? {
              message:
                'Request body is too large. If you are creating a subsidiary with many locations, add them in smaller batches.',
              error: 'Payload Too Large',
            }
          : parserStatus ? { message: 'Invalid request body.' } : undefined,
    );

    const ctx = currentRequestContext();
    const path = String(request?.originalUrl ?? request?.url ?? '').split('?')[0];
    const userId = (request?.user as { id?: string } | undefined)?.id;

    // 5xx and non-HTTP throws are defects; 4xx are expected business outcomes
    // (a blocked gate, a 403) and stay at warn so they don't page anyone.
    const isServerError = status >= HttpStatus.INTERNAL_SERVER_ERROR;
    this.logger.event(isServerError ? 'error' : 'warn', 'request_failed', {
      method: String(request?.method ?? ''),
      path,
      status,
      ...(userId ? { userId } : {}),
      error: exception instanceof Error ? exception.message : String(exception),
      ...(isServerError && exception instanceof Error
        ? { stack: exception.stack }
        : {}),
    });

    if (isServerError) {
      captureException(exception, { requestId: ctx?.requestId, userId, path });
    }

    // Streamed downloads (@Res) may already be mid-flight — never double-send.
    if (response?.headersSent || response?.destroyed) return;
    if (exception instanceof CapacityError) response.setHeader('Retry-After', exception.retryAfter);
    response.status(status).json(body);
  }
}
