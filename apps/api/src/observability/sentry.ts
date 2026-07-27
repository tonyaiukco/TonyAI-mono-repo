import * as Sentry from '@sentry/nestjs';

/**
 * Sentry is OPT-IN: without `SENTRY_DSN` nothing initialises and every helper
 * below is a no-op, so the wiring ships and reviews now while the account /
 * DSN arrives later (Phase-2 decision, 2026-07-27). Nothing else in the API
 * imports @sentry/* — this is the only seam.
 */
const dsn = process.env.SENTRY_DSN;

let initialised = false;

export function initSentry(): void {
  if (initialised || !dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    // Errors first; tune sampling when we can see real staging traffic.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    // Compliance: this is a carbon-accounting product — never ship request
    // bodies, headers or cookies, which can carry tenant data and tokens.
    sendDefaultPii: false,
  });
  initialised = true;
}

export function isSentryEnabled(): boolean {
  return initialised;
}

/** Report an unexpected error; a no-op until a DSN is configured. */
export function captureException(
  error: unknown,
  context?: { requestId?: string; userId?: string; path?: string },
): void {
  if (!initialised) return;
  Sentry.withScope((scope) => {
    if (context?.requestId) scope.setTag('requestId', context.requestId);
    if (context?.path) scope.setTag('path', context.path);
    // Only the opaque user id — no email or tenant payload.
    if (context?.userId) scope.setUser({ id: context.userId });
    Sentry.captureException(error);
  });
}
