/**
 * Browser-side Sentry init. Opt-in: without NEXT_PUBLIC_SENTRY_DSN this is a
 * no-op — and because NEXT_PUBLIC_* is inlined at build time, the dynamic
 * import below is statically unreachable then, so the heavy @sentry/nextjs
 * graph is neither bundled for the client nor compiled by the dev server.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

const sentryReady = dsn
  ? import("@sentry/nextjs").then((Sentry) => {
      Sentry.init({
        dsn,
        environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
        tracesSampleRate: 0,
        // Compliance: no session replay, no PII — this app shows tenant emissions data.
        sendDefaultPii: false,
      });
      return Sentry;
    })
  : null;

/** Router navigation instrumentation (no-op when Sentry is not initialised). */
export function onRouterTransitionStart(href: string, navigationType: string): void {
  void sentryReady?.then((Sentry) => Sentry.captureRouterTransitionStart(href, navigationType));
}
