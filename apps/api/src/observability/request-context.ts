import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context carried through the async call chain, so a log line
 * written deep inside a service still reports which request produced it.
 * Populated by LoggingInterceptor; read by JsonLogger and HttpExceptionFilter.
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
