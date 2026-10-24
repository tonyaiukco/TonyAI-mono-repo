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
 * Query parameters a request log line keeps by name only (LP4-05 PR C). The
 * record search is a caller's free text — it may name a person or a supplier
 * the log has no business holding. The cursor carries an unkeyed digest of the
 * request's filters, search included, so a logged cursor would let anyone
 * with the log test candidate words against it (`security-rls` P2-2).
 */
const FREE_TEXT_PARAMS = new Set(['search', 'cursor']);

/** The request path as logged: the query kept, free-text values redacted. */
export function loggablePath(url: string): string {
  const at = url.indexOf('?');
  if (at < 0) return url;
  const query = new URLSearchParams(url.slice(at + 1));
  let redacted = false;
  for (const key of new Set(query.keys())) {
    if (!FREE_TEXT_PARAMS.has(key)) continue;
    query.set(key, '[redacted]');
    redacted = true;
  }
  return redacted ? `${url.slice(0, at)}?${query.toString()}` : url;
}

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
    const path = loggablePath(String(request.originalUrl ?? request.url ?? ''));
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
