/**
 * Sentry is OPT-IN: without `SENTRY_DSN` nothing initialises and every helper
 * below is a no-op, so the wiring ships and reviews now while the account /
 * DSN arrives later (Phase-2 decision, 2026-07-27). Nothing else in the API
 * imports @sentry/* — this is the only seam.
 *
 * The SDK is loaded LAZILY (dynamic import, only when a DSN is set) so the
 * OpenTelemetry runtime never enters the process while Sentry is disabled.
 *
 * It is also typed STRUCTURALLY, on purpose: a `typeof import('@sentry/nestjs')`
 * annotation pulled 573 Sentry/OpenTelemetry `.d.ts` files into the API's
 * TypeScript program (35% of it), which `nest start --watch` then held in
 * memory for the whole dev session. The narrow surface below is all we use.
 */
type SentryScope = {
  setTag(key: string, value: string): void;
  setUser(user: { id: string }): void;
};

type SentryApi = {
  init(options: Record<string, unknown>): void;
  withScope(callback: (scope: SentryScope) => void): void;
  captureException(error: unknown): void;
  flush(timeout: number): Promise<boolean>;
};

const dsn = process.env.SENTRY_DSN;

let sentry: SentryApi | null = null;

export async function initSentry(): Promise<void> {
  if (sentry || !dsn) return;
  const mod = (await import('@sentry/nestjs')) as unknown as SentryApi;
  mod.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    // Errors first; tune sampling when we can see real staging traffic.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    // Compliance: this is a carbon-accounting product — never ship request
    // bodies, headers or cookies, which can carry tenant data and tokens.
    sendDefaultPii: false,
    // Fetch/HTTP breadcrumbs can contain Storage object keys (file names),
    // signed URLs and tokens. Drop them before they enter any later event.
    beforeBreadcrumb: (breadcrumb: { type?: string; category?: string }) => {
      if (breadcrumb.type === 'http' || /^(http|fetch)(\.|$)/i.test(breadcrumb.category ?? '')) {
        return null;
      }
      return breadcrumb;
    },
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

/** Used only by the owner-run synthetic reporter before its process exits. */
export async function flushSentry(): Promise<boolean> {
  return sentry ? sentry.flush(5_000) : false;
}
