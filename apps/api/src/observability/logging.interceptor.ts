import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { RequestUser } from '../auth/auth.types';
import { JsonLogger } from './json-logger';
import { currentRequestContext } from './request-context';

/** Health checks fire every 30s per container — logging them is pure noise. */
const SILENT_PATHS = new Set(['/api/v1/health', '/api/v1/health/ready']);

/**
 * One structured line per completed request: method, path, status, duration and
 * user. The request id comes from RequestContextMiddleware (via
 * AsyncLocalStorage), which also sets the response header.
 *
 * Failures are NOT logged here — HttpExceptionFilter owns them, because only it
 * knows the mapped status code and the error itself.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: JsonLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    const method = String(request.method ?? '');
    const path = String(request.originalUrl ?? request.url ?? '');
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          if (SILENT_PATHS.has(path.split('?')[0])) return;
          const ctx = currentRequestContext();
          // The guard ran before us, so request.user is populated on
          // authenticated routes; record it on the context too so any log line
          // emitted later in this request carries the user.
          const user = (request as { user?: RequestUser }).user;
          if (ctx && user?.id) ctx.userId = user.id;

          this.logger.event('info', 'request', {
            method,
            path,
            status: Number(response?.statusCode ?? 200),
            durationMs: Date.now() - startedAt,
            ...(user?.id ? { userId: user.id } : {}),
          });
        },
        error: () => undefined,
      }),
    );
  }
}
