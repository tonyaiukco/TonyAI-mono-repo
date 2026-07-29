import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { runWithRequestContext } from './request-context';

/**
 * Establishes the per-request async context. This must be MIDDLEWARE, not an
 * interceptor: Nest subscribes to an interceptor's observable after `intercept`
 * returns, so an AsyncLocalStorage scope opened there would already be closed
 * by the time the controller runs. Middleware wraps guards, pipes, the handler
 * and filters alike.
 *
 * An inbound `x-request-id` is honoured (so a load balancer / cloud ingress
 * trace id stays stitched to our logs); otherwise we mint one. It is echoed
 * back in the response header for client-side correlation.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(
    req: { headers: Record<string, unknown>; requestId?: string },
    res: { setHeader?: (k: string, v: string) => void },
    next: () => void,
  ): void {
    const inbound = req.headers?.['x-request-id'];
    const requestId =
      typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 200
        ? inbound
        : randomUUID();

    req.requestId = requestId;
    res.setHeader?.('x-request-id', requestId);

    runWithRequestContext({ requestId }, () => next());
  }
}
