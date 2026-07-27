import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JsonLogger } from './json-logger';
import { currentRequestContext } from './request-context';
import { captureException } from './sentry';

/**
 * Observability-only exception filter: it LOGS and REPORTS, it does not reshape.
 *
 * The response body is byte-compatible with Nest's default handling, because
 * the whole frontend reads `body.message` (apps/web/lib/api.ts) and every toast
 * in the app depends on it:
 *   - HttpException  → its own status + `getResponse()` passed through verbatim
 *     (including ValidationPipe's `message: string[]`).
 *   - anything else  → 500 `{ statusCode, message: 'Internal server error' }`,
 *     the same shape Nest produces, with the real error kept server-side.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = isHttp
      ? exception.getResponse()
      : { statusCode: status, message: 'Internal server error' };

    const ctx = currentRequestContext();
    const path = String(request?.originalUrl ?? request?.url ?? '');
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
    if (response?.headersSent) return;
    response.status(status).json(body);
  }
}
