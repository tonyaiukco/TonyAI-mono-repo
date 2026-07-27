import * as Sentry from "@sentry/nextjs";

/**
 * Browser-side Sentry init. Opt-in: without NEXT_PUBLIC_SENTRY_DSN this is a
 * no-op (the SDK is never initialised, so nothing is sent and no listeners are
 * installed).
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: 0,
    // Compliance: no session replay, no PII — this app shows tenant emissions data.
    sendDefaultPii: false,
  });
}

/** Router navigation instrumentation (no-op when Sentry is not initialised). */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
