/**
 * Sentry is OPT-IN: without `SENTRY_DSN` nothing initialises and every helper
 * below is a no-op, so the wiring ships and reviews now while the account /
 * DSN arrives later (Phase-2 decision, 2026-07-27). Nothing else in the API
 * imports @sentry/* — this is the only seam.
 *
 * @sentry/nestjs is imported LAZILY and only when a DSN is set: requiring it
 * pulls the whole OpenTelemetry graph into the process, which costs real
 * memory in dev watch mode for zero benefit while Sentry is disabled.
 */
const dsn = process.env.SENTRY_DSN;

let sentry: typeof import('@sentry/nestjs') | null = null;

export async function initSentry(): Promise<void> {
  if (sentry || !dsn) return;
  const mod = await import('@sentry/nestjs');
  mod.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    // Errors first; tune sampling when we can see real staging traffic.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    // Compliance: this is a carbon-accounting product — never ship request
    // bodies, headers or cookies, which can carry tenant data and tokens.
    sendDefaultPii: false,
  });
  sentry = mod;
}

export function isSentryEnabled(): boolean {
  return sentry !== null;
}

/** Report an unexpected error; a no-op until a DSN is configured. */
export function captureException(
  error: unknown,
  context?: { requestId?: string; userId?: string; path?: string },
): void {
  if (!sentry) return;
  const mod = sentry;
  mod.withScope((scope) => {
    if (context?.requestId) scope.setTag('requestId', context.requestId);
    if (context?.path) scope.setTag('path', context.path);
    // Only the opaque user id — no email or tenant payload.
    if (context?.userId) scope.setUser({ id: context.userId });
    mod.captureException(error);
  });
}
